/**
 * Isolation for function and site builds and runs.
 *
 * Two layers are available:
 *
 * - `setpriv` (the original): every function builds and runs as its own Linux
 *   user, which can read and write its own deployment folder and nothing else
 *   of the server's (databases, uploads, backups, other functions). It does not
 *   isolate mounts, processes, the network or CPU/memory.
 * - `bwrap` (optional): the setpriv user boundary plus a bubblewrap sandbox:
 *   private mount, PID, IPC, UTS and (optionally) network namespaces, a
 *   read-only system root, a read-only deployment for runs, bounded tmpfs and
 *   no parent process in sight. Cgroup v2 limits put the whole process tree
 *   under one memory, CPU and PID budget; bwrap mode requires them by default.
 *
 * The server runs as an ordinary user, so switching users goes through a
 * helper: util-linux `setpriv` with the setuid/setgid file capabilities,
 * installed so only the server's group may run it (see the Dockerfile).
 * Function processes get `--no-new-privs` and no capabilities, so they cannot
 * use the helper or any setuid program to climb back.
 *
 * With isolation on, the server creates files readable by itself only
 * (umask 077) and tightens what is already in the data folder; the folders on
 * the way to a function's code only allow passing through.
 *
 * FUNCTIONS_SANDBOX: `auto` (default; setpriv when the helper works), `setpriv`,
 * `bwrap`, `on` (same as setpriv and refuses to start without it), `off`.
 * FUNCTIONS_CGROUPS: `auto`, `on`, `off`.
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { CgroupLimiter } from '~/system/cgroups'

export const DEFAULT_HELPER = '/usr/local/libexec/bunwrite-sandbox'
const FIRST_UID = 20000
const LAST_UID = 59999
const DEFAULT_TMP_MB = 64

export type SandboxKind = 'setpriv' | 'bwrap'
export type SandboxNetwork = 'shared' | 'none'
export type SandboxWorkload = 'function' | 'site' | 'build'

export interface SandboxLimits {
  memoryMb: number
  cpus: number
  pids: number
}

export interface SandboxExecOptions {
  /** Bind the working directory writable (builds) instead of read-only (runs). */
  writable?: boolean
  /** A writable home/temp folder, bound at its real path for HOME and TMPDIR. */
  home?: string
  /** Use a private network namespace with no interfaces when `none`. */
  network?: SandboxNetwork
  /** Extra paths to expose read-only or writable inside the sandbox. */
  read?: string[]
  write?: string[]
}

export interface SandboxCgroup {
  attach(pid: number): void
  remove(): void
}

export interface FunctionSandbox {
  readonly kind: SandboxKind
  /** The data folder everything sandboxed lives under. */
  readonly root: string
  /** This function's user ID, the same for its whole life. */
  uidFor(projectId: string, functionId: string): number
  /** `cmd` as the function's user in `cwd`, with no way to gain privileges. */
  wrap(uid: number, cwd: string, cmd: string[], options?: SandboxExecOptions): string[]
  /** Create a cgroup for one build/run; null when cgroups are unavailable. */
  cgroup(prefix: string, workload: SandboxWorkload): SandboxCgroup | null
  limitsFor(workload: SandboxWorkload): SandboxLimits
  networkFor(workload: SandboxWorkload): SandboxNetwork
  /** Hand a deployment folder (when given) and the function's home to the function's user. */
  adopt(dir: string | null, home: string, uid: number): void
  /** Whether a folder already belongs to the user. */
  owns(dir: string, uid: number): boolean
  /** Delete a tree under the data folder, whoever owns the files in it. */
  remove(path: string): void
  /** Signal a process group owned by any user (an app or build started as one). */
  signal(pid: number, signal: 'TERM' | 'KILL'): void
}

/** Delete a folder: through the sandbox when it is on, since function users own what is inside. */
export function removeTree(sandbox: FunctionSandbox | null | undefined, path: string): void {
  if (sandbox && existsSync(path)) sandbox.remove(path)
  else rmSync(path, { recursive: true, force: true })
}

