import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { verifyJwt, signJwt } from '~/auth/jwt'
import { unpackArchive } from '~/functions/deployments'
import { isPrivateEnv } from '~/lib/private-env'
import { parseScopedFunctionKey, scopedFunctionKey } from '~/lib/internal-key'
import { isSafeRelativePath, resolveInside } from '~/lib/paths'
import { assertPublicUrlShape } from '~/lib/net'
import { parseSearchParams } from '~/lib/http'
import { assertRedirect } from '~/lib/origins'

describe('request parsing hardening', () => {
  test('query strings cannot pollute Object.prototype', () => {
    const params = parseSearchParams(
      new URLSearchParams('__proto__[polluted]=yes&constructor[prototype][also]=yes&ok[value]=1&safe[]=a&safe[]=b'),
    )
    expect(Object.prototype.hasOwnProperty('polluted')).toBe(false)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(Object.prototype.hasOwnProperty('also')).toBe(false)
    expect(params.ok).toEqual({ value: '1' })
    expect(params.safe).toEqual(['a', 'b'])
  })

  test('paths must stay inside their root', () => {
    expect(isSafeRelativePath('src/main.js')).toBe(true)
    expect(isSafeRelativePath('../secret')).toBe(false)
    expect(isSafeRelativePath('/etc/passwd')).toBe(false)
    expect(isSafeRelativePath('a/../../b')).toBe(false)
    expect(isSafeRelativePath('a\\..\\b')).toBe(false)
    expect(resolveInside('/tmp/root', '../etc')).toBeNull()
    expect(resolveInside('/tmp/root', 'file.txt')).toBe('/tmp/root/file.txt')
  })

  test('wildcards never authorize a redirect that carries a token', () => {
    expect(() => assertRedirect('https://evil.example/cb', ['*'], 'success')).toThrow()
    expect(assertRedirect('https://app.example/cb', ['https://app.example'], 'success')).toBe('https://app.example/cb')
  })
})

describe('secret isolation', () => {
  test('host credential families never reach user code', () => {
    for (const key of [
      'VCS_GITHUB_PRIVATE_KEY',
      'VCS_GITHUB_CLIENT_SECRET',
      'DATABASE_URL',
      'AWS_SECRET_ACCESS_KEY',
      'OPENAI_API_KEY',
      'STRIPE_SECRET_KEY',
      'LITESTREAM_REPLICA_URL',
      'POSTHOG_API_KEY',
      'OTEL_EXPORTER_OTLP_HEADERS',
      'BACKUP_ENCRYPTION_KEY',
    ]) {
      expect(isPrivateEnv(key)).toBe(true)
    }
    for (const key of ['PATH', 'HOME', 'PUBLIC_NAME', 'NODE_ENV', 'PROJECT_NAME']) {
      expect(isPrivateEnv(key)).toBe(false)
    }
  })
})

describe('scoped function keys', () => {
  test('carry only the signed scopes and reject tampering', () => {
    const secret = 'secret-value'
    const key = scopedFunctionKey(secret, 'hello', ['users.read', 'documents.read', 'users.read'])
    expect(parseScopedFunctionKey(secret, key)).toEqual({ functionId: 'hello', scopes: ['documents.read', 'users.read'] })
    expect(parseScopedFunctionKey('another-secret', key)).toBeNull()
    expect(parseScopedFunctionKey(secret, `${key}x`)).toBeNull()
    expect(parseScopedFunctionKey(secret, 'not-a-function-key')).toBeNull()
  })

  test('JWT verification requires HS256 and a live exp', async () => {
    const token = await signJwt({ userId: 'u1', sessionId: 's1' }, 'secret', 60)
    expect(await verifyJwt(token, 'secret')).toMatchObject({ userId: 'u1', sessionId: 's1' })
    expect(await verifyJwt(token, 'wrong')).toBeNull()
    const [header, payload, signature] = token.split('.')
    const forged = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
    expect(await verifyJwt(`${forged}.${payload}.${signature}`, 'secret')).toBeNull()
    expect(header).toBeTruthy()
  })
})

describe('archive extraction', () => {
  test('a tar symlink is rejected instead of being followed', async () => {
    const work = mkdtempSync(join(tmpdir(), 'bunwrite-archive-'))
    try {
      const source = join(work, 'source')
      mkdirSync(source)
      writeFileSync(join(source, 'index.html'), 'hello')
      symlinkSync('/etc/passwd', join(source, 'leak'))
      const archive = join(work, 'payload.tar.gz')
      const tar = Bun.spawnSync(['tar', '-czf', archive, '-C', source, '.'])
      expect(tar.exitCode).toBe(0)
      const dest = join(work, 'dest')
      mkdirSync(dest)
      await expect(unpackArchive(archive, dest)).rejects.toThrow(/symbolic link|special file/)
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })
})

describe('outbound URLs', () => {
  test('literal loopback, metadata and internal names are refused', () => {
    for (const url of [
      'http://127.0.0.1:8080/x',
      'http://localhost/x',
      'http://169.254.169.254/latest/meta-data',
      'http://metadata.google.internal/computeMetadata/v1',
      'http://postgres:5432/x',
      'http://[::1]/x',
      'file:///etc/passwd',
    ]) {
      expect(() => assertPublicUrlShape(url)).toThrow()
    }
    expect(assertPublicUrlShape('https://example.com/hook').host).toBe('example.com')
  })
})
