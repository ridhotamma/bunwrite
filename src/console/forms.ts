/** Reading and normalising console form values. */
import type { S3Config } from '~/config'
import { err } from '~/lib/errors'

export type Form = Record<string, any>

/** Read a form body; repeated fields become arrays. GET and non-form bodies yield {}. */
export async function readForm(request: Request): Promise<Form> {
  if (request.method !== 'POST') return {}
  const type = request.headers.get('content-type') ?? ''
  if (!type.includes('form')) return {}
  const out: Form = {}
  for (const [key, value] of await request.formData()) {
    if (key in out) out[key] = ([] as unknown[]).concat(out[key], value)
    else out[key] = value
  }
  return out
}

/** A trimmed string field, empty when missing. */
export const value = (form: Form, key: string): string => String(form[key] ?? '').trim()

/** Checkbox-ish values, including Appwrite's string booleans. */
export const checked = (v: unknown): boolean => v === true || v === 'on' || v === 'true' || v === '1'

/** A newline- or comma-separated list, with blanks removed. */
export const lines = (v: unknown): string[] =>
  String(v ?? '')
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean)

/** One or many submitted values as strings. */
export const arrayOf = (v: unknown): string[] =>
  (Array.isArray(v) ? v : v === undefined || v === null || v === '' ? [] : [v]).map(String)

/** One or many submitted values, each a newline- or comma-separated list. */
export const arrayLines = (v: unknown): string[] => (Array.isArray(v) ? v : [v]).flatMap((one) => lines(one))

/** An optional number; blank means undefined. */
export function numberOrUndefined(v: unknown): number | undefined {
  return String(v ?? '').trim() === '' ? undefined : Number(v)
}

/** A whole, non-negative number for settings such as retention days; invalid input becomes 0. */
export function wholeNumber(v: unknown): number {
  const n = Math.round(Number(v ?? 0))
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** Parse a JSON object from a textarea, with a page-friendly error. */
export function parseJsonObject(raw: unknown, message: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(String(raw ?? '{}'))
  } catch {
    throw err('general_argument_invalid', message)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw err('general_argument_invalid', message)
  return parsed as Record<string, unknown>
}

/** Read S3 fields from a settings form, keeping the stored secret when the field is blank. */
export function s3FromForm(form: Record<string, any>, prefix: string, existing: S3Config): S3Config {
  const read = (suffix: string) => value(form, `${prefix}${suffix}`)
  const enabled = checked(form[`${prefix}Enabled`])
  const secret = String(form[`${prefix}Secret`] ?? '') || existing.secret
  const endpoint = read('Endpoint').replace(/\/$/, '')
  const config: S3Config = {
    enabled,
    bucket: read('Bucket'),
    region: read('Region'),
    endpoint,
    accessKey: read('AccessKey'),
    secret,
    forcePathStyle: checked(form[`${prefix}ForcePathStyle`]),
  }
  if (enabled) {
    if (!config.endpoint || !config.bucket || !config.region || !config.accessKey || !config.secret) {
      throw err('general_argument_invalid', 'Endpoint, bucket, region, access key and secret are required for S3 storage.')
    }
    let url: URL
    try {
      url = new URL(config.endpoint)
    } catch {
      throw err('general_argument_invalid', 'The S3 endpoint must be a valid URL.')
    }
    if (!['http:', 'https:'].includes(url.protocol)) throw err('general_argument_invalid', 'The S3 endpoint must use http or https.')
  }
  return config
}
