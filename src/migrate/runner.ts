import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Sql } from 'postgres'
import {
  ensureMigrationsTable,
  getAppliedMigrations,
  recordMigration,
  removeMigration,
} from './tracker.js'

export interface MigrationFile {
  name: string       // e.g. "001_create_users"
  number: number     // e.g. 1
  upPath: string
  downPath: string
}

export async function discoverMigrations(dir: string): Promise<MigrationFile[]> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }

  const upFiles = entries.filter(f => f.endsWith('.up.sql'))
  const migrations: MigrationFile[] = []

  for (const upFile of upFiles) {
    // Pattern: 001_create_users.up.sql
    const match = upFile.match(/^(\d+)_(.+)\.up\.sql$/)
    if (!match) continue

    const number = parseInt(match[1], 10)
    const name = `${match[1]}_${match[2]}`
    const downFile = `${name}.down.sql`

    migrations.push({
      name,
      number,
      upPath: join(dir, upFile),
      downPath: join(dir, downFile),
    })
  }

  return migrations.sort((a, b) => a.number - b.number)
}

export async function migrateUp(
  sql: Sql,
  dir: string,
): Promise<string[]> {
  await ensureMigrationsTable(sql)

  const allMigrations = await discoverMigrations(dir)
  const applied = await getAppliedMigrations(sql)
  const pending = allMigrations.filter(m => !applied.includes(m.name))

  const appliedNow: string[] = []

  for (const migration of pending) {
    const upSql = await readFile(migration.upPath, 'utf-8')
    await sql.unsafe(upSql)
    await recordMigration(sql, migration.name)
    appliedNow.push(migration.name)
  }

  return appliedNow
}

export async function migrateDown(
  sql: Sql,
  dir: string,
): Promise<string | null> {
  await ensureMigrationsTable(sql)

  const allMigrations = await discoverMigrations(dir)
  const applied = await getAppliedMigrations(sql)

  if (applied.length === 0) return null

  const lastApplied = applied[applied.length - 1]
  const migration = allMigrations.find(m => m.name === lastApplied)

  if (!migration) {
    throw new Error(`Migration file not found for: ${lastApplied}`)
  }

  const downSql = await readFile(migration.downPath, 'utf-8')
  await sql.unsafe(downSql)
  await removeMigration(sql, migration.name)

  return migration.name
}
