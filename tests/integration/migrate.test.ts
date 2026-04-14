import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import postgres from 'postgres'
import { migrate } from '../../src/migrate/index.js'
import { ensureMigrationsTable, getAppliedMigrations } from '../../src/migrate/tracker.js'

const CONNECTION_STRING = 'postgres://truclean:truclean@localhost:5432/r_open_db_test'

let tempDir: string
let sql: ReturnType<typeof postgres>

beforeAll(async () => {
  sql = postgres(CONNECTION_STRING, { max: 1 })

  // Clean up any leftover migration state
  await sql.unsafe('DROP TABLE IF EXISTS _r_open_db_migrations CASCADE')
  await sql.unsafe('DROP TABLE IF EXISTS comments CASCADE')
  await sql.unsafe('DROP TABLE IF EXISTS tags CASCADE')

  // Create temp dir for migration files
  tempDir = await mkdtemp(join(tmpdir(), 'r-open-db-test-'))

  // Write test migration files
  await writeFile(
    join(tempDir, '001_create_comments.up.sql'),
    `CREATE TABLE comments (
      id SERIAL PRIMARY KEY,
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );`,
  )
  await writeFile(
    join(tempDir, '001_create_comments.down.sql'),
    'DROP TABLE IF EXISTS comments;',
  )

  await writeFile(
    join(tempDir, '002_create_tags.up.sql'),
    `CREATE TABLE tags (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE
    );`,
  )
  await writeFile(
    join(tempDir, '002_create_tags.down.sql'),
    'DROP TABLE IF EXISTS tags;',
  )
})

afterAll(async () => {
  await sql.unsafe('DROP TABLE IF EXISTS _r_open_db_migrations CASCADE')
  await sql.unsafe('DROP TABLE IF EXISTS comments CASCADE')
  await sql.unsafe('DROP TABLE IF EXISTS tags CASCADE')
  await sql.end()
  await rm(tempDir, { recursive: true })
})

describe('migrate up', () => {
  it('applies all pending migrations', async () => {
    const applied = await migrate({
      connectionString: CONNECTION_STRING,
      direction: 'up',
      migrationsDir: tempDir,
    })

    expect(applied).toEqual(['001_create_comments', '002_create_tags'])
  })

  it('created the tables', async () => {
    const result = await sql.unsafe(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ('comments', 'tags')
      ORDER BY table_name
    `)
    expect(result.map((r: any) => r.table_name)).toEqual(['comments', 'tags'])
  })

  it('tracks applied migrations', async () => {
    await ensureMigrationsTable(sql)
    const applied = await getAppliedMigrations(sql)
    expect(applied).toEqual(['001_create_comments', '002_create_tags'])
  })

  it('returns empty array when nothing to apply', async () => {
    const applied = await migrate({
      connectionString: CONNECTION_STRING,
      direction: 'up',
      migrationsDir: tempDir,
    })

    expect(applied).toEqual([])
  })
})

describe('migrate down', () => {
  it('rolls back the last migration', async () => {
    const rolled = await migrate({
      connectionString: CONNECTION_STRING,
      direction: 'down',
      migrationsDir: tempDir,
    })

    expect(rolled).toEqual(['002_create_tags'])
  })

  it('dropped the tags table', async () => {
    const result = await sql.unsafe(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'tags'
    `)
    expect(result).toHaveLength(0)
  })

  it('comments table still exists', async () => {
    const result = await sql.unsafe(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'comments'
    `)
    expect(result).toHaveLength(1)
  })

  it('rolls back the remaining migration', async () => {
    const rolled = await migrate({
      connectionString: CONNECTION_STRING,
      direction: 'down',
      migrationsDir: tempDir,
    })

    expect(rolled).toEqual(['001_create_comments'])
  })

  it('returns empty when nothing to rollback', async () => {
    const rolled = await migrate({
      connectionString: CONNECTION_STRING,
      direction: 'down',
      migrationsDir: tempDir,
    })

    expect(rolled).toEqual([])
  })

  it('can re-apply after full rollback', async () => {
    const applied = await migrate({
      connectionString: CONNECTION_STRING,
      direction: 'up',
      migrationsDir: tempDir,
    })

    expect(applied).toEqual(['001_create_comments', '002_create_tags'])
  })
})
