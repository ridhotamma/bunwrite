/**
 * API_COMPAT: the names the server sends (session cookies, webhook headers,
 * function variables) follow the mode, and both families of request headers
 * and cookies work in either mode, from the Bunwrite SDK and the Appwrite SDK.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as appwrite from 'node-appwrite'

import { Client, Databases, Functions, ID, InputFile, Query, Users, Webhooks } from '../packages/sdk/src'
import { packGzip } from '../packages/cli/src/tar'
import { configFromEnv } from '~/config'
import { parseApiCompat, type ApiCompat } from '~/lib/compat'
import { DB, KEY, PROJECT, startServer, type TestServer } from './helpers'

setDefaultTimeout(60_000)

test('API_COMPAT defaults to bunwrite and refuses unknown values', () => {
  expect(configFromEnv({}).apiCompat).toBe('bunwrite')
  expect(configFromEnv({ API_COMPAT: 'Appwrite' }).apiCompat).toBe('appwrite')
  expect(() => parseApiCompat('firebase')).toThrow('API_COMPAT must be one of bunwrite, appwrite')
})

/** A function that reports which variables it got. */
const ENV_FUNCTION = `module.exports = async (context) => context.res.json({
  bunwrite: process.env.BUNWRITE_FUNCTION_ID ?? null,
  appwrite: process.env.APPWRITE_FUNCTION_ID ?? null,
  key: Boolean(process.env.BUNWRITE_API_KEY),
})`

