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

  return {
    tables: tables.map(t => t.table_name),
    foreignKeys: fks.map(fk => ({
      constraintName: fk.constraint_name,
      fromTable: fk.from_table,
      fromColumn: fk.from_column,
      toTable: fk.to_table,
      toColumn: fk.to_column,
    })),
  }
}

/**
 * Parse a Supabase-style select string with relations.
 * E.g. "id, title, author:users(id, name)"
 * Returns { directColumns, relations }
 */
export interface ParsedRelation {
  alias: string
  table: string
  columns: string[]
}

export interface ParsedSelect {
  directColumns: string[]
  relations: ParsedRelation[]
}

export function parseSelectColumns(selectStr: string): ParsedSelect {
  const directColumns: string[] = []
  const relations: ParsedRelation[] = []

  // Split by commas but respect parentheses
  const parts = splitTopLevel(selectStr)

  for (const part of parts) {
    const trimmed = part.trim()
    const relationMatch = trimmed.match(/^(\w+):(\w+)\((.+)\)$/)
    if (relationMatch) {
      const [, alias, table, cols] = relationMatch
      relations.push({
        alias,
        table,
        columns: cols.split(',').map(c => c.trim()),
      })
    } else {
      directColumns.push(trimmed)
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
 * Build a SELECT with JOINs for relation queries.
 */
export function buildRelationSelect(
  table: string,
  schema: string,
  parsed: ParsedSelect,
  foreignKeys: ForeignKey[],
): string {
  const mainTable = quoteIdent(schema) + '.' + quoteIdent(table)
  const mainAlias = quoteIdent(table)

  // Direct columns
  const selectParts: string[] = parsed.directColumns.map(col => {
    if (col === '*') return `${mainAlias}.*`
    return `${mainAlias}.${quoteIdent(col)}`
  })

  const joinParts: string[] = []

  for (const rel of parsed.relations) {
    const relAlias = quoteIdent(rel.alias)
    const relTable = quoteIdent(schema) + '.' + quoteIdent(rel.table)

    // Find FK from current table to relation table, or reverse
    const fk = foreignKeys.find(
      fk =>
        (fk.fromTable === table && fk.toTable === rel.table) ||
        (fk.fromTable === rel.table && fk.toTable === table),
    )

    if (!fk) {
      throw new Error(
        `No foreign key found between "${table}" and "${rel.table}"`,
      )
    }

    let joinCondition: string
    if (fk.fromTable === table) {
      // Current table has FK pointing to relation table
      joinCondition = `${mainAlias}.${quoteIdent(fk.fromColumn)} = ${relAlias}.${quoteIdent(fk.toColumn)}`
    } else {
      // Relation table has FK pointing to current table
      joinCondition = `${mainAlias}.${quoteIdent(fk.toColumn)} = ${relAlias}.${quoteIdent(fk.fromColumn)}`
    }

    joinParts.push(
      `LEFT JOIN ${relTable} AS ${relAlias} ON ${joinCondition}`,
    )

    for (const col of rel.columns) {
      selectParts.push(`${relAlias}.${quoteIdent(col)} AS ${quoteIdent(rel.alias + '_' + col)}`)
    }
  }

  return `SELECT ${selectParts.join(', ')} FROM ${mainTable} AS ${mainAlias} ${joinParts.join(' ')}`
}
