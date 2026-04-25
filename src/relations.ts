import type { Sql } from 'postgres'
import { quoteIdent } from './filters.js'

export interface ForeignKey {
  constraintName: string
  fromTable: string
  fromColumn: string
  toTable: string
  toColumn: string
}

export interface SchemaCache {
  tables: string[]
  foreignKeys: ForeignKey[]
  columns: Record<string, string[]>
}

export async function introspectSchema(sql: Sql, schema: string): Promise<SchemaCache> {
  const tables = await sql<{ table_name: string }[]>`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = ${schema}
      AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `

  const fks = await sql<{
    constraint_name: string
    from_table: string
    from_column: string
    to_table: string
    to_column: string
  }[]>`
    SELECT
      tc.constraint_name,
      tc.table_name AS from_table,
      kcu.column_name AS from_column,
      ccu.table_name AS to_table,
      ccu.column_name AS to_column
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = tc.constraint_name
      AND ccu.table_schema = tc.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = ${schema}
  `

  const cols = await sql<{ table_name: string; column_name: string }[]>`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = ${schema}
    ORDER BY table_name, ordinal_position
  `

  const columns: Record<string, string[]> = {}
  for (const row of cols) {
    if (!columns[row.table_name]) columns[row.table_name] = []
    columns[row.table_name].push(row.column_name)
  }

  return {
    tables: tables.map(t => t.table_name),
    foreignKeys: fks.map(fk => ({
      constraintName: fk.constraint_name,
      fromTable: fk.from_table,
      fromColumn: fk.from_column,
      toTable: fk.to_table,
      toColumn: fk.to_column,
    })),
    columns,
  }
}

/**
 * Parse a Supabase-style select string with relations.
 * E.g. "id, title, author:users(id, name)" or "author:users!author_id(id, name)"
 */
export interface ParsedRelation {
  alias: string
  table: string
  fkColumn?: string
  columns: string[]
}

export interface ParsedSelect {
  directColumns: string[]
  relations: ParsedRelation[]
}

const RELATION_SEGMENT = /^(\w+):(\w+)(?:!(\w+))?\((.+)\)$/

export function parseSelectColumns(selectStr: string): ParsedSelect {
  const directColumns: string[] = []
  const relations: ParsedRelation[] = []

  const parts = splitTopLevel(selectStr)

  for (const rawPart of parts) {
    const part = rawPart.trim()
    if (!part) continue

    const relationMatch = part.match(RELATION_SEGMENT)
    if (relationMatch) {
      const [, alias, table, fkColumn, cols] = relationMatch
      // Reject nested-of-nested at parse time
      if (cols.includes('(') || cols.includes(':')) {
        throw new Error(`Nested relation in '${part}' not supported in v1`)
      }
      relations.push({
        alias,
        table,
        fkColumn: fkColumn || undefined,
        columns: cols.split(',').map(c => c.trim()).filter(Boolean),
      })
    } else {
      directColumns.push(part)
    }
  }

  return { directColumns, relations }
}

function splitTopLevel(str: string): string[] {
  const parts: string[] = []
  let current = ''
  let depth = 0

  for (const char of str) {
    if (char === '(') depth++
    if (char === ')') depth--
    if (char === ',' && depth === 0) {
      parts.push(current)
      current = ''
    } else {
      current += char
    }
  }
  if (current.trim()) parts.push(current)

  return parts
}

/**
 * Detect whether a select string contains any relation segments.
 * Cheap pre-check used by QueryBuilder to decide whether the schema cache is needed.
 */
export function hasRelationSyntax(selectStr: string): boolean {
  if (!selectStr.includes(':') || !selectStr.includes('(')) return false
  // More precise: any top-level segment that matches the relation pattern
  for (const part of splitTopLevel(selectStr)) {
    if (RELATION_SEGMENT.test(part.trim())) return true
  }
  return false
}

export interface RelationSelectResult {
  /** Full SELECT clause text (without leading "SELECT"). */
  selectClause: string
  /** Concatenated LEFT JOIN LATERAL clauses, or empty string. */
  joinClause: string
  /** Quoted alias to use for the local (parent) table. */
  localAlias: string
  /** Parameter values produced by JSON keys, in placeholder order. */
  values: unknown[]
}

/**
 * Build the SELECT clause + LATERAL JOIN clauses for a relation query.
 *
 * The local table is aliased with its own name (e.g. "posts"); each LATERAL subquery is
 * aliased with the user's chosen relation alias (e.g. "author"). The inner FROM uses
 * the suffix "_t" on the user alias to guarantee no collision with the outer scope.
 *
 * @param paramOffset The next available $N placeholder number for the outer query.
 */
