import type { Sql } from 'postgres'
import { createConnection, type ConnectionOptions } from './connection.js'
import { QueryBuilder } from './query-builder.js'
import { type SchemaCache, introspectSchema } from './relations.js'

export interface ClientOptions {
  connectionString: string
  schema?: string
  max?: number
}

export class ROpenDbClient {
  private sql: Sql
  private schema: string
  private schemaCache: SchemaCache | null = null

  constructor(opts: ClientOptions) {
    this.schema = opts.schema || 'public'
    this.sql = createConnection({
      connectionString: opts.connectionString,
      max: opts.max,
    })
  }

  from<T = Record<string, unknown>>(table: string): QueryBuilder<T> {
    return new QueryBuilder<T>(this.sql, table, this.schema)
  }

  async introspect(): Promise<SchemaCache> {
    if (!this.schemaCache) {
      this.schemaCache = await introspectSchema(this.sql, this.schema)
    }
    return this.schemaCache
  }

  /** Access the underlying postgres driver for raw queries */
  get raw(): Sql {
    return this.sql
  }

  async close(): Promise<void> {
    await this.sql.end()
  }
}
