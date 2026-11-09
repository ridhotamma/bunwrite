/**
 * Copy rows between a SQLite source and a Postgres target with the portable
 * column layout Bunwrite uses. Identifiers, dates, JSON and booleans are all
 * stored as text/integer on both sides, so the copy is a narrow, explicit
 * operation rather than a general-purpose database migrator.
 */
import type { BindValue, Dialect, SqlDatabase } from './driver'

export interface TableCopyReport {
  table: string
  rows: number
  columns: number
  missingColumns: string[]
}

export interface CopyOptions {
  batchSize?: number
  skip?: Set<string>
  log?: (line: string) => void
}

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`

const isSqlite = (dialect: Dialect) => dialect === 'sqlite'

/** User tables in the current schema, excluding SQLite internals and FTS shadows. */
export async function listTables(db: SqlDatabase): Promise<string[]> {
  if (isSqlite(db.dialect)) {
    const rows = await db.driver.all<{ name: string }>(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%__fts_%'
       ORDER BY name`,
    )
    return rows.map((row) => row.name)
  }
  const rows = await db.driver.all<{ name: string }>(
    `SELECT table_name AS name FROM information_schema.tables
     WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
     ORDER BY name`,
  )
  return rows.map((row) => row.name)
}

export async function columnsOf(db: SqlDatabase, table: string): Promise<string[]> {
  if (isSqlite(db.dialect)) {
    const rows = await db.driver.all<{ name: string }>(`PRAGMA table_info(${quote(table)})`)
    return rows.map((row) => row.name)
  }
  const rows = await db.driver.all<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = ?
     ORDER BY ordinal_position`,
    [table],
  )
  return rows.map((row) => row.column_name)
}

export async function rowCount(db: SqlDatabase, table: string): Promise<number> {
  const row = await db.driver.get<{ count: number }>(`SELECT count(*) AS count FROM ${quote(table)}`)
  return Number(row?.count) || 0
}

/** Non-empty tables in the target, ignoring the seeded version counters. */
export async function nonEmptyTables(target: SqlDatabase, ignore = new Set(['_meta'])): Promise<Array<{ table: string; rows: number }>> {
  const nonEmpty: Array<{ table: string; rows: number }> = []
  for (const table of await listTables(target)) {
    if (ignore.has(table)) continue
    const rows = await rowCount(target, table)
    if (rows > 0) nonEmpty.push({ table, rows })
  }
  return nonEmpty
}

/**
 * Copy one table, matching columns by name. The target rows are replaced. Rows
 * are read in keyset pages when the table has a `seq`/`_seq` identity, and in
 * ordered offset pages otherwise.
 */
export async function copyTable(source: SqlDatabase, target: SqlDatabase, table: string, options: CopyOptions = {}): Promise<TableCopyReport> {
  const sourceColumns = await columnsOf(source, table)
  const targetColumns = new Set(await columnsOf(target, table))
  const columns = sourceColumns.filter((column) => targetColumns.has(column))
  const missingColumns = sourceColumns.filter((column) => !targetColumns.has(column))
  if (missingColumns.length > 0) {
    throw new Error(
      `Target table ${table} is missing source column(s): ${missingColumns.join(', ')}. Update the target schema or use a newer Bunwrite version.`,
    )
  }
  if (columns.length === 0) return { table, rows: 0, columns: 0, missingColumns }
  const list = columns.map(quote).join(', ')
  const placeholders = columns.map(() => '?').join(', ')
  await target.driver.run(`DELETE FROM ${quote(table)}`)

  const key = columns.includes('seq') ? 'seq' : columns.includes('_seq') ? '_seq' : null
  const configured = Math.max(1, Math.round(options.batchSize ?? 500))
  const batchSize = Math.min(configured, Math.max(1, Math.floor(30_000 / columns.length)))
  let rows = 0
  let offset = 0
  let after: number | string | null = null
  for (;;) {
    let page: Array<Record<string, unknown>>
    if (key) {
      page = await source.driver.all<Record<string, unknown>>(
        after === null
          ? `SELECT ${list} FROM ${quote(table)} ORDER BY ${quote(key)} LIMIT ?`
          : `SELECT ${list} FROM ${quote(table)} WHERE ${quote(key)} > ? ORDER BY ${quote(key)} LIMIT ?`,
        after === null ? [batchSize] : [after, batchSize],
      )
    } else {
      page = await source.driver.all<Record<string, unknown>>(`SELECT ${list} FROM ${quote(table)} ORDER BY ${quote(columns[0]!)} LIMIT ? OFFSET ?`, [
        batchSize,
        offset,
      ])
      offset += page.length
    }
    if (page.length === 0) break
    const values: BindValue[] = []
    const tuples: string[] = []
    for (const row of page) {
      tuples.push(`(${placeholders})`)
      for (const column of columns) values.push((row[column] ?? null) as BindValue)
    }
    await target.driver.run(`INSERT INTO ${quote(table)} (${list}) VALUES ${tuples.join(', ')}`, values)
    rows += page.length
    if (key) after = page[page.length - 1]![key] as number | string
    if (page.length < batchSize) break
  }

  const sourceRows = await rowCount(source, table)
  const targetRows = await rowCount(target, table)
  if (sourceRows !== targetRows) {
    throw new Error(`Table ${table} copied ${targetRows} rows but the source has ${sourceRows}.`)
  }
  options.log?.(`  ${table}: ${rows.toLocaleString('en-US')} rows`)
  return { table, rows, columns: columns.length, missingColumns }
}

/**
 * Copy the intersection of source and target tables. `_meta` goes last so the
 * version triggers fired by document inserts cannot overwrite the source
 * counters. Tables present only in SQLite (FTS shadows) are ignored.
 */
export async function copyTables(source: SqlDatabase, target: SqlDatabase, options: CopyOptions = {}): Promise<TableCopyReport[]> {
  const targetTables = new Set(await listTables(target))
  const tables = (await listTables(source)).filter((table) => targetTables.has(table) && !options.skip?.has(table))
  tables.sort((a, b) => (a === '_meta' ? 1 : b === '_meta' ? -1 : a.localeCompare(b)))
  const reports: TableCopyReport[] = []
  for (const table of tables) reports.push(await copyTable(source, target, table, options))
  return reports
}

/** Advance every identity sequence past the copied rows. */
export async function resetSequences(target: SqlDatabase, schema: string, tables?: string[]): Promise<void> {
  const names = tables ?? (await listTables(target))
  for (const table of names) {
    const columns = new Set(await columnsOf(target, table))
    for (const column of ['seq', '_seq']) {
      if (!columns.has(column)) continue
      const qualified = `"${schema.replace(/"/g, '""')}"."${table.replace(/"/g, '""')}"`
      const row = await target.driver.get<{ sequence: string | null }>('SELECT pg_get_serial_sequence(?, ?) AS sequence', [qualified, column])
      const sequence = row?.sequence
      if (!sequence) continue
      await target.driver.run(`SELECT setval('${sequence.replace(/'/g, "''")}', COALESCE((SELECT max(${quote(column)}) FROM ${quote(table)}), 0) + 1, false)`)
    }
  }
}

/** Apply every copy report to a compact total for the CLI. */
export function reportTotals(reports: TableCopyReport[]): { tables: number; rows: number; missing: string[] } {
  return {
    tables: reports.length,
    rows: reports.reduce((sum, report) => sum + report.rows, 0),
    missing: [...new Set(reports.flatMap((report) => report.missingColumns.map((column) => `${report.table}.${column}`)))],
  }
}
