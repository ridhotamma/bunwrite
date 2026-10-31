import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { keyCaller } from '~/auth/caller'
import {
  clusterConfig,
  clusterProcessCount,
  resolveWorkers,
  workerPort,
  workerPortsEnabled,
  writerEnabled,
} from '~/cluster/config'
import { LeaderLease } from '~/cluster/leader'
import { workerCommand } from '~/cluster/supervisor'
import { VersionMonitor } from '~/cluster/versions'
import { openDb, type Db } from '~/db/connection'
import { pushConfig } from '~/schema/push'
import { createServices, type Services } from '~/services'
import { PROJECT, testConfig, testSchema } from './helpers'

const dirs: string[] = []
const databases: Db[] = []
const services: Services[] = []

function tempDatabase(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bunwrite-cluster-'))
  dirs.push(dir)
  return join(dir, 'bunwrite.sqlite')
}

function open(path: string): Db {
  const db = openDb(path)
  databases.push(db)
  return db
}

function servicesFor(path: string): Services {
  const created = createServices(testConfig({ databasePath: path, workers: 2, cacheCheckMs: 0, realtimeBusPollMs: 20 }), open(path))
  services.push(created)
  return created
}

afterEach(() => {
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

describe('worker count', () => {
  test('one process unless WORKERS asks for more', () => {
    expect(resolveWorkers(undefined, 'linux')).toBe(1)
    expect(resolveWorkers('', 'linux')).toBe(1)
    expect(resolveWorkers('1', 'linux')).toBe(1)
    expect(resolveWorkers('off', 'linux')).toBe(1)
    expect(resolveWorkers('nonsense', 'linux')).toBe(1)
    expect(resolveWorkers('4', 'linux')).toBe(4)
    expect(resolveWorkers('64', 'linux')).toBe(16)
  })

  test('auto follows the CPUs the container may use', () => {
    expect(resolveWorkers('auto', 'linux', () => 3.5)).toBe(4)
    expect(resolveWorkers('auto', 'linux', () => 0.5)).toBe(1)
    expect(resolveWorkers('auto', 'linux', () => 64)).toBe(16)
    // SO_REUSEPORT is only used on Linux.
    expect(resolveWorkers('auto', 'darwin', () => 8)).toBe(1)
    expect(resolveWorkers('4', 'darwin')).toBe(1)
  })

  test('a supervisor adds one writer process beside the public workers', () => {
    expect(clusterConfig({ WORKERS: '3' }, 'linux')).toEqual({
      workers: 4,
      publicWorkers: 3,
      workerIndex: 0,
      supervisor: true,
    })
    expect(clusterConfig({ BUNWRITE_WORKER: '2', BUNWRITE_CLUSTER_SIZE: '4', WORKERS: '3' }, 'linux')).toEqual({
      workers: 4,
      publicWorkers: 3,
      workerIndex: 2,
      supervisor: false,
    })
    // WRITER_PORT=0 keeps local writes, so every process serves public traffic.
    expect(clusterConfig({ WORKERS: '3', WRITER_PORT: '0' }, 'linux')).toEqual({
      workers: 3,
      publicWorkers: 3,
      workerIndex: 0,
      supervisor: true,
    })
    expect(clusterConfig({}, 'linux')).toEqual({ workers: 1, publicWorkers: 1, workerIndex: 0, supervisor: false })
  })

  test('process and port helpers follow the writer layout', () => {
    expect(clusterProcessCount(1)).toBe(1)
    expect(clusterProcessCount(4)).toBe(5)
    expect(clusterProcessCount(4, false)).toBe(4)
    expect(writerEnabled({})).toBe(true)
    expect(writerEnabled({ WRITER_PORT: '0' })).toBe(false)
    expect(workerPortsEnabled({})).toBe(false)
    expect(workerPortsEnabled({ WORKER_PORTS: 'true' })).toBe(true)
    expect(workerPortsEnabled({ WORKER_PORTS: 'yes' })).toBe(true)
    expect(workerPort(8080, 0, true)).toBe(8080)
    expect(workerPort(8080, 1, true)).toBe(8080)
    expect(workerPort(8080, 3, true)).toBe(8082)
    expect(workerPort(8080, 3, false)).toBe(8080)
    // No dedicated writer: index 0 is the first public worker.
    expect(workerPort(8080, 0, true, 0)).toBe(8080)
    expect(workerPort(8080, 2, true, 0)).toBe(8082)
  })

  test('workers are spawned with the executable and the user arguments only', () => {
    // Compiled binary: argv[1] is the entrypoint inside the Bun virtual FS.
    expect(workerCommand(['bun', '/$bunfs/root/bunwrite', 'serve'], '/usr/local/bin/bunwrite')).toEqual([
      '/usr/local/bin/bunwrite',
      'serve',
    ])
    expect(workerCommand(['bun', '/$bunfs/root/bunwrite'], '/usr/local/bin/bunwrite')).toEqual(['/usr/local/bin/bunwrite'])
    // From source: argv[1] is the entrypoint file.
    expect(workerCommand(['/Users/me/.bun/bin/bun', '/repo/src/main.ts', 'serve'], '/Users/me/.bun/bin/bun')).toEqual([
      '/Users/me/.bun/bin/bun',
      'serve',
    ])
    // `bun --watch src/index.ts` still keeps the entrypoint at argv[1].
    expect(workerCommand(['/Users/me/.bun/bin/bun', '/repo/src/index.ts'], '/Users/me/.bun/bin/bun')).toEqual([
      '/Users/me/.bun/bin/bun',
    ])
  })
})

describe('sqlite connection', () => {
  test('the busy timeout is configurable per process role', () => {
    const writer = openDb(tempDatabase(), undefined, undefined, undefined, 5000)
    databases.push(writer)
    const reader = openDb(tempDatabase(), undefined, undefined, undefined, 250)
    databases.push(reader)

    expect(writer.sqlite.query('PRAGMA busy_timeout').get()).toEqual({ timeout: 5000 })
    expect(reader.sqlite.query('PRAGMA busy_timeout').get()).toEqual({ timeout: 250 })
  })
})

describe('cache versions', () => {
  test('a second connection sees settings and schema writes', () => {
    const path = tempDatabase()
    const writer = open(path)
    const reader = open(path)
    const monitor = new VersionMonitor(reader, 0)

    expect(monitor.poll()).toEqual({ schema: false, settings: false, catalog: false, projects: false, auth: false, keys: false })

    writer.sqlite
      .query("INSERT INTO _settings (key, value, updated_at) VALUES ('smtp', '{}', '2026-01-01T00:00:00.000Z')")
      .run()
    expect(monitor.poll()).toEqual({ schema: false, settings: true, catalog: false, projects: false, auth: false, keys: false })

    writer.sqlite
      .query("INSERT INTO _databases (id, name, enabled, created_at, updated_at) VALUES ('main', 'Main', 1, '2026-01-01', '2026-01-01')")
      .run()
    expect(monitor.poll()).toEqual({ schema: true, settings: false, catalog: false, projects: false, auth: false, keys: false })

    expect(monitor.poll()).toEqual({ schema: false, settings: false, catalog: false, projects: false, auth: false, keys: false })
  })

  test('reset re-baselines after this process applied the change', () => {
    const path = tempDatabase()
    const writer = open(path)
    const reader = open(path)
    const monitor = new VersionMonitor(reader, 0)
    writer.sqlite.query("INSERT INTO _settings (key, value, updated_at) VALUES ('project', '{}', '2026-01-01')").run()
    monitor.reset()
    expect(monitor.poll().settings).toBe(false)
  })
})

describe('leader lease', () => {
  test('one holder at a time, and an expired lease is taken over', () => {
    const path = tempDatabase()
    const one = open(path)
    const two = open(path)
    const first = new LeaderLease(one, { owner: 'one', ttlMs: 60_000, onChange: () => {} })
    const second = new LeaderLease(two, { owner: 'two', ttlMs: 60_000, onChange: () => {} })

    expect(first.acquire()).toBe(true)
    expect(first.isLeader).toBe(true)
    expect(second.acquire()).toBe(false)
    expect(second.isLeader).toBe(false)

    // Simulate the first worker dying without releasing the lease.
    one.sqlite.query("UPDATE _cluster_leases SET expires_at = 0 WHERE name = 'scheduler'").run()
    expect(second.acquire()).toBe(true)
    expect(second.isLeader).toBe(true)
    expect(first.acquire()).toBe(false)

    // A clean stop hands the lease over immediately.
    second.stop()
    expect(first.acquire()).toBe(true)
  })
})

describe('realtime bus', () => {
  test('an event written by one worker reaches a socket in another', async () => {
    const path = tempDatabase()
    const writerDb = open(path)
    pushConfig(writerDb, testSchema)
    const writer = servicesFor(path)
    const listener = servicesFor(path)

    const received: any[] = []
    const socket = {
      data: {
        caller: keyCaller(),
        subscriptions: new Map([['sub', ['databases.main.collections.products.documents']]]),
        projectId: PROJECT,
      },
      send: (text: string) => received.push(JSON.parse(text)),
    } as any
    listener.realtime.open(socket)

    const collection = writer.registry.collection('main', 'products', true)
    writer.realtime.publish([{ collection, action: 'create', document: { $id: 'doc-1', $permissions: [] } }])

    const deadline = Date.now() + 2_000
    while (!received.some((message) => message.type === 'event') && Date.now() < deadline) await Bun.sleep(10)

    const event = received.find((message) => message.type === 'event')
    expect(event).toBeDefined()
    expect(event.data.payload.$id).toBe('doc-1')
    expect(event.data.subscriptions).toEqual(['sub'])
  })

  test('no bus rows are written when no process has a socket', async () => {
    const path = tempDatabase()
    const writerDb = open(path)
    pushConfig(writerDb, testSchema)
    const writer = servicesFor(path)
    const listener = servicesFor(path)

    const socket = {
      data: { caller: keyCaller(), subscriptions: new Map(), projectId: PROJECT },
      send: () => {},
    } as any
    listener.realtime.open(socket)
    // Closing the last socket removes this process's presence row.
    listener.realtime.close(socket)

    const collection = writer.registry.collection('main', 'products', true)
    writer.realtime.publish([{ collection, action: 'create', document: { $id: 'doc-2', $permissions: [] } }])

    const { n } = writer.db.sqlite.query<{ n: number }, []>('SELECT count(*) AS n FROM _realtime_events').get()!
    expect(n).toBe(0)
  })
})
