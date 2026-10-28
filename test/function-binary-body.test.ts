/**
 * A function's HTTP endpoint must hand over uploads byte for byte.
 *
 * Bytes that are not valid UTF-8 (images, PDFs, multipart bodies with files)
 * used to be read as text, so `req.bodyBinary` came out mangled. These check
 * that both runners see the exact bytes, and that text bodies still arrive as
 * text.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startServer, testSchema, type TestServer } from './helpers'

let dir: string
let server: TestServer

function fn(id: string, source: string, file = 'src/main.js') {
  mkdirSync(join(dir, 'functions', id, 'src'), { recursive: true })
  writeFileSync(join(dir, 'functions', id, file), source)
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'bunwrite-binary-'))
  fn(
    'bytes',
    `const { createHash } = require('node:crypto')
    module.exports = async (context) => context.res.json({
      length: context.req.bodyBinary.length,
      sha256: createHash('sha256').update(context.req.bodyBinary).digest('hex'),
      text: context.req.bodyText,
    })`,
  )
  fn(
    'pybytes',
    `import hashlib

async def main(context):
    data = context.req.body_binary
    return context.res.json({"length": len(data), "sha256": hashlib.sha256(data).hexdigest()})
`,
    'src/main.py',
  )
  server = startServer(
    {
      ...testSchema,
      functions: [
        { $id: 'bytes', name: 'Bytes', runtime: 'node-22', entrypoint: 'src/main.js', path: 'functions/bytes', execute: ['any'], timeout: 15 },
        { $id: 'pybytes', name: 'PyBytes', runtime: 'python-3.9', entrypoint: 'src/main.py', path: 'functions/pybytes', execute: ['any'], timeout: 15 },
      ],
    },
    {},
    dir,
  )
})

afterAll(() => {
  server.stop()
  rmSync(dir, { recursive: true, force: true })
})

/** Every byte value, including the ones that are never valid UTF-8. */
const upload = new Uint8Array(4096).map((_, i) => (i * 37 + 11) % 256)
const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')

describe('function HTTP endpoint request bodies', () => {
  test('a binary upload reaches a Node function byte for byte', async () => {
    const res = await fetch(`${server.endpoint}/functions/bytes/http/upload`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: upload,
    })
    expect(res.status).toBe(200)
    const out = (await res.json()) as any
    expect(out.length).toBe(upload.length)
    expect(out.sha256).toBe(sha256(upload))
  })

  test('a multipart form with a file survives', async () => {
    const form = new FormData()
    form.set('name', 'logo')
    form.set('file', new File([upload], 'logo.png', { type: 'image/png' }))
    const request = new Request('http://x', { method: 'POST', body: form })
    const body = new Uint8Array(await request.arrayBuffer())

    const res = await fetch(`${server.endpoint}/functions/bytes/http`, {
      method: 'POST',
      headers: { 'content-type': request.headers.get('content-type')! },
      body,
    })
    const out = (await res.json()) as any
    expect(out.length).toBe(body.length)
    expect(out.sha256).toBe(sha256(body))
  })

  test('text bodies still arrive as text', async () => {
    const res = await fetch(`${server.endpoint}/functions/bytes/http`, { method: 'POST', body: 'héllo ✓' })
    const out = (await res.json()) as any
    expect(out.text).toBe('héllo ✓')
    expect(out.length).toBe(new TextEncoder().encode('héllo ✓').length)
  })

  test('a Python function gets the same bytes', async () => {
    const res = await fetch(`${server.endpoint}/functions/pybytes/http`, { method: 'POST', body: upload })
    expect(res.status).toBe(200)
    const out = (await res.json()) as any
    expect(out).toEqual({ length: upload.length, sha256: sha256(upload) })
  })
})
