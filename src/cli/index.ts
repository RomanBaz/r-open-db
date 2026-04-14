import { handleMigrate } from './migrate.js'

// Load .env file if present
async function loadEnv(): Promise<void> {
  try {
    const { readFile } = await import('node:fs/promises')
    const content = await readFile('.env', 'utf-8')
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eqIndex = trimmed.indexOf('=')
      if (eqIndex === -1) continue
      const key = trimmed.slice(0, eqIndex).trim()
      const value = trimmed.slice(eqIndex + 1).trim().replace(/^["']|["']$/g, '')
      if (!process.env[key]) {
        process.env[key] = value
      }
    }
  } catch {
    // No .env file — that's fine
  }
}

async function main(): Promise<void> {
  await loadEnv()

  const args = process.argv.slice(2)
  const command = args[0]

  switch (command) {
    case 'migrate':
      await handleMigrate(args.slice(1))
      break
    default:
      console.log('r-open-db - Lightweight Supabase-style Postgres client')
      console.log('')
      console.log('Commands:')
      console.log('  migrate up        Run pending migrations')
      console.log('  migrate down      Rollback last migration')
      console.log('  migrate new NAME  Create a new migration')
      process.exit(command ? 1 : 0)
  }
}

main().catch(err => {
  console.error(err.message)
  process.exit(1)
})
