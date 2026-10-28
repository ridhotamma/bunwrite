/**
 * Runs one Appwrite Node function execution in its own process:
 * `node runner-node.mjs <entrypoint>` (or `bun runner-node.mjs …`), request
 * JSON on stdin, result JSON on the last stdout line after RESULT_MARKER.
 * Mirrors the open-runtimes `context` (req, res, log, error) the functions
 * were written against.
 *
 * Plain JavaScript on purpose: it runs on the server's Bun, on a downloaded
 * Bun, and on any Node.js from 18 up, none of which may run TypeScript.
 */
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { format } from 'node:util'

const RESULT_MARKER = '__BUNWRITE_EXECUTION_RESULT__'

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

/** @param {string} entry */
export async function runNodeFunction(entry) {
  if (!entry) throw new Error('usage: runner-node.mjs <entrypoint>')

  /** @type {{ method: string, path: string, headers: Record<string, string>, body: string, bodyBase64?: string, host: string, scheme: string, port: number }} */
  const input = JSON.parse(await readStdin())
  /** @type {string[]} */
  const logs = []
  /** @type {string[]} */
  const errors = []
  const stdout = process.stdout.write.bind(process.stdout)

  // Whatever the function prints is its log, as on Appwrite.
  console.log = console.info = console.debug = (...args) => void logs.push(format(...args))
  console.warn = console.error = (...args) => void errors.push(format(...args))

  const [pathname, queryString = ''] = input.path.split('?')
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
      return input.bodyBase64 !== undefined ? Buffer.from(input.bodyBase64, 'base64') : Buffer.from(input.body)
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

  const res = {
    send: (body = '', statusCode = 200, headers = {}) => ({ body: String(body), statusCode, headers }),
    text: (body = '', statusCode = 200, headers = {}) => ({ body: String(body), statusCode, headers: { 'content-type': 'text/plain', ...headers } }),
    json: (obj, statusCode = 200, headers = {}) => ({ body: JSON.stringify(obj), statusCode, headers: { 'content-type': 'application/json', ...headers } }),
    binary: (bytes, statusCode = 200, headers = {}) => ({ body: Buffer.from(bytes).toString('latin1'), statusCode, headers }),
    empty: () => ({ body: '', statusCode: 204, headers: {} }),
    redirect: (url, statusCode = 301, headers = {}) => ({ body: '', statusCode, headers: { location: url, ...headers } }),
  }

  const context = {
    req,
    res,
    log: (...args) => void logs.push(args.map((a) => (typeof a === 'string' ? a : format('%o', a))).join(' ')),
    error: (...args) => void errors.push(args.map((a) => (typeof a === 'string' ? a : format('%o', a))).join(' ')),
  }

  let out
  try {
    const mod = await import(pathToFileURL(entry).href)
    const fn = typeof mod.default === 'function' ? mod.default : typeof mod === 'function' ? mod : (mod.default?.default ?? mod.main)
    if (typeof fn !== 'function') throw new Error(`${entry} does not export a function`)
    const result = await fn(context)
    out = result && typeof result === 'object' && 'statusCode' in result ? result : res.empty()
    if (!result) errors.push('Return statement missing. return context.res.empty() if no response is expected.')
  } catch (error) {
    errors.push(error instanceof Error ? (error.stack ?? error.message) : String(error))
    out = { body: '', statusCode: 500, headers: {} }
  }

  stdout(`\n${RESULT_MARKER}${JSON.stringify({ ...out, logs: logs.join('\n'), errors: errors.join('\n') })}\n`)
  process.exit(0)
}

/** True when this file is the script being run (Node before 24 has no import.meta.main). */
function isMain() {
  if (!process.argv[1]) return false
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]))
  } catch {
    return false
  }
}

if (isMain()) {
  const entry = process.argv[2]
  if (!entry) {
    console.error('usage: runner-node.mjs <entrypoint>')
    process.exit(1)
  }
  await runNodeFunction(entry)
}
