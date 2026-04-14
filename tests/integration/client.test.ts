import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient } from '../../src/index.js'
import type { ROpenDbClient } from '../../src/client.js'

const CONNECTION_STRING = 'postgres://truclean:truclean@localhost:5432/r_open_db_test'

let db: ROpenDbClient

beforeAll(async () => {
  db = createClient({ connectionString: CONNECTION_STRING })

  // Create test tables
  await db.raw`DROP TABLE IF EXISTS posts CASCADE`
  await db.raw`DROP TABLE IF EXISTS users CASCADE`
  await db.raw`
    CREATE TABLE users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `
  await db.raw`
    CREATE TABLE posts (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT,
      published BOOLEAN DEFAULT false,
      views INTEGER DEFAULT 0,
      author_id INTEGER REFERENCES users(id),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `
})

afterAll(async () => {
  await db.raw`DROP TABLE IF EXISTS posts CASCADE`
  await db.raw`DROP TABLE IF EXISTS users CASCADE`
  await db.close()
})

describe('INSERT', () => {
  it('inserts a single row', async () => {
    const { data, error } = await db
      .from('users')
      .insert({ name: 'Alice', email: 'alice@test.com' })
      .returning()

    expect(error).toBeNull()
    expect(data).toHaveLength(1)
    expect(data![0].name).toBe('Alice')
    expect(data![0].id).toBeDefined()
  })

  it('inserts multiple rows', async () => {
    const { data, error } = await db
      .from('users')
      .insert([
        { name: 'Bob', email: 'bob@test.com' },
        { name: 'Charlie', email: 'charlie@test.com' },
      ])
      .returning()

    expect(error).toBeNull()
    expect(data).toHaveLength(2)
  })
})

describe('SELECT', () => {
  it('selects all rows', async () => {
    const { data, error } = await db.from('users').select('*')

    expect(error).toBeNull()
    expect(data!.length).toBeGreaterThanOrEqual(3)
  })

  it('selects specific columns', async () => {
    const { data } = await db.from('users').select('name, email')

    expect(data![0]).toHaveProperty('name')
    expect(data![0]).toHaveProperty('email')
  })

  it('filters with eq', async () => {
    const { data } = await db
      .from('users')
      .select('*')
      .eq('name', 'Alice')

    expect(data).toHaveLength(1)
    expect(data![0].name).toBe('Alice')
  })

  it('filters with neq', async () => {
    const { data } = await db
      .from('users')
      .select('*')
      .neq('name', 'Alice')

    expect(data!.every((u: any) => u.name !== 'Alice')).toBe(true)
  })

  it('filters with in', async () => {
    const { data } = await db
      .from('users')
      .select('*')
      .in('name', ['Alice', 'Bob'])

    expect(data).toHaveLength(2)
  })

  it('filters with like', async () => {
    const { data } = await db
      .from('users')
      .select('*')
      .like('email', '%@test.com')

    expect(data!.length).toBeGreaterThanOrEqual(3)
  })

  it('filters with ilike', async () => {
    const { data } = await db
      .from('users')
      .select('*')
      .ilike('name', '%alice%')

    expect(data).toHaveLength(1)
  })

  it('filters with is (boolean)', async () => {
    const { data } = await db
      .from('users')
      .select('*')
      .is('active', true)

    expect(data!.length).toBeGreaterThanOrEqual(3)
  })

  it('orders results', async () => {
    const { data } = await db
      .from('users')
      .select('*')
      .order('name', { ascending: true })

    const names = data!.map((u: any) => u.name)
    expect(names).toEqual([...names].sort())
  })

  it('limits results', async () => {
    const { data } = await db
      .from('users')
      .select('*')
      .limit(2)

    expect(data).toHaveLength(2)
  })

  it('offsets results', async () => {
    const { data: all } = await db.from('users').select('*').order('id')
    const { data: offset } = await db
      .from('users')
      .select('*')
      .order('id')
      .offset(1)
      .limit(1)

    expect(offset![0].id).toBe(all![1].id)
  })

  it('combines multiple filters', async () => {
    const { data } = await db
      .from('users')
      .select('*')
      .is('active', true)
      .like('email', '%@test.com')
      .order('name')
      .limit(10)

    expect(data!.length).toBeGreaterThanOrEqual(1)
  })
})

