# Relations Wiring Design Spec

Date: 2026-04-25
Status: Approved (pending implementation)
Supersedes the relation portion of: `docs/superpowers/specs/2026-04-14-r-open-db-design.md`

## Problem

The original design spec and `README.md` advertise relation queries:

```ts
db.from('posts').select('id, title, author:users(id, name)')
```

The parsing helpers (`parseSelectColumns`) and a flat-JOIN SQL generator (`buildRelationSelect`) exist in `src/relations.ts` and are unit-tested, but `QueryBuilder.select()` in `src/query-builder.ts` never calls them. The advertised feature does not work end-to-end. In addition, the existing `buildRelationSelect()` is incorrect for one-to-many relations (its flat `LEFT JOIN` with aliased columns produces a Cartesian-product row explosion when the relation is "many"), and it silently picks the first matching foreign key when more than one exists between the two tables.

This spec defines the v1 implementation that ships the feature for real.

## Scope

**In scope (v1):**

- `QueryBuilder.select()` parses relation syntax and emits a single SQL query that returns nested objects/arrays directly.
- Both cardinalities supported: many-to-one returns a nested object (or `null`); one-to-many returns a nested array (or `[]`).
- Disambiguation hint `alias:table!fkcol(cols)` for tables that share more than one foreign key.
- `*` inside a relation expands to all columns of the related table.
- Schema introspection is acquired lazily on first relation query; non-relation queries pay no cost.
- All relation errors surface via the existing `{ data: null, error }` contract — nothing throws past `execute()`.

**Out of scope (deferred):**

- Filtering, ordering, or limiting *inside* a relation segment.
- Nested-of-nested relations (depth > 1) — rejected at parse time with a clear error.
- Type-level inference of the result shape from the select string.
- Schema-cache invalidation / `client.refreshSchema()` — separate Phase 3 item.
- Composite foreign keys — rejected with a clear error.

## API

`createClient()` stays synchronous. `QueryBuilder<T>` stays generic on a user-supplied `T`; the user is responsible for typing nested relations. No public method signature changes.

### Many-to-one example

```ts
const { data } = await db
  .from('posts')
  .select('id, title, author:users!author_id(id, name)')
  .eq('published', true)

// data: [ { id: 1, title: '…', author: { id: 7, name: 'Ada' } }, … ]
```

When no `!fkcol` hint is given and exactly one foreign key links the two tables, the hint is optional.

### One-to-many example

```ts
const { data } = await db
  .from('users')
  .select('id, name, posts:posts(id, title)')

// data: [ { id: 7, name: 'Ada', posts: [ { id:1, title:'…' }, … ] }, … ]
```

### Star expansion

```ts
db.from('posts').select('id, author:users(*)')
// expands to all columns of users
```

### Disambiguation

If `posts` has both `author_id` and `editor_id` referencing `users`:

```ts
db.from('posts').select('id, author:users!author_id(id, name)')
db.from('posts').select('id, editor:users!editor_id(id, name)')
```

Without the hint, the query returns `{ data: null, error: <Ambiguous relation…> }` (see Errors).

## Syntax

Top-level grammar for one relation segment:

```
alias ":" table ( "!" fkcol )? "(" cols ")"
```

- `alias` — JS identifier; becomes the property name on the parent.
- `table` — name of the related table (in the same schema).
- `fkcol` — optional foreign-key *column name* on the side that owns the FK.
- `cols` — comma-separated column names, or a single `*`.

Nesting is forbidden: `cols` may not contain `:` or `(`. The parser rejects nested-of-nested with the error `Nested relation in '<segment>' not supported in v1`.

Updated regex in `parseSelectColumns()`:

```
/^(\w+):(\w+)(?:!(\w+))?\((.+)\)$/
```

`ParsedRelation` gains an optional `fkColumn?: string`.

## Schema cache plumbing

`ROpenDbClient.from(table)` passes a `getSchema` callback into the `QueryBuilder` constructor:

```ts
new QueryBuilder<T>(this.sql, table, this.schema, () => this.introspect())
```

`QueryBuilder.execute()` performs a cheap detection on `state.columns` (presence of `:` followed by `(`) and, if relations are present, `await getSchema()` before calling `buildQuery()`. Non-relation queries skip the call entirely and pay no overhead.

`introspectSchema()` is extended: in addition to `tables` and `foreignKeys`, the returned `SchemaCache` carries `columns: Record<string, string[]>` — a per-table column list — so that `*` inside a relation can be expanded. The query is added to the existing `information_schema` introspection round-trip; no extra trips.

The cache remains connection-lifetime. Invalidation is out of scope (Phase 3).

## SQL strategy — JSON aggregation via LATERAL

For each relation segment, the SQL builder emits one `LEFT JOIN LATERAL (SELECT …) sub ON true` clause whose subquery produces one JSON-typed column. The Postgres driver (`postgres`/porsager) decodes `json`/`jsonb` results into JS values automatically — no application-side stitching.

### Many-to-one

The FK lives on the local table, pointing into the related table.

