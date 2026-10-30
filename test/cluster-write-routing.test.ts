import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createApp } from '~/app'
import { keyCaller } from '~/auth/caller'
import {
  isDatabaseWrite,
  isForwardedConsoleWrite,
  isForwardedWrite,
  isWriterWorker,
  shouldForwardConsoleWrite,
  shouldForwardWrite,
} from '~/cluster/writer'
import { ConsoleAuth } from '~/console/auth'
import { configFromEnv } from '~/config'
import { openDb, type Db } from '~/db/connection'
import { pushConfig } from '~/schema/push'
import { createServices, type Services } from '~/services'
import { KEY, PROJECT, testConfig, testSchema } from './helpers'

const dirs: string[] = []
const databases: Db[] = []
const services: Services[] = []
const stops: Array<() => void> = []

function tempDatabase(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bunwrite-writer-'))
  dirs.push(dir)
  return join(dir, 'bunwrite.sqlite')
}

function open(path: string): Db {
  const db = openDb(path)
  databases.push(db)
  return db
}

afterEach(() => {
  for (const stop of stops.splice(0)) stop()
  for (const created of services.splice(0)) created.realtime.stop()
  for (const db of databases.splice(0)) {
    try {
      db.sqlite.close()
    } catch {
      /* already closed */
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const product = (name: string) => ({ tenantId: 't1', name })

describe('writer role', () => {
  test('one process is the writer, a single process writes locally', () => {
    expect(isWriterWorker({ workers: 1, workerIndex: 0 })).toBe(true)
    expect(isWriterWorker({ workers: 4, workerIndex: 0 })).toBe(true)
    expect(isWriterWorker({ workers: 4, workerIndex: 1 })).toBe(false)
    expect(isWriterWorker({ workers: 4, workerIndex: 3 })).toBe(false)
  })

  test('document and transaction writes are database writes', () => {
    expect(isDatabaseWrite('POST', '/databases')).toBe(true)
    expect(isDatabaseWrite('POST', '/databases/main/collections/products/documents')).toBe(true)
    expect(isDatabaseWrite('PATCH', '/databases/main/collections/products/documents/p1')).toBe(true)
    expect(isDatabaseWrite('PATCH', '/databases/transactions/tx1')).toBe(true)
    expect(isDatabaseWrite('GET', '/databases/main/collections/products/documents')).toBe(false)
    expect(isDatabaseWrite('POST', '/account/sessions/email')).toBe(false)
  })

  test('every short mutation moves to the writer; long work stays local', () => {
    expect(isForwardedWrite('POST', '/databases/main/collections/products/documents')).toBe(true)
    expect(isForwardedWrite('POST', '/account/sessions/email')).toBe(true)
    expect(isForwardedWrite('POST', '/teams')).toBe(true)
    expect(isForwardedWrite('PUT', '/teams/team-1/prefs')).toBe(true)
    expect(isForwardedWrite('POST', '/storage/buckets')).toBe(true)
    expect(isForwardedWrite('PUT', '/storage/buckets/files/files/file-1')).toBe(true)
    expect(isForwardedWrite('POST', '/proxy/rules/site')).toBe(true)
    expect(isForwardedWrite('PATCH', '/project/services/functions')).toBe(true)
    expect(isForwardedWrite('GET', '/account')).toBe(false)
    // Uploads, function/site work, rendering and GitHub calls stay on the accepting worker.
    expect(isForwardedWrite('POST', '/storage/buckets/files/files')).toBe(false)
    expect(isForwardedWrite('POST', '/functions/fn/executions')).toBe(false)
    expect(isForwardedWrite('POST', '/functions/fn/deployments')).toBe(false)
    expect(isForwardedWrite('POST', '/functions/fn/deployments/vcs')).toBe(false)
    expect(isForwardedWrite('POST', '/functions/fn/http/webhook')).toBe(false)
    expect(isForwardedWrite('POST', '/sites/site-1/deployments')).toBe(false)
    expect(isForwardedWrite('POST', '/render/pdf')).toBe(false)
    expect(isForwardedWrite('POST', '/vcs/github/installations/1/detections')).toBe(false)
  })

  test('short console forms move to the writer; uploads and builds stay local', () => {
    expect(isForwardedConsoleWrite('POST', '/console/auth/teams')).toBe(true)
    expect(isForwardedConsoleWrite('POST', '/console/settings/project')).toBe(true)
    expect(isForwardedConsoleWrite('POST', '/console/databases/main/collections/products')).toBe(true)
    expect(isForwardedConsoleWrite('POST', '/console/organization/members/invite')).toBe(true)
    expect(isForwardedConsoleWrite('POST', '/console/logout')).toBe(true)
    expect(isForwardedConsoleWrite('GET', '/console/auth/teams')).toBe(false)
    expect(isForwardedConsoleWrite('POST', '/console')).toBe(false)
    expect(isForwardedConsoleWrite('POST', '/console/setup')).toBe(false)
    expect(isForwardedConsoleWrite('POST', '/console/login')).toBe(false)
    expect(isForwardedConsoleWrite('POST', '/console/projects/project-c/delete')).toBe(false)
    expect(isForwardedConsoleWrite('POST', '/console/storage/photos/files')).toBe(false)
    expect(isForwardedConsoleWrite('POST', '/console/functions/fn/run')).toBe(false)
    expect(isForwardedConsoleWrite('POST', '/console/functions/fn/deployments')).toBe(false)
    expect(isForwardedConsoleWrite('POST', '/console/sites/site-1/deployments')).toBe(false)
    expect(isForwardedConsoleWrite('POST', '/console/settings/backups/create')).toBe(false)
    expect(isForwardedConsoleWrite('POST', '/console/settings/smtp/test')).toBe(false)
    expect(isForwardedConsoleWrite('POST', '/console/webhooks/hook-1/test')).toBe(false)
    expect(isForwardedConsoleWrite('POST', '/console/vcs/approve')).toBe(false)
  })

  test('readers forward, the writer and single-process servers do not', () => {
    const base = testConfig({ workers: 4, writerPort: 8081 })
    expect(shouldForwardWrite({ ...base, workerIndex: 1 }, 'POST', '/databases/main/collections/products/documents')).toBe(true)
    expect(shouldForwardWrite({ ...base, workerIndex: 1 }, 'POST', '/account/sessions/email')).toBe(true)
    expect(shouldForwardWrite({ ...base, workerIndex: 0 }, 'POST', '/databases/main/collections/products/documents')).toBe(false)
    expect(shouldForwardWrite({ ...base, workerIndex: 1 }, 'GET', '/databases/main/collections/products/documents')).toBe(false)
    expect(shouldForwardWrite({ ...base, workerIndex: 1, writerPort: 0 }, 'POST', '/databases/main/collections/products/documents')).toBe(false)
    expect(shouldForwardWrite({ ...base, workers: 1, workerIndex: 0 }, 'POST', '/databases/main/collections/products/documents')).toBe(false)
    expect(shouldForwardConsoleWrite({ ...base, workerIndex: 1 }, 'POST', '/console/auth/teams')).toBe(true)
    expect(shouldForwardConsoleWrite({ ...base, workerIndex: 0 }, 'POST', '/console/auth/teams')).toBe(false)
    expect(shouldForwardConsoleWrite({ ...base, workerIndex: 1, writerPort: 0 }, 'POST', '/console/auth/teams')).toBe(false)
    expect(shouldForwardConsoleWrite({ ...base, workerIndex: 1 }, 'POST', '/console/setup')).toBe(false)
  })

  test('configuration defaults keep the listener on loopback beside PORT', () => {
    const config = configFromEnv({ PORT: '9090' })
    expect(config.writerPort).toBe(9091)
    expect(config.writerHost).toBe('127.0.0.1')
    expect(config.writeBatchMs).toBe(0) // one process: no write contention
    expect(config.publicWorkers).toBe(1)
    expect(config.workerPorts).toBe(false)
    expect(config.maxInflight).toBe(200)
    expect(config.httpIdleTimeout).toBe(30)
    expect(config.busyTimeoutMs).toBe(5000)
    expect(config.readerBusyTimeoutMs).toBe(500)
    expect(configFromEnv({ WRITER_PORT: '0' }).writerPort).toBe(0)
    expect(configFromEnv({ WRITER_HOST: '0.0.0.0' }).writerHost).toBe('0.0.0.0')
    expect(configFromEnv({ WRITE_BATCH_MS: '5' }).writeBatchMs).toBe(5)
    expect(configFromEnv({ MAX_INFLIGHT: '0' }).maxInflight).toBe(0)
    expect(configFromEnv({ HTTP_IDLE_TIMEOUT: '900' }).httpIdleTimeout).toBe(255)
    expect(configFromEnv({ SQLITE_BUSY_TIMEOUT_MS: '1500' }).busyTimeoutMs).toBe(1500)
    expect(configFromEnv({ SQLITE_READER_BUSY_TIMEOUT_MS: '250' }).readerBusyTimeoutMs).toBe(250)
  })

  test('per-worker ports move the writer out of the public range', () => {
    const worker = configFromEnv({
      PORT: '9090',
      WORKERS: '4',
      WORKER_PORTS: 'true',
      BUNWRITE_WORKER: '1',
      BUNWRITE_CLUSTER_SIZE: '5',
    })
    expect(worker.publicWorkers).toBe(4)
    expect(worker.workerPorts).toBe(true)
    expect(worker.writerPort).toBe(9190)
    expect(configFromEnv({ PORT: '9090', WORKER_PORTS: 'true', WRITER_PORT: '9999' }).writerPort).toBe(9999)
  })
})

describe('write forwarding', () => {
  test('a write sent to a reader lands on the writer process', async () => {
    const path = tempDatabase()
    const writerDb = open(path)
    pushConfig(writerDb, testSchema)
    const writerConfig = testConfig({ databasePath: path, workers: 2, workerIndex: 0 })
    const writerServices = createServices(writerConfig, writerDb)
    services.push(writerServices)
    const writerApp = createApp(writerServices)
    const writerServer = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: writerApp.fetch, websocket: writerApp.websocket })
    stops.push(() => writerServer.stop(true))

    const readerServices = createServices(
      testConfig({ databasePath: path, workers: 2, workerIndex: 1, writerPort: writerServer.port! }),
      open(path),
    )
    services.push(readerServices)
    const readerApp = createApp(readerServices)
    const readerServer = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: readerApp.fetch, websocket: readerApp.websocket })
    stops.push(() => readerServer.stop(true))

    const url = `http://127.0.0.1:${readerServer.port}/v1/databases/main/collections/products/documents`
    const headers = { 'x-appwrite-project': PROJECT, 'x-appwrite-key': KEY, 'content-type': 'application/json' }

    const created = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ documentId: 'via-reader', data: product('Forwarded') }) })
    expect(created.status).toBe(201)
    expect(((await created.json()) as { $id: string }).$id).toBe('via-reader')

    // The writer's connection sees the document, and it was written once.
    const collection = writerServices.registry.collection('main', 'products', true)
    expect(writerServices.store.countDocuments(keyCaller(), collection)).toBe(1)
    const listed = await fetch(url, { headers })
    expect(listed.status).toBe(200)
    expect(((await listed.json()) as { total: number }).total).toBe(1)

    // Errors keep their Appwrite shape through the hop.
    const invalid = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ documentId: 'bad', data: { tenantId: 't1', nope: 1 } }),
    })
    expect(invalid.status).toBe(400)
    expect(((await invalid.json()) as { type: string }).type).toBe('document_invalid_structure')

    // Bulk writes use the same path.
    const bulk = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ documents: [{ $id: 'bulk-1', ...product('Bulk 1') }, { $id: 'bulk-2', ...product('Bulk 2') }] }),
    })
    expect(bulk.status).toBe(201)
    expect(((await bulk.json()) as { total: number }).total).toBe(2)

    // Other short mutations use the writer too, so their auth and schema
    // writes do not contend with the document writes on another connection.
    const team = await fetch(`http://127.0.0.1:${readerServer.port}/v1/teams`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ teamId: 'forwarded-team', name: 'Forwarded team' }),
    })
    expect(team.status).toBe(201)
    expect(((await team.json()) as { $id: string }).$id).toBe('forwarded-team')
    const stored = writerDb.sqlite.query<{ id: string }, [string]>('SELECT id FROM _teams WHERE id = ?').get('forwarded-team')
    expect(stored?.id).toBe('forwarded-team')

    // Console forms take the same hop. Set up an admin, then send the form to
    // the reader with the console and project cookies a browser would send.
    const consoleAuth = new ConsoleAuth(writerDb)
    await consoleAuth.upsert('admin@example.com', 'password123')
    const consoleSecret = (await consoleAuth.login('admin@example.com', 'password123'))!
    const consoleResponse = await fetch(`http://127.0.0.1:${readerServer.port}/console/auth/teams`, {
      method: 'POST',
      headers: {
        cookie: `bunwrite_console=${consoleSecret}; console_project=${PROJECT}`,
        origin: `http://127.0.0.1:${readerServer.port}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'name=Console+team&id=console-team',
      redirect: 'manual',
    })
    expect(consoleResponse.status).toBe(303)
    const consoleStored = writerDb.sqlite.query<{ id: string }, [string]>('SELECT id FROM _teams WHERE id = ?').get('console-team')
    expect(consoleStored?.id).toBe('console-team')
  })
})
