import { ERRORS } from './error-codes'

/** The Appwrite version this server reports in error bodies. */
export const APPWRITE_VERSION = '2.6.2'

/**
 * An error with Appwrite's wire shape: `{ message, code, type, version }`.
 *
 * `type` is one of Appwrite's error names (see error-codes.ts), which fixes the
 * HTTP status. `params` fill the `%s` placeholders in the default message.
 */
export class AppwriteError extends Error {
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
    return { message: this.message, code: this.code, type: this.type, version: APPWRITE_VERSION }
  }
}

export const err = (type: string, message?: string, params: unknown[] = []) =>
  new AppwriteError(type, message, params)

export const invalidQuery = (detail: string) =>
  new AppwriteError('general_query_invalid', `Invalid query: ${detail}`)

export const invalidStructure = (detail: string) =>
  new AppwriteError('document_invalid_structure', `Invalid document structure: ${detail}`)
