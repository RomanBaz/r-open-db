# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`r-open-db` is a TypeScript library that provides a Supabase-style chainable query API on top of any Postgres database, plus a SQL-file-based migration runner and CLI. It is intended for npm — there is no application here. The driver underneath is `postgres` (porsager/postgres).

The library is **not yet published to the npm registry.** Consumers currently install it from GitHub (`"r-open-db": "github:RomanBaz/r-open-db"`). The `prepare` script in `package.json` runs `npm run build` if `dist/` is missing, which lets the GitHub install work cleanly. Switch consumers to `^0.x.y` once published.

The full design intent lives in `docs/superpowers/specs/2026-04-14-r-open-db-design.md`. Read it before making non-trivial API decisions.

## Commands

```bash
npm test                                   # full suite (unit + integration)
npx vitest run tests/sql-builder.test.ts   # one file
npx vitest run -t 'eq filter'              # one test by name pattern
npx vitest                                 # watch mode
npm run build                              # tsup → dist/ (ESM + CJS + .d.ts + CLI shebang)
npx tsc --noEmit                           # typecheck only
```

There is no lint/format tool wired up yet, and no CI. `npm test` is the gate.

## Integration tests need a real Postgres

Integration tests under `tests/integration/` connect to a live database hardcoded as:

```
postgres://truclean:truclean@localhost:5432/r_open_db_test
```

If that DB isn't reachable, those tests will fail — they do not mock the driver, by design. Unit tests under `tests/*.test.ts` (no `integration/`) are pure and need no DB.

## Architecture (the parts that span multiple files)

### Query pipeline

`createClient()` (`src/index.ts`) → `ROpenDbClient` (`src/client.ts`) → `client.from(table)` returns a fresh `QueryBuilder<T>` (`src/query-builder.ts`). The builder accumulates state (operation kind, columns, filters, order, limit/offset, returning flag, payload for insert/update/upsert) via chainable methods that all `return this`. Execution is triggered by `await`-ing the builder, which calls a terminal `execute()` that hands the accumulated state to `buildSql()` in `src/sql-builder.ts`.

`sql-builder.ts` is the **only** place that produces SQL text. It generates `$N` placeholders and a parallel `params` array; `query-builder.ts` then runs it via `postgres.unsafe(sql, params)`. Every public surface that takes user input must reach the database through this path.

### SQL safety contract (non-negotiable)

- **Values** → always `$N` placeholders, pushed into `params` in order. Never templated into the SQL string.
- **Identifiers** (table, column, schema names) → always go through `quoteIdent()` in `src/filters.ts`, which double-quotes and escapes embedded `"`. Watch for code paths that bypass this (e.g. `ORDER BY`, relation joins).
- **Numbers** (`LIMIT`, `OFFSET`) → typed as `number` at the public API boundary; safe to interpolate only because TypeScript enforces the type. If a string could leak in, that's a bug.

If a change reaches for string concatenation of SQL, it's wrong — re-route through the parameterizer.

### Relations

`src/relations.ts` introspects `information_schema` (foreign keys, columns), parses the Supabase-style `'id, author:users(id, name)'` select string with `parseSelectColumns()`, and builds the join SQL with `buildRelationSelect()`.

`QueryBuilder.select()` checks for relation syntax via `hasRelationSyntax()` and routes through `buildRelationSelect` in `sql-builder.ts` when it sees one. Schema introspection is lazy (first relation query) and cached on the client.

Limits in v1 (enforced — return errors, not silent corruption):
- Composite foreign keys are unsupported
- Nested relations (relation inside a relation) are unsupported
- Ambiguous relations (multiple FKs between same pair of tables) require `alias:table!fk_column(...)` to disambiguate

### Migrations

Three files under `src/migrate/`: `runner.ts` discovers `NNN_name.{up,down}.sql` files, `tracker.ts` owns the `_r_open_db_migrations` table (`id, name, applied_at`), `index.ts` is the public surface (`migrate`, `migrateUp`, `migrateDown`, `ensureMigrationsTable`, `getAppliedMigrations`, `discoverMigrations`).

Current limitations to keep in mind when changing this code: migrations do **not** run inside a transaction, there is **no advisory lock** preventing two runners from racing, and a missing `.down.sql` surfaces as an unhandled `ENOENT`. Treat these as known gaps when reviewing or extending.

### CLI

`src/cli/index.ts` is the `r-open-db` binary entrypoint (ESM, shebang added by tsup). It reads `DATABASE_URL` (and optional `MIGRATIONS_DIR`) from env or a hand-parsed `.env`, then dispatches `migrate up|down|new`. There is no third-party arg parser.

### Build & package shape

`tsup.config.ts` defines three entries: `src/index.ts` and `src/migrate/index.ts` build dual ESM/CJS with `.d.ts`, while `src/cli/index.ts` builds ESM-only with a shebang banner. `package.json` `exports` map exposes the root and `./migrate` subpath; the `bin` field points at `dist/cli/index.js`. Only `dist/` ships to npm (`files: ["dist"]`).

Internal imports use `.js` extensions even in `.ts` source — that's intentional for ESM/NodeNext resolution. Don't strip them.

### Public API contract

Every query method returns `Promise<{ data: T[] | null, error: Error | null }>` and **does not throw** on database errors. The error is captured in `execute()` and returned. Preserve this shape in any new query method — throwing breaks the documented contract.
