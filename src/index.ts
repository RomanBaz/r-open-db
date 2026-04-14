export { ROpenDbClient, type ClientOptions } from './client.js'
export { QueryBuilder, type QueryResult } from './query-builder.js'
export type { Filter, FilterOperator, OrderClause } from './filters.js'
export type { ForeignKey, SchemaCache, ParsedRelation, ParsedSelect } from './relations.js'

import { ROpenDbClient, type ClientOptions } from './client.js'

export function createClient(opts: ClientOptions): ROpenDbClient {
  return new ROpenDbClient(opts)
}
