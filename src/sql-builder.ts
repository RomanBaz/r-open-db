import { type Filter, type OrderClause, filterToSql, quoteIdent } from './filters.js'

export type QueryOperation = 'select' | 'insert' | 'update' | 'delete' | 'upsert'

export interface QueryState {
  table: string
  operation: QueryOperation
  columns: string | null      // for select: 'id, name' or '*'
  filters: Filter[]
  orderClauses: OrderClause[]
  limitCount: number | null
  offsetCount: number | null
  data: Record<string, unknown> | Record<string, unknown>[] | null // for insert/update/upsert
  returning: boolean           // whether to return rows after insert/update/delete
  onConflict: string | null    // for upsert: conflict column(s)
  schema: string
}

export interface BuiltQuery {
  text: string
  values: unknown[]
}

export function buildQuery(state: QueryState): BuiltQuery {
  switch (state.operation) {
    case 'select':
      return buildSelect(state)
    case 'insert':
      return buildInsert(state)
    case 'update':
      return buildUpdate(state)
    case 'delete':
      return buildDelete(state)
    case 'upsert':
      return buildUpsert(state)
  }
}

function buildSelect(state: QueryState): BuiltQuery {
  const values: unknown[] = []
  const table = qualifiedTable(state)
  const cols = state.columns || '*'

  let text = `SELECT ${cols} FROM ${table}`

  const whereClause = buildWhere(state.filters, values)
  if (whereClause) text += ` WHERE ${whereClause}`

  if (state.orderClauses.length > 0) {
    const orders = state.orderClauses.map(
      o => `${quoteIdent(o.column)} ${o.ascending ? 'ASC' : 'DESC'}`
    )
    text += ` ORDER BY ${orders.join(', ')}`
  }

  if (state.limitCount !== null) {
    text += ` LIMIT ${state.limitCount}`
  }

  if (state.offsetCount !== null) {
    text += ` OFFSET ${state.offsetCount}`
  }

  return { text, values }
}

function buildInsert(state: QueryState): BuiltQuery {
  const values: unknown[] = []
  const table = qualifiedTable(state)
  const rows = normalizeData(state.data)

  const columns = Object.keys(rows[0])
  const colList = columns.map(quoteIdent).join(', ')

  const rowPlaceholders = rows.map(row => {
    const placeholders = columns.map(col => {
      values.push(row[col])
      return `$${values.length}`
    })
    return `(${placeholders.join(', ')})`
  })

  let text = `INSERT INTO ${table} (${colList}) VALUES ${rowPlaceholders.join(', ')}`

  if (state.returning) {
    text += ' RETURNING *'
  }

  return { text, values }
}

function buildUpdate(state: QueryState): BuiltQuery {
  const values: unknown[] = []
  const table = qualifiedTable(state)
  const row = normalizeData(state.data)[0]

  const setClauses = Object.entries(row).map(([col, val]) => {
    values.push(val)
    return `${quoteIdent(col)} = $${values.length}`
  })

  let text = `UPDATE ${table} SET ${setClauses.join(', ')}`

  const whereClause = buildWhere(state.filters, values)
  if (whereClause) text += ` WHERE ${whereClause}`

  if (state.returning) {
    text += ' RETURNING *'
  }

  return { text, values }
}

function buildDelete(state: QueryState): BuiltQuery {
  const values: unknown[] = []
  const table = qualifiedTable(state)

  let text = `DELETE FROM ${table}`

  const whereClause = buildWhere(state.filters, values)
  if (whereClause) text += ` WHERE ${whereClause}`

  if (state.returning) {
    text += ' RETURNING *'
  }

  return { text, values }
}

function buildUpsert(state: QueryState): BuiltQuery {
  const values: unknown[] = []
  const table = qualifiedTable(state)
  const rows = normalizeData(state.data)

  const columns = Object.keys(rows[0])
  const colList = columns.map(quoteIdent).join(', ')

  const rowPlaceholders = rows.map(row => {
    const placeholders = columns.map(col => {
      values.push(row[col])
      return `$${values.length}`
    })
    return `(${placeholders.join(', ')})`
  })

  // Default conflict target is 'id' unless specified
  const conflictCol = state.onConflict || 'id'
  const updateCols = columns
    .filter(c => c !== conflictCol)
    .map(c => `${quoteIdent(c)} = EXCLUDED.${quoteIdent(c)}`)

  let text = `INSERT INTO ${table} (${colList}) VALUES ${rowPlaceholders.join(', ')}`
  text += ` ON CONFLICT (${quoteIdent(conflictCol)}) DO UPDATE SET ${updateCols.join(', ')}`

  if (state.returning) {
    text += ' RETURNING *'
  }

  return { text, values }
}

function buildWhere(filters: Filter[], values: unknown[]): string {
  if (filters.length === 0) return ''

  const conditions = filters.map(filter => {
    const paramIndex = values.length + 1
    const result = filterToSql(filter, paramIndex)
    values.push(...result.values)
    return result.sql
  })

  return conditions.join(' AND ')
}

function qualifiedTable(state: QueryState): string {
  return `${quoteIdent(state.schema)}.${quoteIdent(state.table)}`
}

function normalizeData(
  data: Record<string, unknown> | Record<string, unknown>[] | null,
): Record<string, unknown>[] {
  if (!data) throw new Error('No data provided for insert/update/upsert')
  return Array.isArray(data) ? data : [data]
}
