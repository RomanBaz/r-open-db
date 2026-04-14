import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { migrate } from '../migrate/index.js'
import { discoverMigrations } from '../migrate/runner.js'

export async function handleMigrate(args: string[]): Promise<void> {
  const subcommand = args[0]

  if (!subcommand || !['up', 'down', 'new'].includes(subcommand)) {
    console.error('Usage: r-open-db migrate <up|down|new> [name]')
    process.exit(1)
  }

  const migrationsDir = process.env.MIGRATIONS_DIR || './migrations'

  if (subcommand === 'new') {
    const name = args[1]
    if (!name) {
      console.error('Usage: r-open-db migrate new <name>')
      process.exit(1)
    }
    await scaffoldMigration(migrationsDir, name)
    return
  }

  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    console.error('DATABASE_URL environment variable is required')
    process.exit(1)
  }

  const applied = await migrate({
    connectionString,
    direction: subcommand as 'up' | 'down',
    migrationsDir,
  })

  if (applied.length === 0) {
    console.log(subcommand === 'up' ? 'No pending migrations.' : 'Nothing to rollback.')
  } else {
    const verb = subcommand === 'up' ? 'Applied' : 'Rolled back'
    for (const name of applied) {
      console.log(`${verb}: ${name}`)
    }
  }
}

async function scaffoldMigration(dir: string, name: string): Promise<void> {
  await mkdir(dir, { recursive: true })

  const existing = await discoverMigrations(dir)
  const nextNumber = existing.length > 0
    ? Math.max(...existing.map(m => m.number)) + 1
    : 1

  const prefix = String(nextNumber).padStart(3, '0')
  const baseName = `${prefix}_${name}`

  const upPath = join(dir, `${baseName}.up.sql`)
  const downPath = join(dir, `${baseName}.down.sql`)

  await writeFile(upPath, `-- Migration: ${name} (up)\n`, 'utf-8')
  await writeFile(downPath, `-- Migration: ${name} (down)\n`, 'utf-8')

  console.log(`Created: ${upPath}`)
  console.log(`Created: ${downPath}`)
}
