# r-open-db Design Spec

## Problem

Every new project that needs Postgres requires the same boilerplate: setting up a connection, writing CRUD queries, building a migration system. Supabase solves this but is a heavy platform with hosting, auth, dashboards, and vendor lock-in. We need a lightweight npm library that gives the Supabase developer experience (chainable query API) on top of any Postgres instance — Railway, Neon, local, or anything reachable via a connection string.

## Scope

**In scope (v1):**
- Chainable Supabase-style query client (select, insert, update, delete, upsert)
- Filter methods (eq, neq, gt, lt, gte, lte, like, ilike, in, is, order, limit, offset)
- Relation queries (select with joins via foreign key introspection)
- SQL migration runner (up/down, CLI + programmatic)
- Connection management (pooling, cleanup)

**Out of scope (v1):**
- Auth (no users, no JWT, no API keys)
- Realtime / subscriptions
- Storage / file uploads
- Admin UI / dashboard
- Row-level security
- TypeScript type generation from schema (future enhancement)

## API Design

### Client initialization

```ts
import { createClient } from 'r-open-db'

const db = createClient({
  connectionString: 'postgres://user:pass@host:5432/dbname',
})
```

Options:
- `connectionString` (required) — Postgres connection URL
- `schema` (optional, default: `'public'`) — which Postgres schema to use

### Query API

Mirrors the Supabase JS client API. Every query returns `Promise<{ data: T[] | null, error: Error | null }>`.

**Select:**
```ts
const { data, error } = await db
  .from('posts')
  .select('id, title, created_at')
  .eq('published', true)
  .order('created_at', { ascending: false })
  .limit(10)
```

**Select with relations:**
```ts
const { data } = await db
  .from('posts')
  .select('id, title, author:users(id, name)')
```

Relation syntax: `alias:table(columns)`. The library introspects foreign keys to determine join conditions.

**Insert:**
```ts
const { data, error } = await db
  .from('posts')
  .insert({ title: 'Hello', body: 'World' })
  .select() // optional: return inserted row
```

Supports single object or array for bulk insert.

**Update:**
```ts
const { data, error } = await db
  .from('posts')
  .update({ title: 'Updated' })
  .eq('id', 1)
  .select()
```

**Upsert:**
```ts
const { data, error } = await db
  .from('posts')
  .upsert({ id: 1, title: 'Upserted' })
  .select()
```

**Delete:**
```ts
const { error } = await db
  .from('posts')
  .delete()
  .eq('id', 1)
```

### Filter methods

| Method | SQL equivalent |
|--------|---------------|
| `.eq(col, val)` | `col = val` |
| `.neq(col, val)` | `col != val` |
| `.gt(col, val)` | `col > val` |
| `.gte(col, val)` | `col >= val` |
| `.lt(col, val)` | `col < val` |
| `.lte(col, val)` | `col <= val` |
| `.like(col, pattern)` | `col LIKE pattern` |
| `.ilike(col, pattern)` | `col ILIKE pattern` |
| `.in(col, values)` | `col IN (values)` |
| `.is(col, val)` | `col IS val` (for null/true/false) |
| `.order(col, opts)` | `ORDER BY col` |
| `.limit(n)` | `LIMIT n` |
| `.offset(n)` | `OFFSET n` |

All filter values are parameterized (no SQL injection).

### Connection cleanup

```ts
await db.close() // closes the connection pool
```

## Migrations

### File structure

```
migrations/
  001_create_users.up.sql
  001_create_users.down.sql
  002_add_posts.up.sql
  002_add_posts.down.sql
```

Naming: `{number}_{description}.{up|down}.sql`

### CLI

```bash
# Run all pending migrations
npx r-open-db migrate up

# Rollback the last applied migration
npx r-open-db migrate down

# Scaffold a new migration pair
npx r-open-db migrate new add_comments
# Creates: migrations/003_add_comments.up.sql
#          migrations/003_add_comments.down.sql
```

The CLI reads `DATABASE_URL` from environment or `.env` file.

### Tracking

Applied migrations are tracked in a `_r_open_db_migrations` table:

```sql
CREATE TABLE IF NOT EXISTS _r_open_db_migrations (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### Programmatic API

```ts
import { migrate } from 'r-open-db/migrate'

await migrate({
  connectionString: process.env.DATABASE_URL,
  direction: 'up',          // 'up' or 'down'
  migrationsDir: './migrations',
})
```

## Architecture

### Package structure

```
r-open-db/
  src/
    index.ts          — createClient, re-exports
    client.ts         — ROpenDbClient class
    query-builder.ts  — chainable query builder
    filters.ts        — filter methods (eq, gt, etc.)
    sql-builder.ts    — builds parameterized SQL from query chain
    relations.ts      — foreign key introspection, join building
    connection.ts     — postgres driver wrapper, pool management
    migrate/
      index.ts        — programmatic migration API
      runner.ts       — reads migration files, applies/rolls back
      tracker.ts      — _r_open_db_migrations table management
    cli/
      index.ts        — CLI entry point
      migrate.ts      — migrate command handler
  migrations/         — (user's migration directory, not part of package)
  tests/
    query-builder.test.ts
    filters.test.ts
    sql-builder.test.ts
    integration/
      client.test.ts
      migrate.test.ts
```

### Key design decisions

1. **No code generation** — queries are built at runtime from the chainable API. No Prisma-style generate step.
2. **Schema introspection at connect time** — on `createClient()`, the library queries `information_schema` to learn table structures and foreign keys. This enables relation queries and type-safe-ish behavior without codegen.
3. **Parameterized queries only** — all user values go through `$1, $2, ...` parameters. Never string-interpolated into SQL.
4. **`postgres` driver** — using `porsager/postgres` (the `postgres` npm package). Modern, fast, supports connection pooling, no native dependencies.
5. **Supabase-compatible API shape** — `{ data, error }` return type, same method names. Makes it easy to swap between Supabase and r-open-db.

### Error handling

All query methods return `{ data, error }` — never throw. The `error` object contains:
- `message` — human-readable error description
- `code` — Postgres error code when available
- `details` — additional context

## Tech stack

- **Runtime:** Node.js (ESM)
- **Language:** TypeScript (strict mode)
- **Postgres driver:** `postgres` (porsager/postgres)
- **Build:** tsup (bundles to ESM + CJS)
- **Testing:** vitest
- **CLI argument parsing:** built-in `parseArgs` (Node 18.3+)

## Verification

1. **Unit tests:** query builder correctly generates SQL for all operations and filters
2. **Integration tests:** run against a real Postgres (can use a test container or a free Neon/Railway instance)
   - CRUD operations work end-to-end
   - Relation queries resolve foreign keys correctly
   - Migrations apply and rollback correctly
   - Connection pooling and cleanup work
3. **Manual test:** create a sample project, connect to a Railway Postgres, run migrations, perform CRUD operations
