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
  private schemaPromise: Promise<SchemaCache> | null = null

  constructor(opts: ClientOptions) {
    this.schema = opts.schema || 'public'
    this.sql = createConnection({
      connectionString: opts.connectionString,
      max: opts.max,
    })
  }

  from<T = Record<string, unknown>>(table: string): QueryBuilder<T> {
    return new QueryBuilder<T>(this.sql, table, this.schema, () => this.introspect())
  }

  async introspect(): Promise<SchemaCache> {
    if (this.schemaCache) return this.schemaCache
    if (!this.schemaPromise) {
      this.schemaPromise = introspectSchema(this.sql, this.schema).then(cache => {
        this.schemaCache = cache
        return cache
      })
    }
    return this.schemaPromise
  }

  /** Access the underlying postgres driver for raw queries */
  get raw(): Sql {
    return this.sql
  }

  async close(): Promise<void> {
    await this.sql.end()
  }
}
