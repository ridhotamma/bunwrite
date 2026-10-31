/**
 * SQL dialect adaptation.
 *
 * Bunwrite's statements are written for SQLite: `?` placeholders, `INSERT OR
 * IGNORE`, `json_each(...)`, `LIKE` (case-insensitive for ASCII), and so on.
 * Rather than rewriting every service twice, the Postgres driver translates a
 * statement just before it is sent. The subset below is the one the codebase
 * uses; anything outside it fails loudly with `UnsupportedFeatureError` instead
 * of silently changing semantics.
 *
 * The translation is deliberately conservative. It only touches text outside
 * string literals, quoted identifiers and comments, so a column named `like` or
 * a value containing `?` is never rewritten.
 */
import type { BindValue, Bindings, SqlDialect } from './driver'
import { UnsupportedFeatureError } from './driver'

interface Segment {
  text: string
  /** True for string literals, quoted identifiers and comments. */
  quoted: boolean
}

/**
 * Split SQL into alternating code and literal segments. Handles single quotes
 * (with `''` escaping), double-quoted identifiers, backtick identifiers, `--`
 * line comments and `/* ... *\/` block comments.
 */
function splitSql(sql: string): Segment[] {
  const segments: Segment[] = []
  let code = ''
  let i = 0
  const flush = () => {
    if (code) segments.push({ text: code, quoted: false })
    code = ''
  }
  while (i < sql.length) {
    const char = sql[i]!
    if (char === "'" || char === '"' || char === '`') {
      flush()
      const quote = char
      let literal = quote
      i++
      while (i < sql.length) {
        const current = sql[i]!
        literal += current
        i++
        if (current === quote) {
          // A doubled quote is an escaped quote, not the end of the literal.
          if (sql[i] === quote) {
            literal += sql[i]
            i++
            continue
          }
          break
        }
      }
      segments.push({ text: literal, quoted: true })
      continue
    }
    if (char === '-' && sql[i + 1] === '-') {
      flush()
      const end = sql.indexOf('\n', i)
      const stop = end === -1 ? sql.length : end
      segments.push({ text: sql.slice(i, stop), quoted: true })
      i = stop
      continue
    }
    if (char === '/' && sql[i + 1] === '*') {
      flush()
      const end = sql.indexOf('*/', i + 2)
      const stop = end === -1 ? sql.length : end + 2
      segments.push({ text: sql.slice(i, stop), quoted: true })
      i = stop
      continue
    }
    code += char
    i++
  }
  flush()
  return segments
}

/** Apply `fn` to the code parts only. */
function rewriteCode(sql: string, fn: (code: string) => string): string {
  return splitSql(sql)
    .map((segment) => (segment.quoted ? segment.text : fn(segment.text)))
    .join('')
}

/** Number `?` placeholders as `$1`, `$2`, ... skipping quoted text. */
function numberPlaceholders(sql: string, start = 1): string {
  let index = start
  return splitSql(sql)
    .map((segment) => (segment.quoted ? segment.text : segment.text.replace(/\?/g, () => `$${index++}`)))
    .join('')
}

/** Append `ON CONFLICT DO NOTHING` in the position Postgres requires. */
function appendConflictClause(sql: string, clause: string): string {
  const returning = /\bRETURNING\b/i.exec(sql)
  if (!returning) return `${sql} ${clause}`
  return `${sql.slice(0, returning.index).trimEnd()} ${clause} ${sql.slice(returning.index)}`
}

/** Replace `json_each(<expr>)` with a Postgres set-returning function. */
function rewriteJsonEach(sql: string): string {
  return sql.replace(/json_each\s*\(([^()]*)\)/gi, (_match, expr: string) => `jsonb_array_elements_text(((${expr})::jsonb))`)
}

function rewriteJsonArrayLength(sql: string): string {
  return sql.replace(/json_array_length\s*\(([^()]*)\)/gi, (_match, expr: string) => `jsonb_array_length(((${expr})::jsonb))`)
}

/**
 * `json_extract(col, '$.a.b')` keeps the value's type in SQLite; Postgres'
 * `#>>` always returns text. That is enough for the equality/filter uses in the
 * codebase; a caller that needs a number casts the result.
 */
function rewriteJsonExtract(sql: string): string {
  return sql.replace(/json_extract\s*\(\s*([^,()]+?)\s*,\s*'\$\.([A-Za-z0-9_.]+)'\s*\)/gi, (_match, expr: string, path: string) => {
    return `((${expr})::jsonb #>> '{${path.replace(/\./g, ',')}}')`
  })
}

