# r-open-db

Lightweight Supabase-style query API for any Postgres. No server, no code generation — just an npm package that gives you a clean chainable API on top of any Postgres instance.

```ts
import { createClient } from 'r-open-db'

const db = createClient({ connectionString: 'postgres://user:pass@host:5432/mydb' })

const { data } = await db.from('posts').select('*').eq('published', true).limit(10)
```

## Install

```bash
npm install r-open-db
```

## Quick Start

```ts
import { createClient } from 'r-open-db'

const db = createClient({
  connectionString: process.env.DATABASE_URL,
})

// Insert
await db.from('users').insert({ name: 'Alice', email: 'alice@example.com' })

// Select
const { data, error } = await db
  .from('users')
  .select('*')
  .eq('name', 'Alice')

// Update
await db.from('users')
  .update({ name: 'Alice Updated' })
  .eq('email', 'alice@example.com')

// Delete
await db.from('users').delete().eq('id', 1)

// Close when done
await db.close()
```

## API

### `createClient(options)`

Creates a new database client.

```ts
const db = createClient({
  connectionString: 'postgres://user:pass@host:5432/mydb',
  schema: 'public',  // optional, default: 'public'
  max: 10,           // optional, max pool connections, default: 10
})
```

### Query Methods

Every query starts with `db.from('table')` and returns `Promise<{ data: T[] | null, error: Error | null }>`.

#### Select

```ts
// All rows
const { data } = await db.from('posts').select('*')

// Specific columns
const { data } = await db.from('posts').select('id, title, created_at')
```

#### Insert

```ts
// Single row
const { data } = await db
  .from('posts')
  .insert({ title: 'Hello', body: 'World' })
  .returning()

// Multiple rows
const { data } = await db
  .from('posts')
  .insert([
    { title: 'Post 1', body: 'First' },
    { title: 'Post 2', body: 'Second' },
  ])
  .returning()
```

#### Update

```ts
const { data } = await db
  .from('posts')
  .update({ title: 'Updated Title' })
  .eq('id', 1)
  .returning()
```

#### Upsert

```ts
const { data } = await db
  .from('posts')
  .upsert(
    { id: 1, title: 'Upserted' },
    { onConflict: 'id' },  // optional, default: 'id'
  )
  .returning()
```

#### Delete

```ts
const { error } = await db
  .from('posts')
  .delete()
  .eq('id', 1)
```

### Filters

Chain filters to narrow your query. All values are parameterized — no SQL injection.

```ts
db.from('posts').select('*')
  .eq('status', 'published')       // status = 'published'
  .neq('status', 'draft')          // status != 'draft'
  .gt('views', 100)                // views > 100
  .gte('views', 100)               // views >= 100
  .lt('views', 1000)               // views < 1000
  .lte('views', 1000)              // views <= 1000
  .like('title', '%hello%')        // title LIKE '%hello%'
  .ilike('title', '%hello%')       // title ILIKE '%hello%' (case-insensitive)
  .in('id', [1, 2, 3])            // id IN (1, 2, 3)
  .is('deleted_at', null)          // deleted_at IS NULL
  .is('active', true)              // active IS TRUE
```

### Modifiers

```ts
db.from('posts').select('*')
  .order('created_at', { ascending: false })  // ORDER BY created_at DESC
  .limit(10)                                   // LIMIT 10
  .offset(20)                                  // OFFSET 20
```

Multiple filters and modifiers can be chained together:

```ts
const { data } = await db
  .from('posts')
  .select('id, title')
  .eq('published', true)
  .gt('views', 50)
  .order('created_at', { ascending: false })
  .limit(10)
```

### Returning

Use `.returning()` after `insert`, `update`, `upsert`, or `delete` to get the affected rows back (uses `RETURNING *`):

```ts
const { data } = await db
  .from('users')
  .insert({ name: 'Alice', email: 'alice@example.com' })
  .returning()

console.log(data[0].id) // auto-generated id
```

### Schema Introspection

Discover tables and foreign keys in your database:

```ts
const schema = await db.introspect()

console.log(schema.tables)
// ['users', 'posts', 'comments']

console.log(schema.foreignKeys)
// [{ fromTable: 'posts', fromColumn: 'author_id', toTable: 'users', toColumn: 'id', ... }]
```

### Raw Queries

Access the underlying `postgres` driver for anything the query builder doesn't cover:

```ts
const result = await db.raw`SELECT COUNT(*) FROM users WHERE active = ${true}`
```

### Close

```ts
await db.close()
```

## Migrations

SQL-based migrations with up/down support.

### CLI

```bash
# Create a new migration
npx r-open-db migrate new create_users
# Creates:
#   migrations/001_create_users.up.sql
#   migrations/001_create_users.down.sql

# Run all pending migrations
npx r-open-db migrate up

# Rollback the last migration
npx r-open-db migrate down
```

The CLI reads `DATABASE_URL` from the environment or a `.env` file.

Set `MIGRATIONS_DIR` to change the migrations directory (default: `./migrations`).

### Migration Files

Write plain SQL in each file:

```sql
-- migrations/001_create_users.up.sql
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

```sql
-- migrations/001_create_users.down.sql
DROP TABLE IF EXISTS users;
```

File naming: `{number}_{description}.up.sql` / `{number}_{description}.down.sql`

### Programmatic API

```ts
import { migrate } from 'r-open-db/migrate'

// Apply all pending
await migrate({
  connectionString: process.env.DATABASE_URL,
  direction: 'up',
  migrationsDir: './migrations',  // optional, default: './migrations'
})

// Rollback last
await migrate({
  connectionString: process.env.DATABASE_URL,
  direction: 'down',
})
```

Applied migrations are tracked in a `_r_open_db_migrations` table created automatically in your database.

## Error Handling

All queries return `{ data, error }` — they never throw:

```ts
const { data, error } = await db.from('nonexistent').select('*')

if (error) {
  console.error(error.message) // relation "public.nonexistent" does not exist
}
```

## Example

A complete example using r-open-db with a Railway/Neon/local Postgres:

```ts
import { createClient } from 'r-open-db'
import { migrate } from 'r-open-db/migrate'

// 1. Run migrations
await migrate({
  connectionString: process.env.DATABASE_URL,
  direction: 'up',
})

// 2. Connect
const db = createClient({
  connectionString: process.env.DATABASE_URL,
})

// 3. Use it
await db.from('users').insert({ name: 'Alice', email: 'alice@example.com' })

const { data: users } = await db
  .from('users')
  .select('*')
  .ilike('name', '%alice%')
  .order('created_at', { ascending: false })
  .limit(10)

console.log(users)

// 4. Cleanup
await db.close()
```

## License

MIT
