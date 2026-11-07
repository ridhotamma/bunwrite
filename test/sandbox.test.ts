import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'

import { bubblewrapArgs, setupSandbox } from '~/functions/sandbox'
import { CgroupLimiter, cgroupName, cpuMax } from '~/system/cgroups'

const root = mkdtempSync(join(tmpdir(), 'bunwrite-sandbox-'))
const app = join(root, 'app')
const home = join(root, 'home')
const runtimes = join(root, 'runtimes')
for (const dir of [app, home, runtimes]) mkdirSync(dir, { recursive: true })

afterAll(() => rmSync(root, { recursive: true, force: true }))

const paths = { runtimeRoot: runtimes, execPath: process.execPath, tmpMb: 32 }
const has = (args: string[], ...sequence: string[]) => args.some((_, i) => sequence.every((part, j) => args[i + j] === part))
const canon = (path: string) => realpathSync(path)

describe('bubblewrap arguments', () => {
  test('isolates the network and mounts a writable build directory', () => {
    const args = bubblewrapArgs(
      app,
      ['sh', '-c', 'npm install'],
      { writable: true, home, network: 'none' },
      paths,
    )
    expect(args).toContain('--unshare-all')
    expect(args).not.toContain('--share-net')
    expect(has(args, '--bind', canon(app), app)).toBe(true)
    expect(has(args, '--bind', canon(home), home)).toBe(true)
    expect(has(args, '--ro-bind', canon(runtimes), runtimes)).toBe(true)
    expect(has(args, '--perms', '1777', '--size', String(32 * 1024 * 1024), '--tmpfs', '/tmp')).toBe(true)
    expect(has(args, '--chdir', app, '--', 'sh', '-c', 'npm install')).toBe(true)
  })

  test('a run gets a read-only deployment and keeps the host network when asked', () => {
    const args = bubblewrapArgs(app, ['node', 'index.js'], { network: 'shared' }, paths)
    expect(args).toContain('--share-net')
    expect(has(args, '--ro-bind', canon(app), app)).toBe(true)
    expect(args).not.toContain('--bind')
    expect(has(args, '--proc', '/proc', '--dev', '/dev')).toBe(true)
  })

  test('extra read and write paths are bound explicitly', () => {
    const extraRead = join(root, 'read')
    const extraWrite = join(root, 'write')
    mkdirSync(extraRead)
    mkdirSync(extraWrite)
    const args = bubblewrapArgs(app, ['node'], { read: [extraRead], write: [extraWrite] }, paths)
    expect(has(args, '--ro-bind', canon(extraRead), extraRead)).toBe(true)
    expect(has(args, '--bind', canon(extraWrite), extraWrite)).toBe(true)
  })
})

describe('cgroup values', () => {
  test('CPU fractions become cpu.max quota and period', () => {
    expect(cpuMax(0.5)).toBe('50000 100000')
    expect(cpuMax(2)).toBe('200000 100000')
    expect(cpuMax(0)).toBe('1000 100000')
  })

  test('names are safe directory segments', () => {
    const name = cgroupName('build-site abc/../x')
    expect(name).not.toContain('/')
    expect(name).not.toContain('..')
    expect(cgroupName('')).toBe('run')
  })
})

// Run explicitly on Linux with a delegated, empty cgroup v2 subtree:
//   BUNWRITE_TEST_CGROUPS=1 FUNCTIONS_CGROUP_ROOT=/sys/fs/cgroup/bw-test bun test test/sandbox.test.ts
const linuxCgroups = process.platform === 'linux' && process.env.BUNWRITE_TEST_CGROUPS === '1' && Boolean(process.env.FUNCTIONS_CGROUP_ROOT)