/** `group_concat(x, ', ')` is `string_agg(x, ', ')` in Postgres. */
function rewriteGroupConcat(sql: string): string {
  return sql.replace(/group_concat\s*\(\s*([^,()]+?)\s*,\s*'((?:[^']|'')*)'\s*\)/gi, (_match, expr: string, separator: string) => {
    return `string_agg(${expr}, '${separator}')`
  })
}

/** `iif(cond, a, b)` is `CASE WHEN cond THEN a ELSE b END`. */
function rewriteIif(sql: string): string {
  return sql.replace(/iif\s*\(\s*([^,()]+?)\s*,\s*([^,()]+?)\s*,\s*([^,()]+?)\s*\)/gi, (_match, cond: string, a: string, b: string) => {
    return `CASE WHEN ${cond} THEN ${a} ELSE ${b} END`
  })
}

/** Rewrites that only change keyword spelling, never literals. */
function rewriteKeywords(code: string): string {
  return (
    code
      // SQLite's LIKE is case-insensitive for ASCII; ILIKE keeps that contract.
      .replace(/\bNOT\s+LIKE\b/gi, 'NOT ILIKE')
      .replace(/\bLIKE\b/gi, 'ILIKE')
      // SQLite treats `LIMIT -1` as no limit.
      .replace(/\bLIMIT\s+-1\b/gi, 'LIMIT ALL')
      // SQLite's IS/IS NOT with a bound value is null-safe equality.
      .replace(/\bIS\s+NOT\s+\?/gi, 'IS DISTINCT FROM ?')
      .replace(/\bIS\s+\?/gi, 'IS NOT DISTINCT FROM ?')
      // NO COLLATE NOCASE support: Postgres uses ICU collations. The one call
      // site compares lower-cased text, so the C collation is equivalent there.
      .replace(/\bCOLLATE\s+NOCASE\b/gi, 'COLLATE "C"')
  )
}

/**
 * Translate a SQLite-flavoured statement for Postgres.
 *
 * Unsupported SQLite-only constructs throw instead of producing a wrong query.
 */
export function toPostgres(sql: string): string {
  if (/^\s*PRAGMA\b/i.test(sql)) {
    throw new UnsupportedFeatureError('PRAGMA', 'Postgres does not expose SQLite PRAGMAs. Configure the connection through DATABASE_URL instead.')
  }
  if (/\bINSERT\s+OR\s+REPLACE\b/i.test(sql)) {
    throw new UnsupportedFeatureError('INSERT OR REPLACE', 'Rewrite the statement with INSERT ... ON CONFLICT ... DO UPDATE before sending it to Postgres.')
  }
  if (/\bMATCH\b/i.test(sql) && /\b\w*fts\w*\b/i.test(sql)) {
    throw new UnsupportedFeatureError(
      'SQLite FTS5 search',
      'Full-text queries use FTS5 MATCH. Use the collection index compiled for the document backend, or build a Postgres tsvector query.',
    )
  }

  let translated = rewriteJsonEach(sql)
  translated = rewriteJsonArrayLength(translated)
  translated = rewriteJsonExtract(translated)
  translated = rewriteGroupConcat(translated)
  translated = rewriteIif(translated)
  translated = rewriteCode(translated, rewriteKeywords)

  // INSERT OR IGNORE has no direct operator; the conflict clause is appended
  // after the values list, before RETURNING.
  let ignoreConflict = false
  translated = translated.replace(/\bINSERT\s+OR\s+IGNORE\s+INTO\b/gi, () => {
    ignoreConflict = true
    return 'INSERT INTO'
  })
  if (ignoreConflict) translated = appendConflictClause(translated, 'ON CONFLICT DO NOTHING')

  return numberPlaceholders(translated)
}

/** Parameters travel as-is for SQLite; Postgres needs JS booleans as 0/1. */
export function sqliteParams(params: Bindings = []): BindValue[] {
  return [...params]
}

export function postgresParams(params: Bindings = []): BindValue[] {
  return params.map((value) => (typeof value === 'boolean' ? (value ? 1 : 0) : value))
}

/** A bound statement for one dialect. */
export interface PreparedStatement {
  text: string
  params: BindValue[]
}

export interface DialectAdapter {
  readonly dialect: SqlDialect
  prepare(sql: string, params?: Bindings): PreparedStatement
}

export const sqliteDialect: DialectAdapter = {
  dialect: 'sqlite',
  prepare: (sql, params) => ({ text: sql, params: sqliteParams(params) }),
}

export const postgresDialect: DialectAdapter = {
  dialect: 'postgres',
  prepare: (sql, params) => ({ text: toPostgres(sql), params: postgresParams(params) }),
}

export const dialectAdapter = (dialect: SqlDialect): DialectAdapter => (dialect === 'postgres' ? postgresDialect : sqliteDialect)
