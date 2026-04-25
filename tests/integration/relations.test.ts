import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient } from '../../src/index.js'
import type { ROpenDbClient } from '../../src/client.js'

const CONNECTION_STRING = 'postgres://truclean:truclean@localhost:5432/r_open_db_test'

let db: ROpenDbClient

beforeAll(async () => {
  db = createClient({ connectionString: CONNECTION_STRING })

  await db.raw`DROP TABLE IF EXISTS rel_posts CASCADE`
  await db.raw`DROP TABLE IF EXISTS rel_users CASCADE`
  await db.raw`
    CREATE TABLE rel_users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL
    )
  `
  await db.raw`
    CREATE TABLE rel_posts (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      author_id INTEGER REFERENCES rel_users(id),
      editor_id INTEGER REFERENCES rel_users(id)
    )
  `

  // Seed: Ada (1) authors 2 posts edited by Ben (2). Ben authors 0 posts. Cara (3) edits nothing.
  await db.raw`INSERT INTO rel_users (id, name, email) VALUES
    (1, 'Ada', 'ada@test.com'),
    (2, 'Ben', 'ben@test.com'),
    (3, 'Cara', 'cara@test.com')`
  await db.raw`SELECT setval('rel_users_id_seq', 3)`

  await db.raw`INSERT INTO rel_posts (id, title, author_id, editor_id) VALUES
    (1, 'First', 1, 2),
    (2, 'Second', 1, 2),
    (3, 'Orphan', NULL, NULL)`
  await db.raw`SELECT setval('rel_posts_id_seq', 3)`
})

afterAll(async () => {
  await db.raw`DROP TABLE IF EXISTS rel_posts CASCADE`
  await db.raw`DROP TABLE IF EXISTS rel_users CASCADE`
  await db.close()
})

describe('Relation queries — many-to-one', () => {
  it('returns a nested object for the parent FK', async () => {
    const { data, error } = await db
      .from('rel_posts')
      .select('id, title, author:rel_users!author_id(id, name)')
      .order('id')

    expect(error).toBeNull()
    expect(data).toEqual([
      { id: 1, title: 'First', author: { id: 1, name: 'Ada' } },
      { id: 2, title: 'Second', author: { id: 1, name: 'Ada' } },
      { id: 3, title: 'Orphan', author: null },
    ])
  })

  it('expands * to all columns of the related table', async () => {
    const { data, error } = await db
      .from('rel_posts')
      .select('id, author:rel_users!author_id(*)')
      .eq('id', 1)

    expect(error).toBeNull()
    expect(data![0].author).toEqual({ id: 1, name: 'Ada', email: 'ada@test.com' })
  })

  it('disambiguates when two FKs point at the same target table', async () => {
    const { data, error } = await db
      .from('rel_posts')
      .select('id, editor:rel_users!editor_id(name)')
      .eq('id', 1)

    expect(error).toBeNull()
    expect(data![0].editor).toEqual({ name: 'Ben' })
  })

  it('errors clearly when ambiguous and no hint is given', async () => {
    const { data, error } = await db
      .from('rel_posts')
      .select('id, user:rel_users(id, name)')

    expect(data).toBeNull()
    expect(error).toBeDefined()
    expect(error!.message).toContain('Ambiguous relation between "rel_posts" and "rel_users"')
    expect(error!.message).toContain('rel_posts.author_id, rel_posts.editor_id')
  })
})

describe('Relation queries — one-to-many', () => {
  it('returns an array for the children, [] when none, and works alongside filters', async () => {
    const { data, error } = await db
      .from('rel_users')
      .select('id, name, posts:rel_posts!author_id(id, title)')
      .order('id')

    expect(error).toBeNull()
    expect(data).toEqual([
      {
        id: 1,
        name: 'Ada',
        posts: [
          { id: 1, title: 'First' },
          { id: 2, title: 'Second' },
        ],
      },
      { id: 2, name: 'Ben', posts: [] },
      { id: 3, name: 'Cara', posts: [] },
    ])
  })

  it('respects outer-query filters/limit while children come along intact', async () => {
    const { data, error } = await db
      .from('rel_users')
      .select('id, posts:rel_posts!author_id(id)')
      .eq('name', 'Ada')

    expect(error).toBeNull()
    expect(data).toHaveLength(1)
    expect(data![0]).toEqual({ id: 1, posts: [{ id: 1 }, { id: 2 }] })
  })
})

describe('Relation queries — error surfacing', () => {
  it('rejects nested-of-nested at parse time via the error contract', async () => {
    const { data, error } = await db
      .from('rel_posts')
      .select('id, author:rel_users!author_id(id, posts:rel_posts(id))')

    expect(data).toBeNull()
    expect(error).toBeDefined()
    expect(error!.message).toContain('Nested relation')
    expect(error!.message).toContain('not supported in v1')
  })

  it('returns clear error when no FK exists between the two tables', async () => {
    const { data, error } = await db
      .from('rel_posts')
      .select('id, missing:rel_users_does_not_exist(id)')

    expect(data).toBeNull()
    expect(error).toBeDefined()
  })
})
