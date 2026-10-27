import { describe, expect, test } from 'bun:test'

import { requestEndpoint } from '~/lib/origins'
import { fileToken, validFileToken } from '~/storage/tokens'

const PROD = 'https://appwrite.pesanle.com/v1'
const req = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers })

describe('requestEndpoint', () => {
  test('uses localhost while developing, even when PUBLIC_ENDPOINT is the production domain', () => {
    expect(requestEndpoint(req('http://localhost:8080/console/storage'), PROD)).toBe('http://localhost:8080/v1')
    expect(requestEndpoint(req('http://127.0.0.1:8080/console'), PROD)).toBe('http://127.0.0.1:8080/v1')
  })

  test('uses the public domain behind a reverse proxy or Cloudflare', () => {
    const nginx = req('http://127.0.0.1:8080/console', { host: 'pesanle.com', 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.9' })
    expect(requestEndpoint(nginx, PROD)).toBe('https://pesanle.com/v1')
    const forwarded = req('http://127.0.0.1:8080/console', { 'x-forwarded-host': 'pesanle.com', 'x-forwarded-proto': 'https' })
    expect(requestEndpoint(forwarded, PROD)).toBe('https://pesanle.com/v1')
    const cloudflare = req('http://appwrite.pesanle.com/console', { 'cf-connecting-ip': '203.0.113.9', 'cf-visitor': '{"scheme":"https"}' })
    expect(requestEndpoint(cloudflare, PROD)).toBe(PROD)
  })

  test('falls back to PUBLIC_ENDPOINT when a proxy hides the host', () => {
    const hidden = req('http://127.0.0.1:8080/console', { 'x-forwarded-for': '203.0.113.9' })
    expect(requestEndpoint(hidden, PROD)).toBe(PROD)
    expect(requestEndpoint(req('http://localhost/console', { 'x-forwarded-host': 'bad host"><script>' }), PROD)).toBe(PROD)
    expect(requestEndpoint(req('http://localhost/console', { 'x-forwarded-host': 'a.com', 'x-forwarded-proto': 'javascript' }), PROD)).toBe(PROD)
  })
})

describe('file tokens', () => {
  const secret = 's'.repeat(40)

  test('open only the file they were signed for, until they expire', () => {
    const token = fileToken(secret, 'bucket', 'file')
    expect(validFileToken(token, secret, 'bucket', 'file')).toBe(true)
    expect(validFileToken(token, secret, 'bucket', 'other')).toBe(false)
    expect(validFileToken(token, secret, 'other', 'file')).toBe(false)
    expect(validFileToken(token, 'x'.repeat(40), 'bucket', 'file')).toBe(false)
    expect(validFileToken(token, secret, 'bucket', 'file', Date.now() + 25 * 3600 * 1000)).toBe(false)
  })

  test('reject malformed tokens and an empty secret', () => {
    expect(validFileToken('', secret, 'b', 'f')).toBe(false)
    expect(validFileToken('123.abc', secret, 'b', 'f')).toBe(false)
    expect(validFileToken(fileToken('', 'b', 'f'), '', 'b', 'f')).toBe(false)
  })
})
