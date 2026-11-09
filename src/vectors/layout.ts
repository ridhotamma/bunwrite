/**
 * Reconstruct readable Markdown from positioned text.
 *
 * PDF.js and Tesseract both return text fragments with coordinates. This module
 * groups them into lines, detects headings from the relative font size, and
 * recognises simple aligned tables. It is deliberately heuristic: the goal is
 * useful RAG context, not a perfect layout reconstruction.
 */
import { markdownTable, normalizeText, tableCell } from './text'

export interface LayoutItem {
  text: string
  left: number
  top: number
  width: number
  height: number
  /** PDF.js font size; Tesseract has no equivalent. */
  fontSize?: number
  /** Provider line identifier, when the provider already grouped words. */
  lineGroup?: string
}

export interface LayoutOptions {
  tableExtraction: boolean
  headingDetection: boolean
}

export interface LayoutResult {
  text: string
  tables: number
  headings: number
}

interface Cell {
  text: string
  left: number
  width: number
}

interface Line {
  top: number
  height: number
  cells: Cell[]
  items: LayoutItem[]
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

function groupLines(items: LayoutItem[]): LayoutItem[][] {
  const grouped = new Map<string, LayoutItem[]>()
  const ungrouped: LayoutItem[] = []
  for (const item of items) {
    if (item.lineGroup) {
      const list = grouped.get(item.lineGroup) ?? []
      list.push(item)
      grouped.set(item.lineGroup, list)
    } else ungrouped.push(item)
  }
  const lines: LayoutItem[][] = [...grouped.values()].sort((a, b) => Math.min(...a.map((item) => item.top)) - Math.min(...b.map((item) => item.top)))
  if (ungrouped.length === 0) return lines

  ungrouped.sort((a, b) => a.top - b.top || a.left - b.left)
  let current: LayoutItem[] = []
  let currentTop = 0
  for (const item of ungrouped) {
    const tolerance = Math.max(2, Math.min(14, (item.height || item.fontSize || 10) * 0.6))
    if (current.length === 0 || Math.abs(item.top - currentTop) <= tolerance) {
      if (current.length === 0) currentTop = item.top
      current.push(item)
    } else {
      lines.push(current)
      current = [item]
      currentTop = item.top
    }
  }
  if (current.length > 0) lines.push(current)
  return lines.sort((a, b) => Math.min(...a.map((item) => item.top)) - Math.min(...b.map((item) => item.top)))
}

function toLine(items: LayoutItem[]): Line {
  const sorted = [...items].sort((a, b) => a.left - b.left)
  const size = median(sorted.map((item) => item.fontSize || item.height || 10))
  const gap = Math.max(12, size * 0.9)
  const cells: Cell[] = []
  for (const item of sorted) {
    const text = item.text.replace(/\s+/g, ' ').trim()
    if (!text) continue
    const previous = cells[cells.length - 1]
    const right = item.left + (item.width || 0)
    if (previous && item.left - (previous.left + previous.width) <= gap) {
      previous.text = `${previous.text} ${text}`.trim()
      previous.width = Math.max(previous.width, right - previous.left)
      continue
    }
    cells.push({ text, left: item.left, width: Math.max(item.width || 0, 1) })
  }
  return {
    top: Math.min(...sorted.map((item) => item.top)),
    height: Math.max(...sorted.map((item) => item.fontSize || item.height || 10)),
    cells,
    items: sorted,
  }
}

function heading(line: Line, bodySize: number): { level: number; text: string } | null {
  if (line.cells.length !== 1) return null
  const text = line.cells[0]!.text.trim()
  if (!text || text.length > 140) return null
  const size = line.height
  if (bodySize <= 0 || size < bodySize * 1.25) return null
  const level = size >= bodySize * 1.9 ? 1 : size >= bodySize * 1.55 ? 2 : size >= bodySize * 1.35 ? 3 : 4
  return { level, text }
}

function aligns(rows: Line[], tolerance: number): boolean {
  const base = rows[0]!.cells
  return rows.every((row) => row.cells.length === base.length && row.cells.every((cell, index) => Math.abs(cell.left - base[index]!.left) <= tolerance))
}

function tableRows(rows: Line[]): string[][] {
  return rows.map((row) => row.cells.map((cell) => tableCell(cell.text)))
}

function isTableCandidate(rows: Line[]): boolean {
  if (rows.length < 2 || rows.length > 200) return false
  if (rows[0]!.cells.length < 2 || rows[0]!.cells.length > 12) return false
  const columns = rows[0]!.cells.length
  if (rows.some((row) => row.cells.length !== columns)) return false
  if (rows.some((row) => row.cells.filter((cell) => cell.text.trim() !== '').length < 2)) return false
  const tolerance = Math.max(12, median(rows[0]!.cells.map((cell) => cell.width)) * 0.4)
  if (!aligns(rows, tolerance)) return false
  const short = rows.every((row) => row.cells.every((cell) => cell.text.length <= 90))
  const numeric = rows.some((row) => row.cells.some((cell) => /\d/.test(cell.text)))
  return rows.length >= 3 || (short && numeric) || (rows.length === 2 && rows.every((row) => row.cells.every((cell) => cell.text.length <= 45)))
}

export function layoutToMarkdown(items: LayoutItem[], options: LayoutOptions): LayoutResult {
  const lines = groupLines(items)
    .map(toLine)
    .filter((line) => line.cells.length > 0)
  if (lines.length === 0) return { text: '', tables: 0, headings: 0 }
  const bodySize = median(lines.map((line) => line.height))
  const out: string[] = []
  let tables = 0
  let headings = 0

  for (let index = 0; index < lines.length;) {
    if (options.tableExtraction && lines[index]!.cells.length >= 2) {
      let end = index + 1
      while (end < lines.length && isTableCandidate(lines.slice(index, end + 1))) end++
      const rows = lines.slice(index, end)
      if (rows.length >= 2 && isTableCandidate(rows)) {
        const markdown = markdownTable(tableRows(rows)).trim()
        if (markdown) {
          out.push(markdown)
          tables++
          index = end
          continue
        }
      }
    }

    const line = lines[index]!
    const title = options.headingDetection ? heading(line, bodySize) : null
    if (title) {
      out.push(`${'#'.repeat(title.level)} ${title.text}`)
      headings++
    } else out.push(line.cells.map((cell) => cell.text).join(' '))
    index++
  }

  return { text: normalizeText(out.join('\n\n')), tables, headings }
}
