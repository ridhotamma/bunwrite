/**
 * Streamed function responses (`res.start`, `res.write*`, `res.end`): each
 * chunk must reach the client while the function is still running, as an LLM
 * proxy needs, and the execution record must still get the whole body.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { KEY, PROJECT, startServer, testSchema, type TestServer } from './helpers'

let dir: string
let server: TestServer

function fn(id: string, source: string, file = 'src/main.js') {
  mkdirSync(join(dir, 'functions', id, 'src'), { recursive: true })
  writeFileSync(join(dir, 'functions', id, file), source)
}

const sleep = 'const sleep = (ms) => new Promise((r) => setTimeout(r, ms))'

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'bunwrite-stream-'))
  fn(
    'sse',
    `${sleep}
    module.exports = async ({ res, log }) => {
      res.start(201, { 'content-type': 'text/event-stream', 'x-model': 'test' })
      res.writeText('data: one\\n\\n')
      await sleep(800)
      res.writeText('data: two\\n\\n')
      res.writeJson({ done: true })
      log('streamed')
      return res.end()
    }`,
  )
  fn(
    'plain',
    `${sleep}
    module.exports = async ({ res }) => {
      res.start(200, { 'content-type': 'text/plain' })
      for (const word of ['hello ', 'streamed ', 'world']) {
        res.writeText(word)
        await sleep(300)
      }
      return res.end()
    }`,
  )
  fn(
    'quiet',
    `${sleep}
    module.exports = async ({ res }) => {
      res.start(200, { 'content-type': 'text/plain' })
      res.writeText('thinking…')
      await sleep(2500)
      res.writeText(' done')
      return res.end()
    }`,
  )
  fn(
    'forever',
    `${sleep}
    module.exports = async ({ res }) => {
      res.start(200, { 'content-type': 'text/plain' })
      for (let i = 0; i < 100; i++) {
        res.writeText('tick ')
        await sleep(100)
      }
      return res.end()
    }`,
  )
  fn(
    'boom',
    `${sleep}
    module.exports = async ({ res }) => {
      res.start(200, { 'content-type': 'text/plain' })
      res.writeText('partial')
      await sleep(100)
      throw new Error('model went away')
    }`,
  )
  fn(
    'pystream',
    `import asyncio

async def main(context):
    print("a log line")
    context.res.start(200, {"content-type": "text/event-stream"})
    context.res.write_text("data: one\\n\\n")
    await asyncio.sleep(0.8)
    context.res.write_text("data: two\\n\\n")
    return context.res.end()
`,
    'src/main.py',
  )
  const def = (id: string, runtime = 'node-22', entrypoint = 'src/main.js') => ({ $id: id, name: id, runtime, entrypoint, path: `functions/${id}`, execute: ['any'], timeout: 15 })
  server = startServer(
    { ...testSchema, functions: [def('sse'), def('plain'), def('quiet'), def('forever'), def('boom'), def('pystream', 'python-3.9', 'src/main.py')] },
    {},
    dir,
    // Short, so the test can show a quiet stream outlives it.
    { idleTimeout: 1 },
  )
})

afterAll(() => {
  server.stop()
  rmSync(dir, { recursive: true, force: true })
})

/** Read a response body, noting when each chunk arrived. */
async function chunks(res: Response) {
  const started = performance.now()
  const out: { text: string; at: number }[] = []
  const decoder = new TextDecoder()
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) out.push({ text: decoder.decode(chunk, { stream: true }), at: performance.now() - started })
  return out
}

type Execution = { status: string; responseStatusCode: number; responseBody: string; logs: string; errors: string }

/**
 * The function's latest execution once it is recorded. The client's stream
 * closes at `res.end()`, a moment before the run finishes and writes its record.
 */
async function lastRun(functionId: string): Promise<Execution> {
  for (let i = 0; i < 50; i++) {
    const res = await fetch(`${server.endpoint}/functions/${functionId}/executions`, { headers: { 'x-appwrite-project': PROJECT, 'x-appwrite-key': KEY } })
    const [run] = ((await res.json()) as { executions: Execution[] }).executions
    if (run && run.status !== 'processing') return run
    await Bun.sleep(100)
  }
  throw new Error(`${functionId} never finished`)
}

describe('streamed function responses', () => {
  test('chunks reach the client while the function runs', async () => {
    const res = await fetch(`${server.endpoint}/functions/sse/http`)
    expect(res.status).toBe(201)
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    expect(res.headers.get('x-model')).toBe('test')
    const got = await chunks(res)
    expect(got.map((c) => c.text).join('')).toBe('data: one\n\ndata: two\n\n{"done":true}')
    // The first event came well before the function's 800 ms pause ended.
    expect(got[0]!.text).toBe('data: one\n\n')
    expect(got.at(-1)!.at - got[0]!.at).toBeGreaterThan(500)
  })

  test('the execution record keeps the whole streamed body and logs', async () => {
    const run = await lastRun('sse')
    expect(run.status).toBe('completed')
    expect(run.responseStatusCode).toBe(201)
    expect(run.responseBody).toBe('data: one\n\ndata: two\n\n{"done":true}')
    expect(run.logs).toBe('streamed')
  })

  test('gzip does not hold chunks back', async () => {
    const res = await fetch(`${server.endpoint}/functions/plain/http`, { headers: { 'accept-encoding': 'gzip' } })
    expect(res.headers.get('content-encoding')).toBe('gzip')
    const got = await chunks(res)
    expect(got.map((c) => c.text).join('')).toBe('hello streamed world')
    expect(got.length).toBeGreaterThanOrEqual(3)
  })

  test('a stream quieter than the idle timeout stays open', async () => {
    const res = await fetch(`${server.endpoint}/functions/quiet/http`)
    expect(await res.text()).toBe('thinking… done')
  })

  test('a function that throws mid-stream breaks the response off', async () => {
    // When the function fails before its headers reach the socket, the server
    // resets the connection instead of erroring the body; both break it off.
    const res = await fetch(`${server.endpoint}/functions/boom/http`).catch(() => null)
    if (res) {
      expect(res.status).toBe(200)
      expect(res.text()).rejects.toThrow()
    }
    const run = await lastRun('boom')
    expect(run.responseBody).toBe('partial')
    expect(run.errors).toContain('model went away')
  })

  test('a client that hangs up stops the function', async () => {
    const abort = new AbortController()
    const started = performance.now()
    const res = await fetch(`${server.endpoint}/functions/forever/http`, { signal: abort.signal })
    const reader = res.body!.getReader()
    await reader.read()
    abort.abort()
    const run = await lastRun('forever')
    // The function would run for 10 s on its own.
    expect(performance.now() - started).toBeLessThan(5000)
    expect(run.errors).toContain('client disconnected')
  })

  test('a sync execution of a streaming function returns the whole body', async () => {
    const res = await fetch(`${server.endpoint}/functions/plain/executions`, {
      method: 'POST',
      headers: { 'x-appwrite-project': PROJECT, 'x-appwrite-key': KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ async: false }),
    })
    const execution = (await res.json()) as { status: string; responseBody: string }
    expect(execution.status).toBe('completed')
    expect(execution.responseBody).toBe('hello streamed world')
  })

  test('Python functions stream the same way, and print() stays a log', async () => {
    const res = await fetch(`${server.endpoint}/functions/pystream/http`)
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    const got = await chunks(res)
    expect(got.map((c) => c.text).join('')).toBe('data: one\n\ndata: two\n\n')
    expect(got[0]!.text).toBe('data: one\n\n')
    expect((await lastRun('pystream')).logs).toBe('a log line')
  })
})