/** Let other users pass through each folder from `path` up to `root` (no listing, no reading). */
export function allowPassThrough(root: string, path: string): void {
  let current = resolve(path)
  const top = resolve(root)
  while (current === top || current.startsWith(top + sep)) {
    try {
      const mode = statSync(current).mode & 0o777
      if ((mode & 0o011) !== 0o011) chmodSync(current, mode | 0o011)
    } catch {
      /* not ours or gone; the run will report what it cannot reach */
    }
    if (current === top) break
    current = dirname(current)
  }
}

function run(cmd: string[]): { ok: boolean; error: string } {
  const result = Bun.spawnSync(cmd, { stdout: 'ignore', stderr: 'pipe' })
  return { ok: result.exitCode === 0, error: result.stderr.toString().trim() }
}

function whole(value: string | undefined, fallback: number, min = 1): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(min, Math.round(parsed)) : fallback
}

function fraction(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(0.01, parsed) : fallback
}

function limitsFromEnv(env: Record<string, string | undefined>): Record<SandboxWorkload, SandboxLimits> {
  return {
    function: {
      memoryMb: whole(env.FUNCTIONS_MEMORY_MB, 512, 16),
      cpus: fraction(env.FUNCTIONS_CPUS, 1),
      pids: whole(env.FUNCTIONS_PIDS, 128),
    },
    site: {
      memoryMb: whole(env.SITES_MEMORY_MB, 1024, 16),
      cpus: fraction(env.SITES_CPUS, 1),
      pids: whole(env.SITES_PIDS, 256),
    },
    build: {
      memoryMb: whole(env.BUILD_MEMORY_MB, 2048, 16),
      cpus: fraction(env.BUILD_CPUS, 2),
      pids: whole(env.BUILD_PIDS, 512),
    },
  }
}

class SetprivSandbox implements FunctionSandbox {
  readonly kind: SandboxKind = 'setpriv'
  private uids: Record<string, number> | null = null
  private readonly registry: string
  private readonly cgroups: CgroupLimiter | null
  private readonly limits: Record<SandboxWorkload, SandboxLimits>
  private readonly networks: Record<SandboxWorkload, SandboxNetwork>

  constructor(
    private readonly helper: string,
    readonly root: string,
    cgroups: CgroupLimiter | null = null,
    limits: Record<SandboxWorkload, SandboxLimits> = limitsFromEnv({}),
    networks: Record<SandboxWorkload, SandboxNetwork> = { function: 'shared', site: 'shared', build: 'shared' },
  ) {
    this.registry = join(root, '.runtimes', 'function-users.json')
    this.cgroups = cgroups
    this.limits = limits
    this.networks = networks
  }

  private load(): Record<string, number> {
    if (this.uids) return this.uids
    try {
      this.uids = JSON.parse(readFileSync(this.registry, 'utf8')) as Record<string, number>
    } catch {
      this.uids = {}
    }
    return this.uids
  }

