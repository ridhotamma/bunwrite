import { ERRORS } from './error-codes'

/** The API version reported in error bodies (Appwrite's, which the Appwrite SDKs expect). */
export const ERROR_VERSION = '2.6.2'

/**
 * An API error: `{ message, code, type, version }`, the shape the Appwrite SDKs
 * also read.
 *
 * `type` is one of the error names in error-codes.ts (Appwrite's), which fixes
 * the HTTP status. `params` fill the `%s` placeholders in the default message.
 */
export class BunwriteError extends Error {
  readonly type: string
  readonly code: number

  constructor(type: string, message?: string, params: unknown[] = []) {
    const known = ERRORS[type]
    let text = message ?? known?.[1] ?? 'Server Error'
    if (!message) for (const p of params) text = text.replace('%s', String(p))
    super(text)
    this.type = type
    this.code = known?.[0] ?? 500
  }

  toJSON() {
    return { message: this.message, code: this.code, type: this.type, version: ERROR_VERSION }
  }
}

export const err = (type: string, message?: string, params: unknown[] = []) =>
  new BunwriteError(type, message, params)

export const invalidQuery = (detail: string) =>
  new BunwriteError('general_query_invalid', `Invalid query: ${detail}`)

export const invalidStructure = (detail: string) =>
  new BunwriteError('document_invalid_structure', `Invalid document structure: ${detail}`)
