/**
 * cgroup v2 limits for sandboxed builds and runs.
 *
 * Bunwrite cannot set cgroups from inside a child process, so it creates one
 * cgroup per build/run in a delegated subtree and moves the child into it
 * right after spawn. Every descendant inherits the cgroup, which keeps a
 * function's forked helpers, npm and the app itself inside the same memory,
 * CPU and PID budget.
 *
 * The host (or the container) must delegate a writable cgroup v2 subtree.
 * In a systemd unit use `Delegate=yes` (or a `DelegateSubgroup=` child) and
 * point FUNCTIONS_CGROUP_ROOT at the delegated folder. Inside Docker the
 * default /sys/fs/cgroup is usually read-only, so cgroups stay off unless the
 * container is given a writable cgroup mount. `auto` (the default) does
 * nothing when the subtree is unavailable; `on` refuses to start.
 */
import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

/** CPU, memory and process limits for one sandboxed workload. */
export interface CgroupLimits {
  memoryMb?: number
  /** Fractional CPUs, such as 0.5 or 2. */
  cpus?: number
  pids?: number
}

export interface CgroupHandle {
  readonly path: string
  attach(pid: number): void
  remove(): void
}

type CgroupEnv = Record<string, string | undefined>

const MOUNT = '/sys/fs/cgroup'
const WANTED = ['memory', 'cpu', 'pids'] as const
const CPU_PERIOD = 100_000

/** A safe subdirectory name; callers pass IDs that already look like this. */
export function cgroupName(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/\.{2,}/g, '-')
      .replace(/[^a-z0-9_.-]+/g, '-')
      .replace(/^[^a-z0-9]+/, '')
      .slice(0, 96) || 'run'
  )
}

/** `cpus=0.5` -> `50000 100000`, the cgroup v2 CPU bandwidth syntax. */
export function cpuMax(cpus: number): string {
  const quota = Math.max(1_000, Math.round(Math.max(0.01, cpus) * CPU_PERIOD))
  return `${quota} ${CPU_PERIOD}`
}

function readTrim(path: string): string {
  try {
    return readFileSync(path, 'utf8').trim()
  } catch {
    return ''
  }
}

function availableControllers(dir: string): string[] {
  return readTrim(join(dir, 'cgroup.controllers')).split(/\s+/).filter(Boolean)
}

/** Enable the controllers in a child cgroup; a parent with processes cannot enable them. */
function enableControllers(dir: string): string[] {
  const controllers = availableControllers(dir)
  const wanted = WANTED.filter((name) => controllers.includes(name))
  if (!wanted.length) return []
  try {
    writeFileSync(join(dir, 'cgroup.subtree_control'), wanted.map((name) => `+${name}`).join(' '))
  } catch {
    // The controller can already be enabled, or the subtree is not delegated.
  }
  return wanted
}

/** The cgroup this process is in, from `/proc/self/cgroup` (v2 has a `0::` line). */
function currentCgroup(): string | null {
  const line = readTrim('/proc/self/cgroup')
    .split('\n')
    .find((row) => row.startsWith('0::'))
  if (!line) return null
  const path = line.slice(3).trim()
  if (!path || path === '/') return null
  return join(MOUNT, path)
}

/** A writable cgroup root: an explicit path, or the process's own delegated subgroup. */
function pickRoot(env: CgroupEnv): string | null {
  const configured = (env.FUNCTIONS_CGROUP_ROOT || '').trim()
  if (configured) {
    const root = resolve(configured)
    if (!existsSync(join(root, 'cgroup.controllers'))) return null
    try {
      accessSync(root, constants.W_OK)
    } catch {
      return null
    }
    return root
  }
  const own = currentCgroup()
  if (own && existsSync(join(own, 'cgroup.controllers'))) {
    try {
      accessSync(own, constants.W_OK)
      return own
    } catch {
      /* not delegated to this user */
    }
  }
  if (existsSync(join(MOUNT, 'cgroup.controllers'))) {
    try {
      accessSync(MOUNT, constants.W_OK)
      return MOUNT
    } catch {
      return null
    }
  }
  return null
}

export class CgroupLimiter {
  /** Where per-run cgroups are created. */
  readonly root: string

  private constructor(root: string) {
    this.root = root
  }

