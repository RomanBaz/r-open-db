import postgres, { type Sql } from 'postgres'

export interface ConnectionOptions {
  connectionString: string
  max?: number
}

export function createConnection(opts: ConnectionOptions): Sql {
  return postgres(opts.connectionString, {
    max: opts.max ?? 10,
    idle_timeout: 20,
    connect_timeout: 10,
  })
}