describe.skipIf(!linuxCgroups)('cgroup v2 on Linux', () => {
  test('creates memory, CPU and PID limits and attaches a child', async () => {
    const limiter = CgroupLimiter.setup({ FUNCTIONS_CGROUPS: 'on', FUNCTIONS_CGROUP_ROOT: process.env.FUNCTIONS_CGROUP_ROOT })
    expect(limiter).not.toBeNull()
    const cgroup = limiter!.create('bunwrite-test', { memoryMb: 64, cpus: 0.5, pids: 16 })
    expect(cgroup).not.toBeNull()
    const proc = Bun.spawn(['sleep', '0.3'])
    cgroup!.attach(proc.pid)
    const read = (name: string) => readFileSync(join(cgroup!.path, name), 'utf8').trim()
    expect(read('memory.max')).toBe(String(64 * 1024 * 1024))
    expect(read('cpu.max')).toBe('50000 100000')
    expect(read('pids.max')).toBe('16')
    expect(read('cgroup.procs').split('\n').filter(Boolean).length).toBeGreaterThanOrEqual(1)
    await proc.exited
    cgroup!.remove()
    expect(existsSync(cgroup!.path)).toBe(false)
  })
})

// Run explicitly on a Linux host with bubblewrap and the setpriv helper:
//   BUNWRITE_TEST_BWRAP=1 bun test test/sandbox.test.ts
const linuxBwrap = process.platform === 'linux' && process.env.BUNWRITE_TEST_BWRAP === '1'

describe.skipIf(!linuxBwrap)('bubblewrap on Linux', () => {
  test('runs as the function user with private mounts and no network', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bunwrite-bwrap-'))
    try {
      const sandbox = setupSandbox(join(root, 'bunwrite.sqlite'), {
        FUNCTIONS_SANDBOX: 'bwrap',
        FUNCTIONS_SANDBOX_HELPER: process.env.FUNCTIONS_SANDBOX_HELPER,
        FUNCTIONS_SANDBOX_BWRAP: process.env.FUNCTIONS_SANDBOX_BWRAP ?? 'bwrap',
        FUNCTIONS_SANDBOX_NETWORK: 'none',
        FUNCTIONS_CGROUPS: 'off',
        FUNCTIONS_SANDBOX_TMP_MB: '16',
      })
      expect(sandbox).not.toBeNull()
      const uid = sandbox!.uidFor('project', 'function')
      const cwd = join(root, 'app')
      const home = join(root, 'home')
      mkdirSync(cwd, { recursive: true })
      mkdirSync(home, { recursive: true })
      sandbox!.adopt(cwd, home, uid)

      const script = `
printf 'uid=%s\\n' "$(id -u)"
touch /tmp/ok 2>/dev/null && printf 'tmp=write\\n' || printf 'tmp=fail\\n'
touch /usr/nope 2>/dev/null && printf 'usr=write\\n' || printf 'usr=readonly\\n'
touch "$HOME/ok" 2>/dev/null && printf 'home=write\\n' || printf 'home=fail\\n'
touch ./cwd-write 2>/dev/null && printf 'cwd=write\\n' || printf 'cwd=readonly\\n'
test -e /tmp && printf 'tmp=mounted\\n'
printf 'interfaces='; awk -F: '/^[ ]*[a-z0-9]+:/{gsub(/ /,"",$1); printf "%s ",$1}' /proc/net/dev; printf '\\n'
`
      const run = async (network: 'none' | 'shared', writable = false) => {
        const command = sandbox!.wrap(uid, cwd, ['/bin/sh', '-c', script], { home, network, writable })
        const proc = Bun.spawn(command, { stdout: 'pipe', stderr: 'pipe' })
        const out = await new Response(proc.stdout).text()
        const err = await new Response(proc.stderr).text()
        const code = await proc.exited
        expect({ code, err }).toEqual({ code: 0, err: '' })
        return out
      }

      const isolated = await run('none')
      expect(isolated).toContain(`uid=${uid}`)
      expect(isolated).toContain('tmp=write')
      expect(isolated).toContain('tmp=mounted')
      expect(isolated).toContain('usr=readonly')
      expect(isolated).toContain('home=write')
      expect(isolated).toContain('cwd=readonly')
      expect(isolated).not.toContain('eth0')

      expect(await run('none', true)).toContain('cwd=write')
      expect(await run('shared')).toContain('eth0')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
