import { describe, it, expect } from 'vitest'
import {
  parseSelectColumns,
  buildRelationSelect,
  hasRelationSyntax,
  type SchemaCache,
} from '../src/relations.js'

const SINGLE_FK: SchemaCache = {
  tables: ['users', 'posts'],
  foreignKeys: [
    {
      constraintName: 'posts_author_id_fkey',
      fromTable: 'posts',
      fromColumn: 'author_id',
      toTable: 'users',
      toColumn: 'id',
    },
  ],
  columns: {
    users: ['id', 'name', 'email'],
    posts: ['id', 'title', 'body', 'author_id'],
  },
}

const TWO_FKS: SchemaCache = {
  tables: ['users', 'posts'],
  foreignKeys: [
    {
      constraintName: 'posts_author_id_fkey',
      fromTable: 'posts',
      fromColumn: 'author_id',
      toTable: 'users',
      toColumn: 'id',
    },
    {
      constraintName: 'posts_editor_id_fkey',
      fromTable: 'posts',
      fromColumn: 'editor_id',
      toTable: 'users',
      toColumn: 'id',
    },
  ],
  columns: {
    users: ['id', 'name', 'email'],
    posts: ['id', 'title', 'author_id', 'editor_id'],
  },
}

const COMPOSITE_FK: SchemaCache = {
  tables: ['orders', 'order_items'],
  foreignKeys: [
    {
      constraintName: 'order_items_order_fkey',
      fromTable: 'order_items',
      fromColumn: 'order_id',
      toTable: 'orders',
      toColumn: 'id',
    },
    {
      constraintName: 'order_items_order_fkey',
      fromTable: 'order_items',
      fromColumn: 'tenant_id',
      toTable: 'orders',
      toColumn: 'tenant_id',
    },
  ],
  columns: {
    orders: ['id', 'tenant_id'],
    order_items: ['id', 'order_id', 'tenant_id'],
  },
}

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
      { alias: 'author', table: 'users', fkColumn: undefined, columns: ['id', 'name'] },
    ])
  })

  it('parses relation with !fkcol disambiguation hint', () => {
    const result = parseSelectColumns('author:users!author_id(id, name)')
    expect(result.relations).toEqual([
      { alias: 'author', table: 'users', fkColumn: 'author_id', columns: ['id', 'name'] },
    ])
  })

  it('parses multiple relations including one with hint', () => {
    const result = parseSelectColumns(
      'id, author:users!author_id(name), editor:users!editor_id(name)',
    )
    expect(result.directColumns).toEqual(['id'])
    expect(result.relations).toHaveLength(2)
    expect(result.relations[0].fkColumn).toBe('author_id')
    expect(result.relations[1].fkColumn).toBe('editor_id')
  })

  it('parses * with relations', () => {
    const result = parseSelectColumns('*, author:users(name)')
    expect(result.directColumns).toEqual(['*'])
    expect(result.relations).toHaveLength(1)
  })

  it('rejects nested-of-nested at parse time', () => {
    expect(() =>
      parseSelectColumns('id, author:users(id, posts:posts(id))'),
    ).toThrow(`Nested relation in 'author:users(id, posts:posts(id))' not supported in v1`)
  })
})

describe('hasRelationSyntax', () => {
  it('returns true when a top-level relation segment is present', () => {
    expect(hasRelationSyntax('id, author:users(id, name)')).toBe(true)
  })

  it('returns false for plain column lists', () => {
    expect(hasRelationSyntax('id, title')).toBe(false)
    expect(hasRelationSyntax('*')).toBe(false)
  })

  it('returns false when colon appears without a matching relation pattern', () => {
    // Should not match a stray ":" — only the full alias:table(cols) pattern
    expect(hasRelationSyntax('id, foo')).toBe(false)
  })
})

describe('buildRelationSelect — many-to-one', () => {
  it('emits LATERAL with json_build_object and LIMIT 1', () => {
    const parsed = parseSelectColumns('id, title, author:users(id, name)')
    const result = buildRelationSelect('posts', 'public', parsed, SINGLE_FK, 1)

    expect(result.localAlias).toBe('"posts"')
    expect(result.selectClause).toContain('"posts"."id"')
    expect(result.selectClause).toContain('"posts"."title"')
    expect(result.selectClause).toContain('"author"."data" AS "author"')

    expect(result.joinClause).toContain('LEFT JOIN LATERAL')
    expect(result.joinClause).toContain('json_build_object($1::text, "author_t"."id", $2::text, "author_t"."name")')
    expect(result.joinClause).toContain('FROM "public"."users" AS "author_t"')
    expect(result.joinClause).toContain('"author_t"."id" = "posts"."author_id"')
    expect(result.joinClause).toContain('LIMIT 1')
    expect(result.joinClause).toContain('AS "author" ON true')

    expect(result.values).toEqual(['id', 'name'])
  })
})