  static setup(env: CgroupEnv = process.env): CgroupLimiter | null {
    const mode = (env.FUNCTIONS_CGROUPS ?? 'auto').toLowerCase()
    if (mode === 'off' || mode === 'false' || mode === 'none') return null
    if (process.platform !== 'linux') {
      if (mode === 'on' || mode === 'true') throw new Error('FUNCTIONS_CGROUPS=on, but cgroup v2 is only available on Linux.')
      return null
    }
    if (!existsSync(join(MOUNT, 'cgroup.controllers'))) {
      if (mode === 'on' || mode === 'true') throw new Error('FUNCTIONS_CGROUPS=on, but cgroup v2 is not mounted at /sys/fs/cgroup.')
      return null
    }
    const root = pickRoot(env)
    if (!root) {
      if (mode === 'on' || mode === 'true') {
        throw new Error('FUNCTIONS_CGROUPS=on, but no writable cgroup v2 subtree was found. Set FUNCTIONS_CGROUP_ROOT to a delegated folder.')
      }
      return null
    }
    const limiter = new CgroupLimiter(root)
    if ((mode === 'on' || mode === 'true') && !limiter.available) {
      throw new Error(`FUNCTIONS_CGROUPS=on, but ${root} offers none of the memory, cpu or pids controllers.`)
    }
    if (mode === 'on' || mode === 'true') {
      // Prove that a child cgroup can actually be created and limited now; a
      // read-only mount or an un-delegated parent fails here, not at the first
      // function run.
      const probe = limiter.create('probe', { memoryMb: 16, cpus: 0.1, pids: 8 })
      if (!probe) throw new Error(`FUNCTIONS_CGROUPS=on, but ${root} cannot create a limited child cgroup.`)
      probe.remove()
    }
    limiter.prune()
    return limiter
  }

  /** True when at least one of memory, CPU or pids can be set. */
  get available(): boolean {
    return availableControllers(this.root).some((name) => (WANTED as readonly string[]).includes(name))
  }

  /**
   * Create a cgroup for one run. Returns null when the subtree does not offer
   * any of the wanted controllers, so the caller can carry on without limits.
   */
  create(prefix: string, limits: CgroupLimits): CgroupHandle | null {
    const controllers = enableControllers(this.root)
    if (!controllers.length) return null
    const name = `${cgroupName(prefix)}-${randomUUID().slice(0, 8)}`
    const path = join(this.root, name)
    try {
      mkdirSync(path)
    } catch {
      return null
    }
    try {
      let applied = 0
      if (controllers.includes('memory') && limits.memoryMb !== undefined && existsSync(join(path, 'memory.max'))) {
        const bytes = Math.max(16, Math.round(limits.memoryMb)) * 1024 * 1024
        writeFileSync(join(path, 'memory.max'), String(bytes))
        // Keep swap from silently doubling the budget when a swap device exists.
        if (existsSync(join(path, 'memory.swap.max'))) {
          try {
            writeFileSync(join(path, 'memory.swap.max'), '0')
          } catch {
            /* no swap controller */
          }
        }
        applied++
      }
      if (controllers.includes('cpu') && limits.cpus !== undefined && existsSync(join(path, 'cpu.max'))) {
        writeFileSync(join(path, 'cpu.max'), cpuMax(limits.cpus))
        applied++
      }
      if (controllers.includes('pids') && limits.pids !== undefined && existsSync(join(path, 'pids.max'))) {
        writeFileSync(join(path, 'pids.max'), String(Math.max(1, Math.round(limits.pids))))
        applied++
      }
      if (!applied) {
        rmdirSync(path)
        return null
      }
    } catch {
      // A controller disappeared between the probe and the use; remove the
      // half-configured cgroup and run without it rather than leaving it behind.
      try {
        rmdirSync(path)
      } catch {
        /* not empty or already gone */
      }
      return null
    }
    let removed = false
    return {
      path,
      attach: (pid: number) => {
        try {
          writeFileSync(join(path, 'cgroup.procs'), String(pid))
        } catch (error) {
          // A very short command can exit before the parent moves it in. That
          // is not a limit failure: there is no process left to limit.
          const code = (error as NodeJS.ErrnoException).code
          if (code === 'ESRCH' || code === 'ENOENT') return
          throw error
        }
      },
      remove: () => {
        if (removed) return
        removed = true
        try {
          rmdirSync(path)
        } catch {
          /* the process may still be exiting; the next prune removes it */
        }
      },
    }
  }

  /** Remove empty cgroups left by a crash or a process that exited during cleanup. */
  prune(): void {
    let names: string[]
    try {
      names = readdirSync(this.root)
    } catch {
      return
    }
    const staleBefore = Date.now() - 60 * 60 * 1000
    for (const name of names) {
      // Never touch an operator's own subdirectories or the controller files.
      if (!/^[a-z0-9_.-]+-[0-9a-f]{8}$/.test(name)) continue
      const path = join(this.root, name)
      try {
        // Another worker may have just created this cgroup and not attached its
        // process yet; only clear folders that are clearly from an older run.
        if (statSync(path).mtimeMs > staleBefore) continue
        rmdirSync(path)
      } catch {
        /* still in use */
      }
    }
  }
}