for (const mode of ['bunwrite', 'appwrite'] as ApiCompat[]) {
  const other = mode === 'bunwrite' ? 'appwrite' : 'bunwrite'
  const sessionPrefix = mode === 'bunwrite' ? 'bw_session_' : 'a_session_'
  const otherPrefix = mode === 'bunwrite' ? 'a_session_' : 'bw_session_'

  describe(`API_COMPAT=${mode}`, () => {
    let server: TestServer
    let storage: string
    let receiver: ReturnType<typeof Bun.serve>
    const deliveries: Headers[] = []

    beforeAll(async () => {
      storage = mkdtempSync(join(tmpdir(), `bunwrite-compat-${mode}-`))
      server = startServer(undefined, { storagePath: storage, apiCompat: mode })
      receiver = Bun.serve({
        port: 0,
        fetch(request) {
          deliveries.push(request.headers)
          return new Response('ok')
        },
      })
      await new Users(admin()).create({ userId: 'compat', email: 'compat@example.com', password: 'correct horse battery' })
    })

    afterAll(() => {
      receiver.stop(true)
      server.stop()
      rmSync(storage, { recursive: true, force: true })
    })

    const admin = () => new Client().setEndpoint(server.endpoint).setProject(PROJECT).setKey(KEY)

    /**
     * Sign in like a browser: no key, so the session comes back as a cookie. The project goes in
     * `X-Bunwrite-Project`, `X-Appwrite-Project`, or (`query`) only in the query string.
     */
    async function browserSignIn(naming: ApiCompat | 'query'): Promise<{ setCookie: string; fallback: Record<string, string> }> {
      const query = naming === 'query' ? `?project=${PROJECT}` : ''
      const response = await fetch(`${server.endpoint}/account/sessions/email${query}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(naming === 'query' ? {} : { [`x-${naming}-project`]: PROJECT }) },
        body: JSON.stringify({ email: 'compat@example.com', password: 'correct horse battery' }),
      })
      expect(response.status).toBe(201)
      return { setCookie: response.headers.get('set-cookie') ?? '', fallback: JSON.parse(response.headers.get('x-fallback-cookies') ?? '{}') }
    }

    test('a session cookie follows the naming of the request; without a project header, the mode', async () => {
      expect((await browserSignIn('bunwrite')).setCookie).toStartWith(`bw_session_${PROJECT}=`)
      expect((await browserSignIn('appwrite')).setCookie).toStartWith(`a_session_${PROJECT}=`)
      expect((await browserSignIn('query')).setCookie).toStartWith(`${sessionPrefix}${PROJECT}=`)
    })

    test('either session cookie name is accepted, also in X-Fallback-Cookies', async () => {
      const { fallback } = await browserSignIn('query')
      const secret = fallback[`${sessionPrefix}${PROJECT}`]!
      expect(secret).toBeString()

      for (const name of [sessionPrefix, otherPrefix]) {
        const response = await fetch(`${server.endpoint}/account`, { headers: { 'x-bunwrite-project': PROJECT, cookie: `${name}${PROJECT}=${secret}` } })
        expect([name, response.status]).toEqual([name, 200])
      }
      const viaFallback = await fetch(`${server.endpoint}/account`, {
        headers: { 'x-appwrite-project': PROJECT, 'x-fallback-cookies': JSON.stringify({ [`${otherPrefix}${PROJECT}`]: secret }) },
      })
      expect(viaFallback.status).toBe(200)
    })

    test('the Bunwrite SDK (X-Bunwrite-*) and the Appwrite SDK (X-Appwrite-*) both work', async () => {
      await new Databases(admin()).createDocument({ databaseId: DB, collectionId: 'notes', documentId: 'mine', data: { text: 'from bunwrite sdk' } })
      const theirs = new appwrite.Databases(new appwrite.Client().setEndpoint(server.endpoint).setProject(PROJECT).setKey(KEY))
      expect((await theirs.getDocument({ databaseId: DB, collectionId: 'notes', documentId: 'mine' })).text).toBe('from bunwrite sdk')
      await theirs.createDocument({ databaseId: DB, collectionId: 'notes', documentId: 'theirs', data: { text: 'from appwrite sdk' } })
      const both = await new Databases(admin()).listDocuments({ databaseId: DB, collectionId: 'notes', queries: [Query.orderAsc('$id')] })
      expect(both.documents.map((d) => d.$id)).toEqual(['mine', 'theirs'])
    })

    test('a raw request may mix the two families', async () => {
      const response = await fetch(`${server.endpoint}/databases/${DB}/collections/notes/documents`, {
        headers: { 'x-bunwrite-project': PROJECT, 'x-appwrite-key': KEY },
      })
      expect(response.status).toBe(200)
    })

    test('an empty header in one family falls through to the other, or to ?project=', async () => {
      const viaHeader = await fetch(`${server.endpoint}/databases/${DB}/collections/notes/documents`, {
        headers: { 'x-bunwrite-project': '', 'x-bunwrite-key': '', 'x-appwrite-project': PROJECT, 'x-appwrite-key': KEY },
      })
      expect(viaHeader.status).toBe(200)
      const viaQuery = await fetch(`${server.endpoint}/databases/${DB}/collections/notes/documents?project=${PROJECT}`, {
        headers: { 'x-bunwrite-project': '', 'x-appwrite-key': KEY },
      })
      expect(viaQuery.status).toBe(200)
    })

    test('the same header with two different values is refused', async () => {
      const projects = await fetch(`${server.endpoint}/databases/${DB}/collections/notes/documents`, {
        headers: { origin: 'http://localhost:3000', 'x-bunwrite-project': PROJECT, 'x-appwrite-project': 'other', 'x-appwrite-key': KEY },
      })
      expect(projects.status).toBe(400)
      expect(projects.headers.get('access-control-allow-origin')).toBe('http://localhost:3000')
      expect(((await projects.json()) as any).type).toBe('general_bad_request')

      const keys = await fetch(`${server.endpoint}/databases/${DB}/collections/notes/documents`, {
        headers: { 'x-bunwrite-project': PROJECT, 'x-bunwrite-key': KEY, 'x-appwrite-key': 'wrong' },
      })
      expect(keys.status).toBe(400)

      // The same value in both families is fine: they agree, so nothing is ambiguous.
      const same = await fetch(`${server.endpoint}/databases/${DB}/collections/notes/documents`, {
        headers: { 'x-bunwrite-project': PROJECT, 'x-appwrite-project': PROJECT, 'x-bunwrite-key': KEY, 'x-appwrite-key': KEY },
      })
      expect(same.status).toBe(200)
    })

    test(`webhooks are delivered with X-${mode === 'bunwrite' ? 'Bunwrite' : 'Appwrite'}-Webhook-* headers`, async () => {
      await new Webhooks(admin()).create({ webhookId: 'hook', name: 'Hook', url: `http://localhost:${receiver.port}/`, events: [`databases.${DB}.collections.notes.documents.*.create`] })
      deliveries.length = 0
      await new Databases(admin()).createDocument({ databaseId: DB, collectionId: 'notes', documentId: ID.unique(), data: { text: 'hi' } })
      await server.services.webhooks.idle()
      expect(deliveries).toHaveLength(1)
      const headers = deliveries[0]!
      expect(headers.get(`x-${mode}-webhook-id`)).toBe('hook')
      expect(headers.get(`x-${mode}-webhook-signature`)).toBeString()
      expect(headers.get(`x-${other}-webhook-id`)).toBeNull()
    })

    test(mode === 'bunwrite' ? 'functions get BUNWRITE_* variables only' : 'functions get APPWRITE_* and BUNWRITE_* variables', async () => {
      const functions = new Functions(admin())
      await functions.create({ functionId: 'env', name: 'Env', runtime: 'node-22' as any, entrypoint: 'main.js', execute: ['any'] })
      let deployment = await functions.createDeployment({
        functionId: 'env',
        code: InputFile.fromBuffer(packGzip([{ path: 'main.js', data: new TextEncoder().encode(ENV_FUNCTION) }]), 'code.tar.gz'),
        activate: true,
      })
      while (!['ready', 'failed'].includes(deployment.status as string)) {
        await Bun.sleep(100)
        deployment = await functions.getDeployment({ functionId: 'env', deploymentId: deployment.$id })
      }
      expect(deployment.status as string).toBe('ready')
      const run = await functions.createExecution({ functionId: 'env' })
      expect(JSON.parse(run.responseBody)).toEqual({ bunwrite: 'env', appwrite: mode === 'appwrite' ? 'env' : null, key: true })
    })

    test('CORS lets browsers send either family', async () => {
      const response = await fetch(`${server.endpoint}/account`, {
        method: 'OPTIONS',
        headers: { origin: 'http://localhost:3000', 'access-control-request-method': 'GET', 'access-control-request-headers': 'x-bunwrite-project' },
      })
      const allowed = response.headers.get('access-control-allow-headers') ?? ''
      expect(allowed).toContain('X-Bunwrite-Project')
      expect(allowed).toContain('X-Appwrite-Project')
    })

    test('the console session cookie follows the request naming too, and admin mode takes either', async () => {
      const { ConsoleAuth } = await import('~/console/auth')
      await new ConsoleAuth(server.db).upsert('compat-admin@example.com', 'admin-password')
      const signIn = async (naming: ApiCompat) => {
        const response = await fetch(`${server.endpoint}/account/sessions/email`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', [`x-${naming}-project`]: 'console' },
          body: JSON.stringify({ email: 'compat-admin@example.com', password: 'admin-password' }),
        })
        expect(response.status).toBe(201)
        return (response.headers.get('set-cookie') ?? '').split(';')[0]!
      }
      expect(await signIn('appwrite')).toStartWith('a_session_console=')
      const cookie = await signIn('bunwrite')
      expect(cookie).toStartWith('bw_session_console=')
      // Admin mode works with either header name and either cookie name.
      const secret = cookie.split('=')[1]
      for (const [modeHeader, name] of [
        ['x-bunwrite-mode', otherPrefix],
        ['x-appwrite-mode', sessionPrefix],
      ]) {
        const buckets = await fetch(`${server.endpoint}/storage/buckets`, { headers: { 'x-bunwrite-project': PROJECT, [modeHeader!]: 'admin', cookie: `${name}console=${secret}` } })
        expect(buckets.status).toBe(200)
      }
    })
  })
}

