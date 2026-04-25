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

// Stable lock key for the migrations table. Picked as a fixed bigint so we
// don't need an extra round-trip to compute hashtext() at runtime.
const ADVISORY_LOCK_KEY = 4039472183n

async function withReservedConnection<T>(sql: Sql, fn: (conn: Sql) => Promise<T>): Promise<T> {
  // Advisory locks are session-scoped, so we must hold a single connection
  // for the duration of the migrate run — otherwise sql.unsafe() may route
  // later queries to a different pool connection that doesn't hold the lock.
  const reserved = await sql.reserve()
  try {
    await reserved.unsafe(`SELECT pg_advisory_lock(${ADVISORY_LOCK_KEY})`)
    try {
      return await fn(reserved as unknown as Sql)
    } finally {
      await reserved.unsafe(`SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY})`)
    }
  } finally {
    reserved.release()
  }
}

async function runInTransaction(conn: Sql, fn: () => Promise<void>): Promise<void> {
  // The reserved sql function from postgres-js doesn't expose .begin(), so
  // we drive the transaction manually on the reserved connection.
  await conn.unsafe('BEGIN')
  try {
    await fn()
    await conn.unsafe('COMMIT')
  } catch (err) {
    try {
      await conn.unsafe('ROLLBACK')
    } catch {
      // Swallow rollback errors so the original failure surfaces.
    }
    throw err
  }
}

async function readMigrationSql(path: string, kind: 'up' | 'down'): Promise<string> {
  try {
    return await readFile(path, 'utf-8')
  } catch (err: unknown) {
    if (isNodeErrorWithCode(err, 'ENOENT')) {
      throw new Error(`Missing ${kind} migration file: ${path}`)
    }
    throw err
  }
}

function isNodeErrorWithCode(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code: unknown }).code === code
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
  return withReservedConnection(sql, async (conn) => {
    // Done inside the advisory lock because concurrent CREATE TABLE
    // IF NOT EXISTS calls can still race at the system-catalog level.
    await ensureMigrationsTable(conn)

    const allMigrations = await discoverMigrations(dir)
    const applied = await getAppliedMigrations(conn)
    const pending = allMigrations.filter(m => !applied.includes(m.name))

    const appliedNow: string[] = []

    for (const migration of pending) {
      const upSql = await readMigrationSql(migration.upPath, 'up')
      await runInTransaction(conn, async () => {
        await conn.unsafe(upSql)
        await recordMigration(conn, migration.name)
      })
      appliedNow.push(migration.name)
    }

    return appliedNow
  })
}

export async function migrateDown(
  sql: Sql,
  dir: string,
): Promise<string | null> {
  return withReservedConnection(sql, async (conn) => {
    await ensureMigrationsTable(conn)

    const allMigrations = await discoverMigrations(dir)
    const applied = await getAppliedMigrations(conn)

    if (applied.length === 0) return null

    const lastApplied = applied[applied.length - 1]
    const migration = allMigrations.find(m => m.name === lastApplied)

    if (!migration) {
      throw new Error(`Migration file not found for: ${lastApplied}`)
    }

    const downSql = await readMigrationSql(migration.downPath, 'down')
    await runInTransaction(conn, async () => {
      await conn.unsafe(downSql)
      await removeMigration(conn, migration.name)
    })

    return migration.name
  })
}
