/** Shared text normalisation for document extraction and Markdown conversion. */

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function codePoint(number: number): string {
  return number >= 0 && number <= 0x10ffff ? String.fromCodePoint(number) : ''
}

export function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => codePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, number: string) => codePoint(Number(number)))
    .replace(/&([a-z]+);/gi, (match, name: string) => ENTITIES[name.toLowerCase()] ?? match)
}

export function normalizeText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replaceAll('\u0000', '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Collapse a value to one Markdown table cell. */
export function tableCell(value: string): string {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\|/g, '\\|')
}

export function markdownTable(rows: string[][]): string {
  if (rows.length === 0) return ''
  const columns = Math.max(...rows.map((row) => row.length))
  if (columns === 0) return ''
  const padded = rows.map((row) => [...row, ...Array<string>(columns - row.length).fill('')])
  const header = padded[0]!
  const lines = [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`, ...padded.slice(1).map((row) => `| ${row.join(' | ')} |`)]
  return `\n\n${lines.join('\n')}\n\n`
}