describe('the Appwrite CLI against the default (bunwrite) naming', () => {
  test('signs in, links the project and pulls', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bunwrite-compat-cli-'))
    const server = startServer(undefined, { storagePath: join(root, 'storage'), apiCompat: 'bunwrite' })
    try {
      const { ConsoleAuth } = await import('~/console/auth')
      await new ConsoleAuth(server.db).upsert('cli-compat@example.com', 'admin-password')
      const home = join(root, 'home')
      const dir = join(root, 'project')
      const bin = join(root, 'bin')
      for (const d of [join(home, '.config', 'appwrite'), dir, bin]) mkdirSync(d, { recursive: true })
      // No git clone of Appwrite's agent skills, no npm update check.
      writeFileSync(join(bin, 'git'), '#!/bin/sh\nexit 1\n')
      chmodSync(join(bin, 'git'), 0o755)
      const stamp = new Date().toISOString()
      writeFileSync(join(home, '.config', 'appwrite', 'update-check.json'), JSON.stringify({ checkedAt: stamp, latest: '22.0.0', notifiedAt: stamp }))
      const cli = join(import.meta.dir, '..', 'node_modules', 'appwrite-cli', 'dist', 'cli.cjs')
      const run = async (args: string[], stdin = '') => {
        const proc = Bun.spawn(['bun', cli, ...args], {
          cwd: dir,
          env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), PATH: `${bin}:${process.env.PATH}`, NO_COLOR: '1' },
          stdin: new Blob([stdin]),
          stdout: 'pipe',
          stderr: 'pipe',
        })
        const [out, errOut, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
        return { code, out: out + errOut }
      }
      expect((await run(['login', '--email', 'cli-compat@example.com', '--password', 'admin-password', '--endpoint', server.endpoint])).out).toContain('Successfully signed in')
      expect((await run(['whoami'])).out).toContain('cli-compat@example.com')
      await run(['init', 'project', '--organization-id', 'org_test', '--project-id', PROJECT, '--project-name', 'x'], 'n\n')
      expect((await run(['pull', 'tables'])).out).toContain('Successfully pulled 3 tables')
    } finally {
      server.stop()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