describe('buildRelationSelect — one-to-many', () => {
  it('emits LATERAL with coalesce(json_agg(...), \'[]\'::json)', () => {
    const parsed = parseSelectColumns('id, name, posts:posts(id, title)')
    const result = buildRelationSelect('users', 'public', parsed, SINGLE_FK, 1)

    expect(result.localAlias).toBe('"users"')
    expect(result.selectClause).toContain('"users"."id"')
    expect(result.selectClause).toContain('"users"."name"')
    expect(result.selectClause).toContain('"posts"."data" AS "posts"')

    expect(result.joinClause).toContain(
      `coalesce(json_agg(json_build_object($1::text, "posts_t"."id", $2::text, "posts_t"."title")), '[]'::json)`,
    )
    expect(result.joinClause).toContain('FROM "public"."posts" AS "posts_t"')
    expect(result.joinClause).toContain('"posts_t"."author_id" = "users"."id"')
    // No LIMIT 1 for to-many
    expect(result.joinClause).not.toContain('LIMIT 1')

    expect(result.values).toEqual(['id', 'title'])
  })
})

describe('buildRelationSelect — * expansion', () => {
  it('expands * to all columns of the related table', () => {
    const parsed = parseSelectColumns('id, author:users(*)')
    const result = buildRelationSelect('posts', 'public', parsed, SINGLE_FK, 1)

    // users columns from cache: id, name, email
    expect(result.joinClause).toContain(
      `json_build_object($1::text, "author_t"."id", $2::text, "author_t"."name", $3::text, "author_t"."email")`,
    )
    expect(result.values).toEqual(['id', 'name', 'email'])
  })

  it('throws when related table is not in the schema cache', () => {
    const parsed = parseSelectColumns('tag:tags(*)')
    const cache: SchemaCache = {
      ...SINGLE_FK,
      foreignKeys: [
        {
          constraintName: 'posts_tag_fkey',
          fromTable: 'posts',
          fromColumn: 'tag_id',
          toTable: 'tags',
          toColumn: 'id',
        },
      ],
      // no entry for 'tags' in columns
    }
    expect(() => buildRelationSelect('posts', 'public', parsed, cache, 1)).toThrow(
      'Unknown table "tags" — schema cache miss',
    )
  })
})

describe('buildRelationSelect — error cases', () => {
  it('throws when no FK exists between the two tables', () => {
    const parsed = parseSelectColumns('tag:tags(name)')
    expect(() => buildRelationSelect('posts', 'public', parsed, SINGLE_FK, 1)).toThrow(
      'No foreign key found between "posts" and "tags"',
    )
  })

  it('throws on ambiguous FKs without a hint', () => {
    const parsed = parseSelectColumns('id, author:users(id, name)')
    expect(() => buildRelationSelect('posts', 'public', parsed, TWO_FKS, 1)).toThrow(
      /Ambiguous relation between "posts" and "users" — multiple foreign keys exist \(posts\.author_id, posts\.editor_id\)\. Use alias:table!<fk_column>\(\.\.\.\) to disambiguate\./,
    )
  })

  it('resolves ambiguity via !fkcol hint', () => {
    const parsed = parseSelectColumns('author:users!author_id(id, name)')
    const result = buildRelationSelect('posts', 'public', parsed, TWO_FKS, 1)
    expect(result.joinClause).toContain('"author_t"."id" = "posts"."author_id"')
    expect(result.joinClause).not.toContain('editor_id')
  })

  it('throws when !fkcol hint references a nonexistent FK column', () => {
    const parsed = parseSelectColumns('author:users!nope_id(id, name)')
    expect(() => buildRelationSelect('posts', 'public', parsed, TWO_FKS, 1)).toThrow(
      'No foreign key on column "nope_id" between "posts" and "users"',
    )
  })

  it('throws on composite foreign keys', () => {
    const parsed = parseSelectColumns('items:order_items(id)')
    expect(() => buildRelationSelect('orders', 'public', parsed, COMPOSITE_FK, 1)).toThrow(
      'Composite foreign keys not supported in v1',
    )
  })
})

describe('buildRelationSelect — paramOffset', () => {
  it('starts JSON-key placeholders at the supplied offset', () => {
    const parsed = parseSelectColumns('id, author:users(id, name)')
    const result = buildRelationSelect('posts', 'public', parsed, SINGLE_FK, 5)
    expect(result.joinClause).toContain('json_build_object($5::text, "author_t"."id", $6::text, "author_t"."name")')
    expect(result.values).toEqual(['id', 'name'])
  })
})