describe('UPDATE', () => {
  it('updates rows matching filter', async () => {
    const { data, error } = await db
      .from('users')
      .update({ name: 'Alice Updated' })
      .eq('email', 'alice@test.com')
      .returning()

    expect(error).toBeNull()
    expect(data).toHaveLength(1)
    expect(data![0].name).toBe('Alice Updated')
  })

  it('verifies update persisted', async () => {
    const { data } = await db
      .from('users')
      .select('*')
      .eq('email', 'alice@test.com')

    expect(data![0].name).toBe('Alice Updated')
  })
})

describe('UPSERT', () => {
  it('inserts when no conflict', async () => {
    const { data, error } = await db
      .from('users')
      .upsert({ id: 999, name: 'Dave', email: 'dave@test.com', active: true })
      .returning()

    expect(error).toBeNull()
    expect(data).toHaveLength(1)
    expect(data![0].name).toBe('Dave')
  })

  it('updates on conflict', async () => {
    const { data } = await db
      .from('users')
      .upsert({ id: 999, name: 'Dave Updated', email: 'dave@test.com', active: true })
      .returning()

    expect(data).toHaveLength(1)
    expect(data![0].name).toBe('Dave Updated')
  })
})

describe('DELETE', () => {
  it('deletes rows matching filter', async () => {
    const { error } = await db
      .from('users')
      .delete()
      .eq('id', 999)

    expect(error).toBeNull()

    const { data } = await db
      .from('users')
      .select('*')
      .eq('id', 999)

    expect(data).toHaveLength(0)
  })
})

describe('Relations (JOIN)', () => {
  it('can insert posts with author_id and query with join', async () => {
    // Get Alice's ID
    const { data: users } = await db
      .from('users')
      .select('*')
      .eq('email', 'alice@test.com')
    const aliceId = users![0].id

    // Insert posts
    await db.from('posts').insert([
      { title: 'First Post', body: 'Hello world', published: true, author_id: aliceId },
      { title: 'Draft Post', body: 'WIP', published: false, author_id: aliceId },
    ])

    // Verify posts exist
    const { data: posts } = await db
      .from('posts')
      .select('*')
      .eq('author_id', aliceId)

    expect(posts).toHaveLength(2)
  })

  it('filters with gt/gte/lt/lte on numeric columns', async () => {
    // Update views
    await db.from('posts').update({ views: 50 }).eq('title', 'First Post')
    await db.from('posts').update({ views: 10 }).eq('title', 'Draft Post')

    const { data: gt } = await db.from('posts').select('*').gt('views', 20)
    expect(gt).toHaveLength(1)
    expect(gt![0].title).toBe('First Post')

    const { data: gte } = await db.from('posts').select('*').gte('views', 10)
    expect(gte).toHaveLength(2)

    const { data: lt } = await db.from('posts').select('*').lt('views', 20)
    expect(lt).toHaveLength(1)

    const { data: lte } = await db.from('posts').select('*').lte('views', 50)
    expect(lte).toHaveLength(2)
  })
})

describe('Schema introspection', () => {
  it('discovers tables', async () => {
    const schema = await db.introspect()
    expect(schema.tables).toContain('users')
    expect(schema.tables).toContain('posts')
  })

  it('discovers foreign keys', async () => {
    const schema = await db.introspect()
    const fk = schema.foreignKeys.find(
      fk => fk.fromTable === 'posts' && fk.toTable === 'users'
    )
    expect(fk).toBeDefined()
    expect(fk!.fromColumn).toBe('author_id')
    expect(fk!.toColumn).toBe('id')
  })
})

describe('Error handling', () => {
  it('returns error for invalid table', async () => {
    const { data, error } = await db
      .from('nonexistent_table')
      .select('*')

    expect(data).toBeNull()
    expect(error).toBeDefined()
    expect(error!.message).toContain('nonexistent_table')
  })

  it('returns error for invalid column in filter', async () => {
    const { data, error } = await db
      .from('users')
      .select('*')
      .eq('nonexistent_column', 'value')

    expect(data).toBeNull()
    expect(error).toBeDefined()
  })
})