  uidFor(projectId: string, functionId: string): number {
    const uids = this.load()
    const key = `${projectId}/${functionId}`
    if (uids[key]) return uids[key]
    const used = new Set(Object.values(uids))
    let uid = FIRST_UID
    while (used.has(uid)) uid++
    if (uid > LAST_UID) throw new Error('No free function user IDs are left.')
    uids[key] = uid
    mkdirSync(dirname(this.registry), { recursive: true })
    const temp = `${this.registry}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify(uids, null, 2), { mode: 0o600 })
    renameSync(temp, this.registry)
    return uid
  }

  wrap(uid: number, cwd: string, cmd: string[], _options?: SandboxExecOptions): string[] {
    // The server cannot enter the folder, so change into it after becoming the function's user.
    return [this.helper, `--reuid=${uid}`, `--regid=${uid}`, '--clear-groups', '--no-new-privs', '--inh-caps=-all', '--', '/bin/sh', '-c', 'cd -- "$0" && exec "$@"', cwd, ...cmd]
  }

  cgroup(prefix: string, workload: SandboxWorkload): SandboxCgroup | null {
    return this.cgroups?.create(prefix, this.limitsFor(workload)) ?? null
  }

  limitsFor(workload: SandboxWorkload): SandboxLimits {
    return this.limits[workload]
  }

  networkFor(workload: SandboxWorkload): SandboxNetwork {
    return this.networks[workload]
  }

  /** A command as root, for the few file operations the server needs on function-owned files. */
  private asRoot(script: string, ...args: string[]): void {
    const result = run([this.helper, '--reuid=0', '--regid=0', '--clear-groups', '--', '/bin/sh', '-c', script, 'sandbox', ...args])
    if (!result.ok) throw new Error(`Function sandbox: ${result.error || 'helper failed'}`)
  }

  private inside(path: string): string {
    const full = resolve(path)
    const rel = relative(this.root, full)
    if (!rel || rel.startsWith('..') || rel.startsWith(sep)) throw new Error(`Function sandbox: refusing to touch ${full} outside ${this.root}`)
    return full
  }

  adopt(dir: string | null, home: string, uid: number): void {
    mkdirSync(dirname(home), { recursive: true })
    allowPassThrough(this.root, dirname(home))
    if (dir) allowPassThrough(this.root, dirname(dir))
    // Use mkdir, not install: the Docker image ships a /usr/local/bin/install
    // wrapper for the one-command installer, which shadows GNU install here.
    const giveHome = '/bin/mkdir -p "$2" && chown "$1:$1" "$2" && chmod 0700 "$2"'
    if (dir) this.asRoot(`${giveHome} && chown -R "$1:$1" "$3" && chmod 0700 "$3"`, String(uid), this.inside(home), this.inside(dir))
    else this.asRoot(giveHome, String(uid), this.inside(home))
  }

  owns(dir: string, uid: number): boolean {
    try {
      return statSync(dir).uid === uid
    } catch {
      return false
    }
  }

  remove(path: string): void {
    this.asRoot('rm -rf -- "$1"', this.inside(path))
  }

  signal(pid: number, signal: 'TERM' | 'KILL'): void {
    if (!Number.isInteger(pid) || pid <= 0) return
    // `-pid` is the whole process group: the app's start command is a session leader.
    this.asRoot('kill -s "$1" -- "$2" 2>/dev/null || true', signal, `-${pid}`)
  }
}

interface BubblewrapPaths {
  /** Downloaded Node/Bun runtimes and the build shims; bound read-only. */
  runtimeRoot: string
  /** The server binary, so a compiled `bunwrite __bunwrite-runner-node` works. */
  execPath: string
  /** Size of the private `/tmp` and `/dev/shm`; they otherwise share host memory. */
  tmpMb: number
}

/**
 * Build the bubblewrap argument list. Exported because command construction is
 * the part that can be tested without a Linux sandbox.
 */
export function bubblewrapArgs(cwd: string, cmd: string[], options: SandboxExecOptions = {}, paths: Partial<BubblewrapPaths> = {}): string[] {
  const args = ['--unshare-all']
  if (options.network !== 'none') args.push('--share-net')
  args.push('--die-with-parent', '--hostname', 'bunwrite-sandbox')

  const bind = (source: string, dest: string, writable = false) => {
    if (!isAbsolute(source) || !existsSync(source)) return
    args.push(writable ? '--bind' : '--ro-bind', realpathSync(source), dest)
  }
  const bound = new Set<string>()
  const once = (source: string, dest: string, writable = false) => {
    const key = `${writable ? 'w' : 'r'}:${source}:${dest}`
    if (bound.has(key)) return
    bound.add(key)
    bind(source, dest, writable)
  }

  // System binaries, libraries and certificates. /etc is read-only: it contains
  // no writable secrets for an unprivileged UID, and runtimes expect it.
  for (const path of ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc', '/opt']) once(path, path)
  if (existsSync('/sys')) once('/sys', '/sys')

  // Build the private system mounts before the deployment, home and runtime
  // binds. A deployment under /tmp (or a runtime under /run) must be mounted
  // *after* the fresh tmpfs, or the tmpfs would hide it.
  args.push('--proc', '/proc', '--dev', '/dev')
  const tmpBytes = String(Math.max(1, Math.round(paths.tmpMb ?? DEFAULT_TMP_MB)) * 1024 * 1024)
  // The sandbox can run as a mapped non-root UID, so make the private temp
  // mounts world-writable inside the sandbox (there is only one tenant in it).
  args.push('--perms', '1777', '--size', tmpBytes, '--tmpfs', '/tmp')
  args.push('--perms', '1777', '--size', tmpBytes, '--tmpfs', '/dev/shm', '--perms', '1777', '--tmpfs', '/run')
  args.push('--perms', '1777', '--dir', '/run/lock')
  args.push('--perms', '1777', '--tmpfs', '/var/tmp')
  args.push('--symlink', '/run', '/var/run', '--symlink', '/run/lock', '/var/lock')

  const runtimeRoot = paths.runtimeRoot
  if (runtimeRoot) once(runtimeRoot, runtimeRoot)
  if (paths.execPath) {
    const real = (() => {
      try {
        return realpathSync(paths.execPath)
      } catch {
        return paths.execPath
      }
    })()
    once(dirname(real), dirname(real))
    if (real !== paths.execPath) once(dirname(paths.execPath), dirname(paths.execPath))
  }

  for (const path of options.read ?? []) once(path, path)
  for (const path of options.write ?? []) once(path, path, true)

  // The deployment is read-only for a run and writable for a build. The home
  // folder is always writable so TMPDIR and tool caches keep working.
  once(cwd, cwd, options.writable === true)
  if (options.home) {
    once(options.home, options.home, true)
    // Callers set HOME/TMPDIR in the child env, but set them again inside the
    // sandbox so a command that skipped that step still has a writable home.
    args.push('--setenv', 'HOME', options.home, '--setenv', 'TMPDIR', options.home)
  }

  // On systemd hosts /etc/resolv.conf is usually a symlink into /run, which is
  // now a private tmpfs. Bind the real file at its real path so the symlink
  // still resolves inside the sandbox.
  try {
    const resolv = realpathSync('/etc/resolv.conf')
    if (resolv !== '/etc/resolv.conf') args.push('--ro-bind', resolv, resolv)
  } catch {
    /* no resolver file; the sandbox simply has no DNS */
  }

  args.push('--chdir', cwd, '--', ...cmd)
  return args
}

class BubblewrapSandbox implements FunctionSandbox {
  readonly kind: SandboxKind = 'bwrap'
  readonly root: string

  constructor(
    private readonly base: SetprivSandbox,
    private readonly bwrap: string,
    private readonly paths: BubblewrapPaths,
  ) {
    this.root = base.root
  }

  uidFor(projectId: string, functionId: string): number {
    return this.base.uidFor(projectId, functionId)
  }

  wrap(uid: number, cwd: string, cmd: string[], options: SandboxExecOptions = {}): string[] {
    const args = bubblewrapArgs(cwd, cmd, options, this.paths)
    return this.base.wrap(uid, cwd, [this.bwrap, ...args])
  }

  cgroup(prefix: string, workload: SandboxWorkload): SandboxCgroup | null {
    return this.base.cgroup(prefix, workload)
  }

  limitsFor(workload: SandboxWorkload): SandboxLimits {
    return this.base.limitsFor(workload)
  }

  networkFor(workload: SandboxWorkload): SandboxNetwork {
    return this.base.networkFor(workload)
  }

  adopt(dir: string | null, home: string, uid: number): void {
    this.base.adopt(dir, home, uid)
  }

  owns(dir: string, uid: number): boolean {
    return this.base.owns(dir, uid)
  }

  remove(path: string): void {
    this.base.remove(path)
  }

  signal(pid: number, signal: 'TERM' | 'KILL'): void {
    this.base.signal(pid, signal)
  }
}

/** Make what already sits in the data folder readable by the server only; code folders stay passable. */
export function lockDown(dir: string, depth = 0): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    try {
      const st = statSync(path)
      if (st.uid !== process.getuid?.()) continue
      if (name === 'deployments' || name === 'sites') {
        // A restart must not cut code users off from their own folder: keep the
        // way in passable (`sites/<siteId>/`), while each deployment stays 0700.
        chmodSync(path, 0o711)
        for (const child of readdirSync(path)) {
          const childPath = join(path, child)
          const childStat = statSync(childPath)
          if (!childStat.isDirectory()) continue
          // A site's deployment folders and home belong to the site's user;
          // leave their 0700 alone so only that app can read them.
          if (childStat.uid !== process.getuid?.()) continue
          chmodSync(childPath, 0o711)
          if (name !== 'deployments') continue
          // Kept sources and code not yet handed to a function user stay the server's.
          for (const item of readdirSync(childPath)) {
            const itemPath = join(childPath, item)
            const it = statSync(itemPath)
            if (it.uid === process.getuid?.()) chmodSync(itemPath, it.isDirectory() ? 0o700 : 0o600)
          }
        }
      } else if (name === '.runtimes') {
        chmodSync(path, 0o711)
      } else if (name === 'projects' && depth === 0) {
        chmodSync(path, 0o711)
        for (const project of readdirSync(path)) {
          const projectDir = join(path, project)
          if (!statSync(projectDir).isDirectory()) continue
          chmodSync(projectDir, 0o711)
          lockDown(projectDir, depth + 1)
        }
      } else chmodSync(path, st.isDirectory() ? 0o700 : 0o600)
    } catch {
      /* skip what cannot be changed */
    }
  }
}

type SandboxSetting = 'auto' | 'setpriv' | 'bwrap' | 'on' | 'off'

function sandboxSetting(value: string | undefined): SandboxSetting {
  const mode = (value ?? 'auto').toLowerCase()
  if (mode === 'bwrap' || mode === 'bubblewrap') return 'bwrap'
  if (mode === 'setpriv' || mode === 'on' || mode === 'true') return 'setpriv'
  if (mode === 'off' || mode === 'false' || mode === 'none') return 'off'
  return 'auto'
}

/** Turn the sandbox on when it can work. Call before the database opens, so new files get the tight umask. */
export function setupSandbox(databasePath: string, env: Record<string, string | undefined> = process.env): FunctionSandbox | null {
  const setting = sandboxSetting(env.FUNCTIONS_SANDBOX)
  if (setting === 'off') return null
  const explicit = (env.FUNCTIONS_SANDBOX ?? '').toLowerCase()
  const requireIt = setting === 'setpriv' && (explicit === 'on' || explicit === 'true' || explicit === 'setpriv')
  const fail = (why: string) => {
    if (requireIt || setting === 'bwrap') throw new Error(`FUNCTIONS_SANDBOX=${explicit || setting}, but ${why}`)
    console.warn(`[functions] isolation is off: ${why}`)
    return null
  }
  if (process.platform !== 'linux') return fail('function isolation needs Linux.')
  if (databasePath === ':memory:' || databasePath.startsWith('file::memory:')) return fail('the database is in memory, so there is no data folder to protect.')

  const helper = env.FUNCTIONS_SANDBOX_HELPER || DEFAULT_HELPER
  if (!existsSync(helper)) return fail(`the helper ${helper} is missing.`)
  const probe = run([helper, `--reuid=${FIRST_UID}`, `--regid=${FIRST_UID}`, '--clear-groups', '--no-new-privs', '--', '/bin/true'])
  const rootProbe = run([helper, '--reuid=0', '--regid=0', '--clear-groups', '--', '/bin/true'])
  if (!probe.ok || !rootProbe.ok) {
    return fail(`the helper cannot switch users (${probe.error || rootProbe.error || 'no permission'}). Containers started with no-new-privileges cannot use it.`)
  }

  const limits = limitsFromEnv(env)
  const configuredNetwork = (env.FUNCTIONS_SANDBOX_NETWORK ?? '').toLowerCase()
  const networks: Record<SandboxWorkload, SandboxNetwork> = {
    // A bubblewrap sandbox is safe by default: no network unless asked. The
    // setpriv-only mode keeps the host network because it is the compatibility
    // path for existing deployments and the API.
    function: configuredNetwork === 'shared' ? 'shared' : configuredNetwork === 'none' ? 'none' : setting === 'bwrap' ? 'none' : 'shared',
    site: 'shared',
    build: 'shared',
  }
  const cgroups = CgroupLimiter.setup({
    ...env,
    // A bwrap sandbox is for untrusted code, so require a resource budget by
    // default. Operators who cannot delegate cgroups can explicitly opt out.
    FUNCTIONS_CGROUPS: env.FUNCTIONS_CGROUPS ?? (setting === 'bwrap' ? 'on' : 'auto'),
  })

  const root = dirname(resolve(databasePath))
  mkdirSync(root, { recursive: true })
  process.umask(0o077)
  lockDown(root)
  try {
    chmodSync(root, 0o711)
  } catch {
    /* not ours */
  }

  const base = new SetprivSandbox(helper, root, cgroups, limits, networks)

  if (setting !== 'bwrap') {
    return base
  }

  const bwrap = env.FUNCTIONS_SANDBOX_BWRAP || 'bwrap'
  const version = run([bwrap, '--version'])
  if (!version.ok) return fail(`bubblewrap is not available at ${bwrap} (${version.error || 'not found'}).`)
  // Run the real sandbox once with /bin/true. This catches blocked user
  // namespaces, missing mount permissions and an unusable `--dev`/`--proc`
  // setup now, rather than at the first function run.
  const probeDir = join(root, `.sandbox-probe-${process.pid}`)
  const probePaths = { runtimeRoot: join(root, '.runtimes'), execPath: process.execPath, tmpMb: 16 }
  let sandboxProbe: { ok: boolean; error: string }
  try {
    mkdirSync(probeDir, { recursive: true, mode: 0o755 })
    chmodSync(probeDir, 0o755)
    sandboxProbe = run([
      helper,
      `--reuid=${FIRST_UID}`,
      `--regid=${FIRST_UID}`,
      '--clear-groups',
      '--no-new-privs',
      '--inh-caps=-all',
      '--',
      bwrap,
      ...bubblewrapArgs(probeDir, ['/bin/true'], { network: 'none' }, probePaths),
    ])
  } finally {
    rmSync(probeDir, { recursive: true, force: true })
  }
  if (!sandboxProbe.ok) {
    return fail(
      `bubblewrap cannot create a user namespace (${sandboxProbe.error || 'no permission'}). Enable unprivileged user namespaces, or run the container with a seccomp/AppArmor profile that allows them.`,
    )
  }
  if (!cgroups) {
    console.warn('[functions] bubblewrap is on but resource limits are off: no writable cgroup v2 subtree. Set FUNCTIONS_CGROUP_ROOT.')
  }
  if (networks.function === 'shared') {
    console.warn(
      '[functions] bubblewrap network is shared: functions can still reach the API and local services. Set FUNCTIONS_SANDBOX_NETWORK=none for code that needs no network.',
    )
  }
  return new BubblewrapSandbox(base, bwrap, {
    runtimeRoot: join(root, '.runtimes'),
    execPath: process.execPath,
    tmpMb: whole(env.FUNCTIONS_SANDBOX_TMP_MB, DEFAULT_TMP_MB, 1),
  })
}
