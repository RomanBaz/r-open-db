export type FilterOperator =
  | 'eq' | 'neq'
  | 'gt' | 'gte' | 'lt' | 'lte'
  | 'like' | 'ilike'
  | 'in' | 'is'

export interface Filter {
  column: string
  operator: FilterOperator
  value: unknown
}

export interface OrderClause {
  column: string
  ascending: boolean
}

export function filterToSql(
  filter: Filter,
  paramIndex: number,
): { sql: string; values: unknown[] } {
  const col = quoteIdent(filter.column)

  switch (filter.operator) {
    case 'eq':
      return { sql: `${col} = $${paramIndex}`, values: [filter.value] }
    case 'neq':
      return { sql: `${col} != $${paramIndex}`, values: [filter.value] }
    case 'gt':
      return { sql: `${col} > $${paramIndex}`, values: [filter.value] }
    case 'gte':
      return { sql: `${col} >= $${paramIndex}`, values: [filter.value] }
    case 'lt':
      return { sql: `${col} < $${paramIndex}`, values: [filter.value] }
    case 'lte':
      return { sql: `${col} <= $${paramIndex}`, values: [filter.value] }
    case 'like':
      return { sql: `${col} LIKE $${paramIndex}`, values: [filter.value] }
    case 'ilike':
      return { sql: `${col} ILIKE $${paramIndex}`, values: [filter.value] }
    case 'in': {
      const values = filter.value as unknown[]
      const placeholders = values.map((_, i) => `$${paramIndex + i}`).join(', ')
      return { sql: `${col} IN (${placeholders})`, values }
    }
    case 'is':
      // IS NULL / IS NOT NULL / IS TRUE / IS FALSE — no parameterization
      if (filter.value === null) return { sql: `${col} IS NULL`, values: [] }
      if (filter.value === true) return { sql: `${col} IS TRUE`, values: [] }
      if (filter.value === false) return { sql: `${col} IS FALSE`, values: [] }
      return { sql: `${col} IS NULL`, values: [] }
  }
}

export function quoteIdent(name: string): string {
  // Simple identifier quoting — prevents SQL injection in column/table names
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    return `"${name.replace(/"/g, '""')}"`
  }
  return `"${name}"`
}
