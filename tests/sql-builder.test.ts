import { describe, it, expect } from 'vitest'
import { buildQuery, type QueryState } from '../src/sql-builder.js'

function baseState(overrides: Partial<QueryState> = {}): QueryState {
  return {
    table: 'posts',
    operation: 'select',
    columns: '*',
    filters: [],
    orderClauses: [],
    limitCount: null,
    offsetCount: null,
    data: null,
    returning: false,
    onConflict: null,
    schema: 'public',
    ...overrides,
  }
}

describe('buildQuery - SELECT', () => {
  it('builds a simple select *', () => {
    const q = buildQuery(baseState())
    expect(q.text).toBe('SELECT * FROM "public"."posts"')
    expect(q.values).toEqual([])
  })

  it('builds select with specific columns', () => {
    const q = buildQuery(baseState({ columns: 'id, title' }))
    expect(q.text).toBe('SELECT id, title FROM "public"."posts"')
    expect(q.values).toEqual([])
  })

  it('builds select with eq filter', () => {
    const q = buildQuery(baseState({
      filters: [{ column: 'id', operator: 'eq', value: 1 }],
    }))
    expect(q.text).toBe('SELECT * FROM "public"."posts" WHERE "id" = $1')
    expect(q.values).toEqual([1])
  })

  it('builds select with multiple filters', () => {
    const q = buildQuery(baseState({
      filters: [
        { column: 'published', operator: 'eq', value: true },
        { column: 'views', operator: 'gt', value: 100 },
      ],
    }))
    expect(q.text).toBe(
      'SELECT * FROM "public"."posts" WHERE "published" = $1 AND "views" > $2'
    )
    expect(q.values).toEqual([true, 100])
  })

  it('builds select with order', () => {
    const q = buildQuery(baseState({
      orderClauses: [{ column: 'created_at', ascending: false }],
    }))
    expect(q.text).toBe(
      'SELECT * FROM "public"."posts" ORDER BY "created_at" DESC'
    )
  })

  it('builds select with limit and offset', () => {
    const q = buildQuery(baseState({
      limitCount: 10,
      offsetCount: 20,
    }))
    expect(q.text).toBe('SELECT * FROM "public"."posts" LIMIT 10 OFFSET 20')
  })

  it('builds select with IN filter', () => {
    const q = buildQuery(baseState({
      filters: [{ column: 'id', operator: 'in', value: [1, 2, 3] }],
    }))
    expect(q.text).toBe(
      'SELECT * FROM "public"."posts" WHERE "id" IN ($1, $2, $3)'
    )
    expect(q.values).toEqual([1, 2, 3])
  })

  it('builds select with IS NULL filter', () => {
    const q = buildQuery(baseState({
      filters: [{ column: 'deleted_at', operator: 'is', value: null }],
    }))
    expect(q.text).toBe(
      'SELECT * FROM "public"."posts" WHERE "deleted_at" IS NULL'
    )
    expect(q.values).toEqual([])
  })

  it('builds select with LIKE filter', () => {
    const q = buildQuery(baseState({
      filters: [{ column: 'title', operator: 'like', value: '%hello%' }],
    }))
    expect(q.text).toBe(
      'SELECT * FROM "public"."posts" WHERE "title" LIKE $1'
    )
    expect(q.values).toEqual(['%hello%'])
  })

  it('builds select with ILIKE filter', () => {
    const q = buildQuery(baseState({
      filters: [{ column: 'title', operator: 'ilike', value: '%hello%' }],
    }))
    expect(q.text).toBe(
      'SELECT * FROM "public"."posts" WHERE "title" ILIKE $1'
    )
    expect(q.values).toEqual(['%hello%'])
  })
})

describe('buildQuery - INSERT', () => {
  it('builds a simple insert', () => {
    const q = buildQuery(baseState({
      operation: 'insert',
      data: { title: 'Hello', body: 'World' },
    }))
    expect(q.text).toBe(
      'INSERT INTO "public"."posts" ("title", "body") VALUES ($1, $2)'
    )
    expect(q.values).toEqual(['Hello', 'World'])
  })

  it('builds insert with RETURNING', () => {
    const q = buildQuery(baseState({
      operation: 'insert',
      data: { title: 'Hello' },
      returning: true,
    }))
    expect(q.text).toBe(
      'INSERT INTO "public"."posts" ("title") VALUES ($1) RETURNING *'
    )
  })

  it('builds bulk insert', () => {
    const q = buildQuery(baseState({
      operation: 'insert',
      data: [
        { title: 'A', body: '1' },
        { title: 'B', body: '2' },
      ],
    }))
    expect(q.text).toBe(
      'INSERT INTO "public"."posts" ("title", "body") VALUES ($1, $2), ($3, $4)'
    )
    expect(q.values).toEqual(['A', '1', 'B', '2'])
  })
})

describe('buildQuery - UPDATE', () => {
  it('builds update with filter', () => {
    const q = buildQuery(baseState({
      operation: 'update',
      data: { title: 'Updated' },
      filters: [{ column: 'id', operator: 'eq', value: 1 }],
    }))
    expect(q.text).toBe(
      'UPDATE "public"."posts" SET "title" = $1 WHERE "id" = $2'
    )
    expect(q.values).toEqual(['Updated', 1])
  })

  it('builds update with RETURNING', () => {
    const q = buildQuery(baseState({
      operation: 'update',
      data: { title: 'Updated' },
      filters: [{ column: 'id', operator: 'eq', value: 1 }],
      returning: true,
    }))
    expect(q.text).toContain('RETURNING *')
  })
})

describe('buildQuery - DELETE', () => {
  it('builds delete with filter', () => {
    const q = buildQuery(baseState({
      operation: 'delete',
      filters: [{ column: 'id', operator: 'eq', value: 1 }],
    }))
    expect(q.text).toBe('DELETE FROM "public"."posts" WHERE "id" = $1')
    expect(q.values).toEqual([1])
  })
})

describe('buildQuery - UPSERT', () => {
  it('builds upsert with default conflict on id', () => {
    const q = buildQuery(baseState({
      operation: 'upsert',
      data: { id: 1, title: 'Upserted' },
      onConflict: 'id',
    }))
    expect(q.text).toBe(
      'INSERT INTO "public"."posts" ("id", "title") VALUES ($1, $2) ON CONFLICT ("id") DO UPDATE SET "title" = EXCLUDED."title"'
    )
    expect(q.values).toEqual([1, 'Upserted'])
  })
})
