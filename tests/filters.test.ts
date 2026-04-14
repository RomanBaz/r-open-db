import { describe, it, expect } from 'vitest'
import { filterToSql, quoteIdent } from '../src/filters.js'

describe('filterToSql', () => {
  it('eq', () => {
    const r = filterToSql({ column: 'id', operator: 'eq', value: 1 }, 1)
    expect(r.sql).toBe('"id" = $1')
    expect(r.values).toEqual([1])
  })

  it('neq', () => {
    const r = filterToSql({ column: 'status', operator: 'neq', value: 'draft' }, 1)
    expect(r.sql).toBe('"status" != $1')
    expect(r.values).toEqual(['draft'])
  })

  it('gt', () => {
    const r = filterToSql({ column: 'age', operator: 'gt', value: 18 }, 1)
    expect(r.sql).toBe('"age" > $1')
  })

  it('gte', () => {
    const r = filterToSql({ column: 'age', operator: 'gte', value: 18 }, 1)
    expect(r.sql).toBe('"age" >= $1')
  })

  it('lt', () => {
    const r = filterToSql({ column: 'age', operator: 'lt', value: 18 }, 1)
    expect(r.sql).toBe('"age" < $1')
  })

  it('lte', () => {
    const r = filterToSql({ column: 'age', operator: 'lte', value: 18 }, 1)
    expect(r.sql).toBe('"age" <= $1')
  })

  it('like', () => {
    const r = filterToSql({ column: 'name', operator: 'like', value: '%john%' }, 1)
    expect(r.sql).toBe('"name" LIKE $1')
    expect(r.values).toEqual(['%john%'])
  })

  it('ilike', () => {
    const r = filterToSql({ column: 'name', operator: 'ilike', value: '%john%' }, 1)
    expect(r.sql).toBe('"name" ILIKE $1')
  })

  it('in', () => {
    const r = filterToSql({ column: 'id', operator: 'in', value: [1, 2, 3] }, 1)
    expect(r.sql).toBe('"id" IN ($1, $2, $3)')
    expect(r.values).toEqual([1, 2, 3])
  })

  it('is null', () => {
    const r = filterToSql({ column: 'deleted_at', operator: 'is', value: null }, 1)
    expect(r.sql).toBe('"deleted_at" IS NULL')
    expect(r.values).toEqual([])
  })

  it('is true', () => {
    const r = filterToSql({ column: 'active', operator: 'is', value: true }, 1)
    expect(r.sql).toBe('"active" IS TRUE')
    expect(r.values).toEqual([])
  })

  it('is false', () => {
    const r = filterToSql({ column: 'active', operator: 'is', value: false }, 1)
    expect(r.sql).toBe('"active" IS FALSE')
    expect(r.values).toEqual([])
  })
})

describe('quoteIdent', () => {
  it('quotes simple identifiers', () => {
    expect(quoteIdent('users')).toBe('"users"')
  })

  it('quotes identifiers with special characters', () => {
    expect(quoteIdent('my table')).toBe('"my table"')
  })

  it('escapes double quotes in identifiers', () => {
    expect(quoteIdent('my"table')).toBe('"my""table"')
  })
})
