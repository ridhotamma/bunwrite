/**
 * Runs one Appwrite Node function execution in its own process:
 * `bun runner-node.ts <entrypoint>`, request JSON on stdin, result JSON on the
 * last stdout line after RESULT_MARKER. Mirrors the open-runtimes `context`
 * (req, res, log, error) the functions were written against.
 */
import { format } from 'node:util'

const RESULT_MARKER = '__APPWRITE_EXECUTION_RESULT__'

interface Input {
  method: string
  path: string
  headers: Record<string, string>
  body: string
  host: string
  scheme: string
  port: number
}

const entry = process.argv[2]
if (!entry) throw new Error('usage: runner-node.ts <entrypoint>')

const input = JSON.parse(await Bun.stdin.text()) as Input
const logs: string[] = []
const errors: string[] = []
const stdout = process.stdout.write.bind(process.stdout)

// Whatever the function prints is its log, as on Appwrite.
console.log = console.info = console.debug = (...args: unknown[]) => void logs.push(format(...args))
console.warn = console.error = (...args: unknown[]) => void errors.push(format(...args))

const [pathname, queryString = ''] = input.path.split('?') as [string, string?]
const query = Object.fromEntries(new URLSearchParams(queryString))
const contentType = (input.headers['content-type'] ?? '').toLowerCase()

const req = {
  method: input.method,
  scheme: input.scheme,
  host: input.host,
  port: input.port,
  path: pathname,
  queryString,
  query,
  headers: input.headers,
  url: `${input.scheme}://${input.host}${input.path}`,
  bodyRaw: input.body,
  bodyText: input.body,
  get bodyBinary() {
    return Buffer.from(input.body)
  },
  get bodyJson() {
    return input.body ? JSON.parse(input.body) : {}
  },
  /** JSON bodies arrive parsed, everything else as text (open-runtimes v4). */
  get body() {
    if (contentType.startsWith('application/json')) {
      try {
        return input.body ? JSON.parse(input.body) : {}
      } catch {
        return input.body
      }
    }
    return input.body
  },
}

interface Out {
  body: string
  statusCode: number
  headers: Record<string, string>
}

const res = {
  send: (body: unknown = '', statusCode = 200, headers: Record<string, string> = {}): Out => ({ body: String(body), statusCode, headers }),
  text: (body: unknown = '', statusCode = 200, headers: Record<string, string> = {}): Out => ({ body: String(body), statusCode, headers: { 'content-type': 'text/plain', ...headers } }),
  json: (obj: unknown, statusCode = 200, headers: Record<string, string> = {}): Out => ({
    body: JSON.stringify(obj),
    statusCode,
    headers: { 'content-type': 'application/json', ...headers },
  }),
  binary: (bytes: Uint8Array, statusCode = 200, headers: Record<string, string> = {}): Out => ({ body: Buffer.from(bytes).toString('latin1'), statusCode, headers }),
  empty: (): Out => ({ body: '', statusCode: 204, headers: {} }),
  redirect: (url: string, statusCode = 301, headers: Record<string, string> = {}): Out => ({ body: '', statusCode, headers: { location: url, ...headers } }),
}

const context = {
  req,
  res,
  log: (...args: unknown[]) => void logs.push(args.map((a) => (typeof a === 'string' ? a : format('%o', a))).join(' ')),
  error: (...args: unknown[]) => void errors.push(args.map((a) => (typeof a === 'string' ? a : format('%o', a))).join(' ')),
}

let out: Out
try {
  const mod = await import(entry)
  const fn = typeof mod.default === 'function' ? mod.default : typeof mod === 'function' ? mod : mod.default?.default ?? mod.main
  if (typeof fn !== 'function') throw new Error(`${entry} does not export a function`)
  const result = await fn(context)
  out = result && typeof result === 'object' && 'statusCode' in result ? (result as Out) : res.empty()
  if (!result) errors.push('Return statement missing. return context.res.empty() if no response is expected.')
} catch (error) {
  errors.push(error instanceof Error ? (error.stack ?? error.message) : String(error))
  out = { body: '', statusCode: 500, headers: {} }
}

stdout(`\n${RESULT_MARKER}${JSON.stringify({ ...out, logs: logs.join('\n'), errors: errors.join('\n') })}\n`)
process.exit(0)
