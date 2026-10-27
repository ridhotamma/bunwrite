import { invalidStructure } from './errors'

let lastMicros = 0

/**
 * Appwrite-style unique ID: 8 hex chars of seconds, 5 of microseconds, then
 * random hex up to 20 chars. Sorts roughly by creation time, like Appwrite's.
 */
export function uniqueId(): string {
  let micros = Math.floor(performance.timeOrigin * 1000 + performance.now() * 1000)
  if (micros <= lastMicros) micros = lastMicros + 1
  lastMicros = micros
  const seconds = Math.floor(micros / 1_000_000)
  const fraction = micros % 1_000_000
  const head = seconds.toString(16).padStart(8, '0') + fraction.toString(16).padStart(5, '0')
  const bytes = crypto.getRandomValues(new Uint8Array(4))
  const tail = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 7)
  return head + tail
}

const CUSTOM_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,35}$/

/** Resolve a client-supplied ID: `unique()` becomes a fresh one, others are validated. */
export function resolveId(id: unknown, label = 'ID'): string {
  if (id === 'unique()' || id === undefined || id === null || id === '') return uniqueId()
  if (typeof id !== 'string' || !CUSTOM_ID.test(id)) {
    throw invalidStructure(
      `${label} must contain at most 36 chars. Valid chars are a-z, A-Z, 0-9, period, hyphen, and underscore. Can't start with a special char`,
    )
  }
  return id
}

export function isValidId(id: unknown): id is string {
  return typeof id === 'string' && CUSTOM_ID.test(id)
}

/** Random secret for sessions and tokens. */
export function randomSecret(bytes = 32): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString('hex')
}

export function sha256(value: string): string {
  return new Bun.CryptoHasher('sha256').update(value).digest('hex')
}