export function buildRelationSelect(
  table: string,
  schema: string,
  parsed: ParsedSelect,
  cache: SchemaCache,
  paramOffset: number,
): RelationSelectResult {
  const localAlias = quoteIdent(table)
  const localQualified = `${quoteIdent(schema)}.${quoteIdent(table)}`
  const values: unknown[] = []
  let nextParam = paramOffset

  // Direct columns: qualify with local alias
  const selectParts: string[] = []
  for (const col of parsed.directColumns) {
    if (col === '*') {
      selectParts.push(`${localAlias}.*`)
    } else {
      selectParts.push(`${localAlias}.${quoteIdent(col)}`)
    }
  }

  const joinParts: string[] = []

  for (const rel of parsed.relations) {
    const fk = resolveForeignKey(table, rel, cache)
    const isManyToOne = fk.fromTable === table

    // Expand "*" against the schema cache for the related table
    let cols: string[]
    if (rel.columns.length === 1 && rel.columns[0] === '*') {
      const relCols = cache.columns[rel.table]
      if (!relCols) {
        throw new Error(`Unknown table "${rel.table}" — schema cache miss`)
      }
      cols = relCols
    } else {
      cols = rel.columns
    }

    const innerAlias = quoteIdent(rel.alias + '_t')
    const innerQualified = `${quoteIdent(schema)}.${quoteIdent(rel.table)}`
    const outerAlias = quoteIdent(rel.alias)

    // Build json_build_object(key1, val1, key2, val2, ...) — JSON keys parameterized.
    // The ::text cast is required so Postgres can resolve the polymorphic
    // json_build_object signature; without it the driver errors on $N type inference.
    const jsonArgs: string[] = []
    for (const col of cols) {
      values.push(col)
      jsonArgs.push(`$${nextParam++}::text`)
      jsonArgs.push(`${innerAlias}.${quoteIdent(col)}`)
    }
    const jsonObject = `json_build_object(${jsonArgs.join(', ')})`

    let subquery: string
    let joinCondition: string

    if (isManyToOne) {
      // FK on local table → relation table; one row per parent at most
      // Local has fk.fromColumn; related table has fk.toColumn
      joinCondition = `${innerAlias}.${quoteIdent(fk.toColumn)} = ${localAlias}.${quoteIdent(fk.fromColumn)}`
      subquery =
        `SELECT ${jsonObject} AS data ` +
        `FROM ${innerQualified} AS ${innerAlias} ` +
        `WHERE ${joinCondition} ` +
        `LIMIT 1`
    } else {
      // FK on relation table → local table; many rows per parent
      // Related has fk.fromColumn; local has fk.toColumn
      joinCondition = `${innerAlias}.${quoteIdent(fk.fromColumn)} = ${localAlias}.${quoteIdent(fk.toColumn)}`
      subquery =
        `SELECT coalesce(json_agg(${jsonObject}), '[]'::json) AS data ` +
        `FROM ${innerQualified} AS ${innerAlias} ` +
        `WHERE ${joinCondition}`
    }

    joinParts.push(`LEFT JOIN LATERAL (${subquery}) AS ${outerAlias} ON true`)
    selectParts.push(`${outerAlias}."data" AS ${outerAlias}`)
  }

  return {
    selectClause: selectParts.join(', '),
    joinClause: joinParts.join(' '),
    localAlias,
    values,
  }
}

function resolveForeignKey(
  localTable: string,
  rel: ParsedRelation,
  cache: SchemaCache,
): ForeignKey {
  // All FKs linking the two tables, in either direction
  const candidates = cache.foreignKeys.filter(
    fk =>
      (fk.fromTable === localTable && fk.toTable === rel.table) ||
      (fk.fromTable === rel.table && fk.toTable === localTable),
  )

  if (candidates.length === 0) {
    throw new Error(
      `No foreign key found between "${localTable}" and "${rel.table}"`,
    )
  }

  // Composite-FK detection: more than one row sharing the same constraintName
  // means the constraint spans multiple columns. Reject in v1.
  const byConstraint = new Map<string, number>()
  for (const fk of candidates) {
    byConstraint.set(fk.constraintName, (byConstraint.get(fk.constraintName) || 0) + 1)
  }
  for (const [, count] of byConstraint) {
    if (count > 1) {
      throw new Error(`Composite foreign keys not supported in v1`)
    }
  }

  // Apply the !fkcol hint if present — match the column on the FK's owning side
  let filtered = candidates
  if (rel.fkColumn) {
    filtered = candidates.filter(fk => fk.fromColumn === rel.fkColumn)
    if (filtered.length === 0) {
      throw new Error(
        `No foreign key on column "${rel.fkColumn}" between "${localTable}" and "${rel.table}"`,
      )
    }
  }

  if (filtered.length > 1) {
    const cols = filtered
      .map(fk => `${fk.fromTable}.${fk.fromColumn}`)
      .join(', ')
    throw new Error(
      `Ambiguous relation between "${localTable}" and "${rel.table}" — ` +
        `multiple foreign keys exist (${cols}). ` +
        `Use alias:table!<fk_column>(...) to disambiguate.`,
    )
  }

  return filtered[0]
}
