/**
 * Function isolation inside the one container: every function builds and runs
 * as its own Linux user, which can read and write its own deployment folder
 * and nothing else of the server's (databases, uploads, backups, other
 * functions).
 *
 * The server runs as an ordinary user, so switching users goes through a
 * helper: util-linux `setpriv` with the setuid/setgid file capabilities,
 * installed so only the server's group may run it (see the Dockerfile).
 * Function processes get `--no-new-privs` and no capabilities, so they cannot
 * use the helper or any setuid program to climb back.
 *
 * With the sandbox on, the server creates files readable by itself only
 * (umask 077) and tightens what is already in the data folder; the folders on
 * the way to a function's code only allow passing through.
 *
 * FUNCTIONS_SANDBOX: `auto` (default; on when the helper works), `on`
 * (refuse to start without it) or `off`.
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

export const DEFAULT_HELPER = '/usr/local/libexec/bunwrite-sandbox'
const FIRST_UID = 20000
const LAST_UID = 59999

export interface FunctionSandbox {
  /** The data folder everything sandboxed lives under. */
  readonly root: string
  /** This function's user ID, the same for its whole life. */
  uidFor(projectId: string, functionId: string): number
  /** `cmd` as the function's user in `cwd`, with no way to gain privileges. */
  wrap(uid: number, cwd: string, cmd: string[]): string[]
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

class SetprivSandbox implements FunctionSandbox {
  private uids: Record<string, number> | null = null
  private readonly registry: string

  constructor(
    private readonly helper: string,
    readonly root: string,
  ) {
    this.registry = join(root, '.runtimes', 'function-users.json')
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

  wrap(uid: number, cwd: string, cmd: string[]): string[] {
    // The server cannot enter the folder, so change into it after becoming the function's user.
    return [this.helper, `--reuid=${uid}`, `--regid=${uid}`, '--clear-groups', '--no-new-privs', '--inh-caps=-all', '--', '/bin/sh', '-c', 'cd -- "$0" && exec "$@"', cwd, ...cmd]
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
    const giveHome = 'install -d -o "$1" -g "$1" -m 0700 "$2" && chown "$1:$1" "$2" && chmod 0700 "$2"'
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

/**
 * Turn the sandbox on when it can work. Call before the database opens, so
 * new files get the tight umask from the start.
 */
export function setupSandbox(databasePath: string, env: Record<string, string | undefined> = process.env): FunctionSandbox | null {
  const mode = (env.FUNCTIONS_SANDBOX ?? 'auto').toLowerCase()
  if (mode === 'off' || mode === 'false') return null
  const helper = env.FUNCTIONS_SANDBOX_HELPER || DEFAULT_HELPER
  const fail = (why: string) => {
    if (mode === 'on' || mode === 'true') throw new Error(`FUNCTIONS_SANDBOX=on, but ${why}`)
    return null
  }
  if (process.platform !== 'linux') return fail('function isolation needs Linux.')
  if (databasePath === ':memory:' || databasePath.startsWith('file::memory:')) return fail('the database is in memory, so there is no data folder to protect.')
  if (!existsSync(helper)) return fail(`the helper ${helper} is missing.`)
  const probe = run([helper, `--reuid=${FIRST_UID}`, `--regid=${FIRST_UID}`, '--clear-groups', '--no-new-privs', '--', '/bin/true'])
  const rootProbe = run([helper, '--reuid=0', '--regid=0', '--clear-groups', '--', '/bin/true'])
  if (!probe.ok || !rootProbe.ok) {
    const why = `the helper cannot switch users (${probe.error || rootProbe.error || 'no permission'}). Containers started with no-new-privileges cannot use it.`
    if (mode === 'on' || mode === 'true') throw new Error(`FUNCTIONS_SANDBOX=on, but ${why}`)
    console.warn(`[functions] isolation is off: ${why}`)
    return null
  }
  const root = dirname(resolve(databasePath))
  mkdirSync(root, { recursive: true })
  process.umask(0o077)
  lockDown(root)
  try {
    chmodSync(root, 0o711)
  } catch {
    /* not ours */
  }
  return new SetprivSandbox(helper, root)
}
