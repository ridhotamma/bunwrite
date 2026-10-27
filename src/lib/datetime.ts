/**
 * Appwrite's datetime wire format: `2026-10-12T08:39:52.833+00:00`, always UTC
 * with millisecond precision. Stored in SQLite as the same string, so string
 * comparison and ordering match time order.
 */
export function formatDate(date: Date): string {
  return date.toISOString().replace('Z', '+00:00')
}

export function now(): string {
  return formatDate(new Date())
}

export function addSeconds(seconds: number, from = new Date()): string {
  return formatDate(new Date(from.getTime() + seconds * 1000))
}

const HAS_ZONE = /(Z|[+-]\d{2}:?\d{2})$/i

/**
 * Parse any datetime Appwrite accepts and normalise it. Strings without a
 * timezone are read as UTC, like Appwrite's PHP side does. Returns null when
 * the value is not a valid datetime.
 */
export function normalizeDate(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null
  let text = value.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) text += 'T00:00:00Z'
  else {
    text = text.replace(' ', 'T')
    if (!HAS_ZONE.test(text)) text += 'Z'
  }
  const date = new Date(text)
  if (Number.isNaN(date.getTime())) return null
  const year = date.getUTCFullYear()
  if (year < 0 || year > 9999) return null
  return formatDate(date)
}