```sql
LEFT JOIN LATERAL (
  SELECT json_build_object('id', "users"."id", 'name', "users"."name") AS data
  FROM "public"."users" AS "users"
  WHERE "users"."id" = "posts"."author_id"
  LIMIT 1
) AS "author" ON true
```

Selected as `"author"."data" AS "author"`. Missing match → `NULL`.

### One-to-many

The FK lives on the related table, pointing into the local table.

```sql
LEFT JOIN LATERAL (
  SELECT coalesce(
    json_agg(json_build_object('id', "posts"."id", 'title', "posts"."title")),
    '[]'::json
  ) AS data
  FROM "public"."posts" AS "posts"
  WHERE "posts"."author_id" = "users"."id"
) AS "posts" ON true
```

Selected as `"posts"."data" AS "posts"`. Empty match → `[]`.

### Cardinality decision

For each relation segment, the builder consults the schema cache:

1. Filter `foreignKeys` to those linking the local and related tables (in either direction).
2. If a `!fkcol` hint is present, narrow to the FK whose owning side's column matches `fkcol`.
3. After filtering, exactly one FK must remain — otherwise an error (see below).
4. If the surviving FK's `fromTable` equals the local table → many-to-one. Otherwise → one-to-many.

### Composite foreign keys

If the surviving FK record represents a multi-column key (detected by multiple rows sharing a `constraintName` for the same pair), the builder rejects the relation with `Composite foreign keys not supported in v1`. (Implementation note: `introspectSchema` may need to group rows by `constraintName`.)

## Errors

All thrown by the SQL builder; all caught in `QueryBuilder.execute()` and surfaced as `{ data: null, error }`.

| Condition | Error message |
|---|---|
| No FK between the two tables | `No foreign key found between "<local>" and "<related>"` |
| Multiple FKs, no hint | `Ambiguous relation between "<local>" and "<related>" — multiple foreign keys exist (<col>, <col>). Use alias:table!<fk_column>(...) to disambiguate.` |
| Hint provided, no matching FK | `No foreign key on column "<fkcol>" between "<local>" and "<related>"` |
| Composite FK | `Composite foreign keys not supported in v1` |
| Nested-of-nested at parse time | `Nested relation in '<segment>' not supported in v1` |
| `*` inside relation but related table not in cache | `Unknown table "<related>" — schema cache miss` |

## Files touched

- `src/relations.ts` — extend `parseSelectColumns()` regex and `ParsedRelation` type; rewrite `buildRelationSelect()` to emit LATERAL JSON SQL; extend `introspectSchema()` to fetch per-table columns; add cardinality + ambiguity logic.
- `src/query-builder.ts` — accept `getSchema` callback in constructor; in `execute()`, detect relation syntax and `await` the schema before building.
- `src/client.ts` — pass `() => this.introspect()` to `QueryBuilder` constructor in `from()`.
- `src/sql-builder.ts` — branch in the SELECT path: when relations are present, delegate to the relation SQL builder for the SELECT/JOIN portion; filters/order/limit/offset still apply to the outer query as today.
- `src/index.ts` — no surface change.
- `tests/relations.test.ts` — replace existing assertions to cover the new SQL shape, the `!fkcol` hint, and all error cases.
- `tests/integration/client.test.ts` — add seeded fixtures (`users` with `author_id` and `editor_id`, `posts`) and assertions for both cardinalities, `*` expansion, disambiguation, empty-children → `[]`, missing-parent → `null`.

## Test plan

**Unit (`tests/relations.test.ts`):**

- Parser accepts `alias:table(cols)` and `alias:table!fkcol(cols)`; rejects nested-of-nested with the exact error string.
- SQL builder emits the expected `LEFT JOIN LATERAL … json_build_object … LIMIT 1` for many-to-one.
- SQL builder emits the expected `LEFT JOIN LATERAL … coalesce(json_agg(json_build_object(...)), '[]'::json)` for one-to-many.
- `*` expands to the column list from the schema cache.
- Ambiguous FK without hint → exact error string.
- No FK between tables → exact error string.
- Hint references a nonexistent FK column → exact error string.
- Composite FK → exact error string.

**Integration (`tests/integration/client.test.ts`):**

- Seed `users(id, name)` and `posts(id, title, author_id → users.id, editor_id → users.id)`.
- `posts.select('id, title, author:users!author_id(id, name)')` returns nested `author` object.
- `users.select('id, name, posts:posts!author_id(id, title)')` returns nested `posts` array.
- `posts.select('id, author:users(*)')` returns all `users` columns nested.
- Empty children → `posts: []`.
- Missing parent (NULL FK) → `author: null`.
- Without `!fkcol` on the ambiguous pair, the query returns `{ data: null, error }` with the documented message.

## Verification

1. `npm test` passes (unit + integration).
2. `npx tsc --noEmit` clean.
3. README example (`select('id, title, author:users(id, name)')`) executes without error against the integration test schema.
4. Non-relation `select` queries pass without invoking the schema cache (verified by spying on `introspect()` in a unit test).
