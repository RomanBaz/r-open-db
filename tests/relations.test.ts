import { describe, it, expect } from 'vitest'
import { parseSelectColumns, buildRelationSelect, type ForeignKey } from '../src/relations.js'

describe('parseSelectColumns', () => {
  it('parses simple columns', () => {
    const result = parseSelectColumns('id, title, body')
    expect(result.directColumns).toEqual(['id', 'title', 'body'])
    expect(result.relations).toEqual([])
  })

  it('parses relation syntax', () => {
    const result = parseSelectColumns('id, title, author:users(id, name)')
    expect(result.directColumns).toEqual(['id', 'title'])
    expect(result.relations).toEqual([
      { alias: 'author', table: 'users', columns: ['id', 'name'] },
    ])
  })

  it('parses multiple relations', () => {
    const result = parseSelectColumns('id, author:users(name), category:categories(label)')
    expect(result.directColumns).toEqual(['id'])
    expect(result.relations).toHaveLength(2)
    expect(result.relations[0].alias).toBe('author')
    expect(result.relations[1].alias).toBe('category')
  })

  it('parses * with relations', () => {
    const result = parseSelectColumns('*, author:users(name)')
    expect(result.directColumns).toEqual(['*'])
    expect(result.relations).toHaveLength(1)
  })
})

describe('buildRelationSelect', () => {
  const foreignKeys: ForeignKey[] = [
    {
      constraintName: 'posts_author_id_fkey',
      fromTable: 'posts',
      fromColumn: 'author_id',
      toTable: 'users',
      toColumn: 'id',
    },
  ]

  it('builds a JOIN query from relation syntax', () => {
    const parsed = parseSelectColumns('id, title, author:users(id, name)')
    const sql = buildRelationSelect('posts', 'public', parsed, foreignKeys)

    expect(sql).toContain('SELECT')
    expect(sql).toContain('"posts"."id"')
    expect(sql).toContain('"posts"."title"')
    expect(sql).toContain('LEFT JOIN')
    expect(sql).toContain('"author"."id"')
    expect(sql).toContain('"author"."name"')
  })

  it('throws when no FK found', () => {
    const parsed = parseSelectColumns('id, tag:tags(name)')
    expect(() => {
      buildRelationSelect('posts', 'public', parsed, foreignKeys)
    }).toThrow('No foreign key found between "posts" and "tags"')
  })
})
