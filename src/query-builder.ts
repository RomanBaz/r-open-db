import type { Sql } from 'postgres'
import type { Filter, FilterOperator, OrderClause } from './filters.js'
import { type QueryOperation, type QueryState, buildQuery } from './sql-builder.js'

export interface QueryResult<T = Record<string, unknown>> {
  data: T[] | null
  error: Error | null
}

export class QueryBuilder<T = Record<string, unknown>> {
  private sql: Sql
  private state: QueryState

  constructor(sql: Sql, table: string, schema: string) {
    this.sql = sql
    this.state = {
      table,
      operation: 'select',
      columns: null,
      filters: [],
      orderClauses: [],
      limitCount: null,
      offsetCount: null,
      data: null,
      returning: false,
      onConflict: null,
      schema,
    }
  }

  private clone(): QueryBuilder<T> {
    const qb = new QueryBuilder<T>(this.sql, this.state.table, this.state.schema)
    qb.state = {
      ...this.state,
      filters: [...this.state.filters],
      orderClauses: [...this.state.orderClauses],
    }
    return qb
  }

  // --- Operations ---

  select(columns?: string): QueryBuilder<T> {
    const qb = this.clone()
    qb.state.operation = 'select'
    qb.state.columns = columns || '*'
    return qb
  }

  insert(data: Partial<T> | Partial<T>[]): QueryBuilder<T> {
    const qb = this.clone()
    qb.state.operation = 'insert'
    qb.state.data = data as Record<string, unknown> | Record<string, unknown>[]
    return qb
  }

  update(data: Partial<T>): QueryBuilder<T> {
    const qb = this.clone()
    qb.state.operation = 'update'
    qb.state.data = data as Record<string, unknown>
    return qb
  }

  upsert(
    data: Partial<T> | Partial<T>[],
    opts?: { onConflict?: string },
  ): QueryBuilder<T> {
    const qb = this.clone()
    qb.state.operation = 'upsert'
    qb.state.data = data as Record<string, unknown> | Record<string, unknown>[]
    qb.state.onConflict = opts?.onConflict || 'id'
    return qb
  }

  delete(): QueryBuilder<T> {
    const qb = this.clone()
    qb.state.operation = 'delete'
    return qb
  }

  // --- Filters ---

  eq(column: string, value: unknown): QueryBuilder<T> {
    return this.addFilter(column, 'eq', value)
  }

  neq(column: string, value: unknown): QueryBuilder<T> {
    return this.addFilter(column, 'neq', value)
  }

  gt(column: string, value: unknown): QueryBuilder<T> {
    return this.addFilter(column, 'gt', value)
  }

  gte(column: string, value: unknown): QueryBuilder<T> {
    return this.addFilter(column, 'gte', value)
  }

  lt(column: string, value: unknown): QueryBuilder<T> {
    return this.addFilter(column, 'lt', value)
  }

  lte(column: string, value: unknown): QueryBuilder<T> {
    return this.addFilter(column, 'lte', value)
  }

  like(column: string, pattern: string): QueryBuilder<T> {
    return this.addFilter(column, 'like', pattern)
  }

  ilike(column: string, pattern: string): QueryBuilder<T> {
    return this.addFilter(column, 'ilike', pattern)
  }

  in(column: string, values: unknown[]): QueryBuilder<T> {
    return this.addFilter(column, 'in', values)
  }

  is(column: string, value: null | boolean): QueryBuilder<T> {
    return this.addFilter(column, 'is', value)
  }

  // --- Modifiers ---

  order(column: string, opts?: { ascending?: boolean }): QueryBuilder<T> {
    const qb = this.clone()
    qb.state.orderClauses.push({
      column,
      ascending: opts?.ascending ?? true,
    })
    return qb
  }

  limit(count: number): QueryBuilder<T> {
    const qb = this.clone()
    qb.state.limitCount = count
    return qb
  }

  offset(count: number): QueryBuilder<T> {
    const qb = this.clone()
    qb.state.offsetCount = count
    return qb
  }

  // --- Execution ---

  /**
   * When chained after insert/update/delete/upsert, returns the affected rows.
   * When chained after select or used standalone, acts as the select executor.
   */
  async then<TResult1 = QueryResult<T>, TResult2 = never>(
    onfulfilled?: ((value: QueryResult<T>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    const result = this.execute()
    return result.then(onfulfilled, onrejected)
  }

  /**
   * For insert/update/delete — chain .select() to return affected rows via RETURNING.
   * This overload sets the returning flag instead of changing to a SELECT operation.
   */
  returning(): QueryBuilder<T> {
    const qb = this.clone()
    if (qb.state.operation !== 'select') {
      qb.state.returning = true
    }
    return qb
  }

  private async execute(): Promise<QueryResult<T>> {
    try {
      const { text, values } = buildQuery(this.state)
      const result = await this.sql.unsafe(text, values as any[])
      return { data: result as unknown as T[], error: null }
    } catch (err) {
      return { data: null, error: err as Error }
    }
  }

  private addFilter(column: string, operator: FilterOperator, value: unknown): QueryBuilder<T> {
    const qb = this.clone()
    qb.state.filters.push({ column, operator, value })
    return qb
  }
}
