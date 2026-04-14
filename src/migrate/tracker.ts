import type { Sql } from 'postgres'

const MIGRATIONS_TABLE = '_r_open_db_migrations'

export async function ensureMigrationsTable(sql: Sql): Promise<void> {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
}

export async function getAppliedMigrations(sql: Sql): Promise<string[]> {
  const rows = await sql.unsafe<{ name: string }[]>(
    `SELECT name FROM ${MIGRATIONS_TABLE} ORDER BY id ASC`
  )
  return rows.map(r => r.name)
}

export async function recordMigration(sql: Sql, name: string): Promise<void> {
  await sql.unsafe(
    `INSERT INTO ${MIGRATIONS_TABLE} (name) VALUES ($1)`,
    [name],
  )
}

export async function removeMigration(sql: Sql, name: string): Promise<void> {
  await sql.unsafe(
    `DELETE FROM ${MIGRATIONS_TABLE} WHERE name = $1`,
    [name],
  )
}
