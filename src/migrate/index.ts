import postgres from 'postgres'
import { migrateUp, migrateDown } from './runner.js'

export { discoverMigrations, migrateUp, migrateDown } from './runner.js'
export {
  ensureMigrationsTable,
  getAppliedMigrations,
} from './tracker.js'

export interface MigrateOptions {
  connectionString: string
  direction: 'up' | 'down'
  migrationsDir?: string
}

export async function migrate(opts: MigrateOptions): Promise<string[]> {
  const sql = postgres(opts.connectionString, { max: 1 })
  const dir = opts.migrationsDir || './migrations'

  try {
    if (opts.direction === 'up') {
      return await migrateUp(sql, dir)
    } else {
      const rolled = await migrateDown(sql, dir)
      return rolled ? [rolled] : []
    }
  } finally {
    await sql.end()
  }
}
