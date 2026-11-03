/**
 * `bunwrite install` / `bunwrite upgrade`.
 *
 * The Appwrite-style one-liner runs this image with the host Docker socket and
 * a directory mounted at /usr/src/code/bunwrite:
 *
 *   docker run -it --rm --user 0 \
 *     -v /var/run/docker.sock:/var/run/docker.sock \
 *     -v "$(pwd)/bunwrite:/usr/src/code/bunwrite:rw" \
 *     --entrypoint=install \
 *     ghcr.io/ridhotamma/bunwrite:latest
 *
 * The command writes a self-contained compose file and .env into the mounted
 * directory, then starts the stack as sibling containers through the host
 * socket. Caddy's configuration files are mounted back from the host, so their
 * paths are rewritten to the host path detected from this container's mounts.
 */
import { spawnSync } from 'node:child_process'
import {
  accessSync,
  chmodSync,
  chownSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { join, resolve } from 'node:path'

import composeTemplate from '../../deploy/install/docker-compose.yml' with { type: 'text' }
import envExample from '../../.env.example' with { type: 'text' }
import caddyfile from '../../Caddyfile' with { type: 'text' }
import caddyfileExternal from '../../Caddyfile.external' with { type: 'text' }
import caddyfileOff from '../../Caddyfile.off' with { type: 'text' }
import caddyEntrypoint from '../../scripts/caddy-entrypoint.sh' with { type: 'text' }

export type InstallCommand = 'install' | 'upgrade'
export type TlsMode = 'acme' | 'external' | 'off'

const DEFAULT_TARGET = '/usr/src/code/bunwrite'
const BAKED_IMAGE = '/usr/local/share/bunwrite/image'
const BAKED_VERSION = '/usr/local/share/bunwrite/version'
const PROJECT_NAME = 'bunwrite'
const HEALTH_TIMEOUT_MS = 180_000

const USAGE = `Bunwrite installer

Usage:
  bunwrite install [options]   Write the stack into a directory and start it
  bunwrite upgrade [options]   Update an existing installation

Options:
  --domain <host>          Public hostname (blank for localhost)
  --http-port <port>       Host port for Caddy HTTP (default 80)
  --https-port <port>      Host port for Caddy HTTPS (default 443)
  --app-port <port>        Host port for Bunwrite (default 8080)
  --app-bind <address>     Bunwrite bind address (default 127.0.0.1)
  --caddy-bind <address>   Caddy bind address (default 0.0.0.0)
  --tls-mode <mode>        acme, external or off (default acme)
  --caddy                  Run the bundled Caddy (default on a new install)
  --no-caddy               Do not run the bundled Caddy
  --no-admin               Do not create the first console admin
  --admin-email <email>    First console admin email
  --admin-password <pass>  First console admin password
  --image <ref>            Image to deploy (default: this image)
  --target <dir>           Install directory (default: /usr/src/code/bunwrite
                           in the image, ./bunwrite on a host)
  --host-path <path>       Host path of that directory (detected by default)
  --no-start               Write the files but do not start the containers
  --no-pull                Do not pull the image before starting
  --non-interactive        Never prompt
  -y, --yes                Accept defaults without prompting
  -h, --help               Show this help
`

interface Flags {
  help: boolean
  noStart: boolean
  noPull: boolean
  caddy?: boolean
  noCaddy: boolean
  noAdmin: boolean
  interactive?: boolean
  yes: boolean
  domain?: string
  httpPort?: string
  httpsPort?: string
  appPort?: string
  appBind?: string
  caddyBind?: string
  tlsMode?: TlsMode
  adminEmail?: string
  adminPassword?: string
  image?: string
  target?: string
  hostPath?: string
  provided: Set<string>
}

export interface InstallContext {
  env?: NodeJS.ProcessEnv
  interactive?: boolean
  log?: (...args: unknown[]) => void
  warn?: (...args: unknown[]) => void
}

const VALUE_FLAGS = new Set([
  'domain',
  'http-port',
  'https-port',
  'app-port',
  'app-bind',
  'caddy-bind',
  'tls-mode',
  'admin-email',
  'admin-password',
  'image',
  'target',
  'host-path',
])

export function parseInstallArgs(argv: string[]): Flags {
  const flags: Flags = {
    help: false,
    noStart: false,
    noPull: false,
    noCaddy: false,
    noAdmin: false,
    yes: false,
    provided: new Set(),
  }

  const set = (key: string, value: string) => {
    flags.provided.add(key)
    switch (key) {
      case 'domain':
        flags.domain = value
        break
      case 'http-port':
        flags.httpPort = value
        break
      case 'https-port':
        flags.httpsPort = value
        break
      case 'app-port':
        flags.appPort = value
        break
      case 'app-bind':
        flags.appBind = value
        break
      case 'caddy-bind':
        flags.caddyBind = value
        break
      case 'tls-mode': {
        const mode = value.trim().toLowerCase()
        if (mode !== 'acme' && mode !== 'external' && mode !== 'off') {
          throw new Error(`Unknown TLS mode "${value}". Expected acme, external or off.`)
        }
        flags.tlsMode = mode
        break
      }
      case 'admin-email':
        flags.adminEmail = value
        break
      case 'admin-password':
        flags.adminPassword = value
        break
      case 'image':
        flags.image = value
        break
      case 'target':
        flags.target = value
        break
      case 'host-path':
        flags.hostPath = value
        break
    }
  }

  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!
    if (raw === '--') break
    if (!raw.startsWith('-')) throw new Error(`Unexpected argument: ${raw}`)

    const [flag, inline] = raw.startsWith('--') ? (raw.slice(2).split('=', 2) as [string, string | undefined]) : [raw.replace(/^-/, ''), undefined]
    const value = () => {
      if (inline !== undefined) return inline
      const next = argv[++i]
      if (next === undefined) throw new Error(`Missing value for --${flag}`)
      return next
    }

    switch (flag) {
      case 'h':
      case 'help':
        flags.help = true
        break
      case 'y':
      case 'yes':
        flags.yes = true
        break
      case 'no-start':
        flags.noStart = true
        break
      case 'no-pull':
        flags.noPull = true
        break
      case 'no-caddy':
        flags.caddy = false
        flags.noCaddy = true
        break
      case 'caddy':
        flags.caddy = true
        flags.noCaddy = false
        break
      case 'no-admin':
        flags.noAdmin = true
        break
      case 'non-interactive':
        flags.interactive = false
        break
      case 'interactive': {
        const input = value().trim().toLowerCase()
        flags.interactive = input === '' || input === 'y' || input === 'yes' || input === '1' || input === 'true'
        break
      }
      default:
        if (!VALUE_FLAGS.has(flag)) throw new Error(`Unknown option: ${raw}`)
        set(flag, value())
        break
    }
  }

  for (const [name, port] of [
    ['HTTP', flags.httpPort],
    ['HTTPS', flags.httpsPort],
    ['app', flags.appPort],
  ] as const) {
    if (port !== undefined) validatePort(name, port)
  }

  return flags
}

function validatePort(name: string, value: string): void {
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65_535) {
    throw new Error(`Invalid ${name} port "${value}". Use a number from 1 to 65535.`)
  }
}

/** Strip a pasted scheme, path and port from a domain. */
export function normalizeDomain(input: string): string {
  return input
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '')
    .replace(/\.$/, '')
    .toLowerCase()
}

function validateDomain(domain: string): void {
  if (!domain) return
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(domain) || domain.includes('..')) {
    throw new Error(`Invalid domain "${domain}". Use a hostname such as appwrite.example.com.`)
  }
}

function isContainer(): boolean {
  return existsSync('/.dockerenv') || existsSync('/run/.containerenv')
}

function containerId(): string {
  try {
    const id = readFileSync('/etc/hostname', 'utf8').trim()
    if (id) return id
  } catch {
    // fall through to the hostname command
  }
  const result = spawnSync('hostname', [], { encoding: 'utf8' })
  return (result.stdout ?? '').trim()
}

interface Capture {
  code: number
  out: string
  err: string
}

function capture(cmd: string[], env: NodeJS.ProcessEnv): Capture {
  const result = spawnSync(cmd[0]!, cmd.slice(1), { encoding: 'utf8', env })
  const out = typeof result.stdout === 'string' ? result.stdout.trim() : ''
  const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : ''
  return {
    code: result.status ?? 1,
    out,
    err: stderr || result.error?.message || '',
  }
}

function run(cmd: string[], env: NodeJS.ProcessEnv): number {
  const result = spawnSync(cmd[0]!, cmd.slice(1), { env, stdio: 'inherit' })
  return result.status ?? 1
}

function bakedImage(): string | undefined {
  try {
    const image = readFileSync(BAKED_IMAGE, 'utf8').trim()
    if (image) return image
  } catch {
    // source checkout or an image built without the release arguments
  }
  return undefined
}

function bakedVersion(): string {
  try {
    return readFileSync(BAKED_VERSION, 'utf8').trim() || 'dev'
  } catch {
    return 'dev'
  }
}

function selfImage(env: NodeJS.ProcessEnv): string | undefined {
  if (!isContainer()) return undefined
  const result = capture(['docker', 'inspect', '--format', '{{.Config.Image}}', containerId()], env)
  return result.code === 0 ? result.out || undefined : undefined
}

function defaultImage(env: NodeJS.ProcessEnv): string {
  return env.BUNWRITE_IMAGE?.trim() || bakedImage() || selfImage(env) || 'bunwrite:latest'
}

/** Host path of `targetDir`, as the Docker daemon understands it. */
export function detectHostPath(targetDir: string, env: NodeJS.ProcessEnv): string | undefined {
  if (env.BUNWRITE_HOST_PATH?.trim()) return env.BUNWRITE_HOST_PATH.trim()
  if (!isContainer()) return resolve(targetDir)

  const format = `{{range .Mounts}}{{if eq .Destination "${targetDir}"}}{{.Source}}{{end}}{{end}}`
  const result = capture(['docker', 'inspect', '--format', format, containerId()], env)
  if (result.code !== 0) return undefined
  const source = result.out
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean)
  return source || undefined
}

function isHostAbsolute(path: string): boolean {
  return path.startsWith('/') || /^[a-z]:[\\/]/i.test(path) || path.startsWith('\\\\')
}

function joinHostPath(base: string, child: string): string {
  if (isHostAbsolute(child)) return child
  return `${base.replace(/[\\/]+$/, '')}/${child.replace(/^[./\\]+/, '')}`
}

function quoteEnv(value: string): string {
  if (value === '' || /^[A-Za-z0-9_./:@+,=-]+$/.test(value)) return value
  if (!value.includes("'")) return `'${value}'`
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function unquoteEnv(raw: string): string {
  const value = raw.trim()
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1)
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  const comment = value.search(/\s#/)
  return comment === -1 ? value : value.slice(0, comment).trim()
}

export function parseEnv(content: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const line of content.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (match) values[match[1]!] = unquoteEnv(match[2]!)
  }
  return values
}

/** Replace a key, including its commented example, or append it. */
export function setEnvValue(content: string, key: string, value: string): string {
  const line = `${key}=${quoteEnv(value)}`
  const pattern = new RegExp(`^[\\t ]*(?:#[\\t ]*)?${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\t ]*=.*$`, 'm')
  if (pattern.test(content)) return content.replace(pattern, () => line)
  const prefix = content.endsWith('\n') ? content : `${content}\n`
  return `${prefix}${line}\n`
}

function hasEnvKey(content: string, key: string): boolean {
  return new RegExp(`^[\\t ]*(?:export[\\t ]+)?${key}[\\t ]*=`, 'm').test(content)
}

function generatePassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18))
  return Buffer.from(bytes).toString('base64url')
}

function adminEmailFor(domain: string): string {
  const host = /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain) ? domain : 'bunwrite.local'
  return `admin@${host}`
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')
}

function backup(path: string): void {
  const target = `${path}.${timestamp()}.backup`
  copyFileSync(path, target)
  try {
    chmodSync(target, statSync(path).mode & 0o777)
  } catch {
    // Ownership or ACLs may prevent the chmod; the copy is still a backup.
  }
}

function writeFile(path: string, content: string, mode: number): void {
  const temporary = `${path}.tmp-${process.pid}`
  writeFileSync(temporary, content, { mode })
  chmodSync(temporary, mode)
  renameSync(temporary, path)
}

function writeIfChanged(path: string, content: string, mode: number): boolean {
  if (existsSync(path)) {
    const current = readFileSync(path, 'utf8')
    if (current === content) {
      chmodSync(path, mode)
      return false
    }
    backup(path)
  }
  writeFile(path, content, mode)
  return true
}

export function renderCompose(template: string, hostPath: string, image: string): string {
  const host = hostPath.replace(/\\/g, '/').replace(/'/g, "''")
  return template.replaceAll('__BUNWRITE_HOST_PATH__', host).replaceAll('__BUNWRITE_IMAGE__', image)
}

interface ResolvedSettings {
  image: string
  domain: string
  tlsMode: TlsMode
  caddy: boolean
  httpPort: string
  httpsPort: string
  appPort: string
  appBind: string
  caddyBind: string
  adminEmail?: string
  adminPassword?: string
}

function resolveSettings(flags: Flags, current: Record<string, string>, env: NodeJS.ProcessEnv, existingInstall: boolean): ResolvedSettings {
  const image = flags.image?.trim() || defaultImage(env)
  if (!image) throw new Error('No image to deploy. Pass --image.')
  if (!/^[A-Za-z0-9][A-Za-z0-9._/@:+-]*$/.test(image)) throw new Error(`Invalid image reference "${image}".`)

  const domain = flags.domain !== undefined ? normalizeDomain(flags.domain) : (current.DOMAIN ?? '')
  validateDomain(domain)

  const tlsMode = (flags.tlsMode || current.TLS_MODE || 'acme') as TlsMode
  if (tlsMode !== 'acme' && tlsMode !== 'external' && tlsMode !== 'off') {
    throw new Error(`Invalid TLS_MODE "${tlsMode}" in .env. Expected acme, external or off.`)
  }

  const profiles = current.COMPOSE_PROFILES?.split(',').map((item) => item.trim()) ?? []
  const caddy =
    flags.caddy === false || flags.noCaddy
      ? false
      : flags.caddy === true
        ? true
        : current.COMPOSE_PROFILES !== undefined
          ? profiles.includes('caddy')
          : !existingInstall

  const httpPort = flags.httpPort || current.BUNWRITE_HTTP_PORT || '80'
  const httpsPort = flags.httpsPort || current.BUNWRITE_HTTPS_PORT || '443'
  const appPort = flags.appPort || current.BUNWRITE_PORT || '8080'
  for (const [name, port] of [
    ['HTTP', httpPort],
    ['HTTPS', httpsPort],
    ['app', appPort],
  ] as const) {
    validatePort(name, port)
  }

  const appBind = flags.appBind || current.BUNWRITE_BIND || '127.0.0.1'
  const caddyBind = flags.caddyBind || current.BUNWRITE_HTTP_BIND || '0.0.0.0'
  for (const [name, bind] of [
    ['Bunwrite', appBind],
    ['Caddy', caddyBind],
  ] as const) {
    if (!/^[A-Za-z0-9.:-]+$/.test(bind)) throw new Error(`Invalid ${name} bind address "${bind}".`)
  }

  return {
    image,
    domain,
    tlsMode,
    caddy,
    httpPort,
    httpsPort,
    appPort,
    appBind,
    caddyBind,
    adminEmail: flags.adminEmail || current.CONSOLE_ADMIN_EMAIL || undefined,
    adminPassword: flags.adminPassword || current.CONSOLE_ADMIN_PASSWORD || undefined,
  }
}

function applyFreshEnv(settings: ResolvedSettings, hostPath: string): string {
  let content = `# Generated by \`bunwrite install\`. Edit freely; upgrades keep this file.\n${envExample}`
  content = setEnvValue(content, 'DOMAIN', settings.domain)
  content = setEnvValue(content, 'COMPOSE_PROFILES', settings.caddy ? 'caddy' : '')
  content = setEnvValue(content, 'TLS_MODE', settings.tlsMode)
  content = setEnvValue(content, 'TLS_CERT_DIR', joinHostPath(hostPath, 'certs'))
  content = setEnvValue(content, 'BUNWRITE_BIND', settings.appBind)
  content = setEnvValue(content, 'BUNWRITE_PORT', settings.appPort)
  content = setEnvValue(content, 'BUNWRITE_HTTP_BIND', settings.caddyBind)
  content = setEnvValue(content, 'BUNWRITE_HTTP_PORT', settings.httpPort)
  content = setEnvValue(content, 'BUNWRITE_HTTPS_PORT', settings.httpsPort)
  if (settings.adminEmail && settings.adminPassword) {
    content = setEnvValue(content, 'CONSOLE_ADMIN_EMAIL', settings.adminEmail)
    content = setEnvValue(content, 'CONSOLE_ADMIN_PASSWORD', settings.adminPassword)
  }
  return content
}

function applyExistingEnv(content: string, flags: Flags, settings: ResolvedSettings, hostPath: string, command: InstallCommand): string {
  const current = parseEnv(content)
  const updates: Array<[string, string]> = []

  const updateIfProvided = (flag: string, key: string, value: string | undefined) => {
    if (flags.provided.has(flag) && value !== undefined) updates.push([key, value])
  }

  updateIfProvided('domain', 'DOMAIN', settings.domain)
  updateIfProvided('http-port', 'BUNWRITE_HTTP_PORT', settings.httpPort)
  updateIfProvided('https-port', 'BUNWRITE_HTTPS_PORT', settings.httpsPort)
  updateIfProvided('app-port', 'BUNWRITE_PORT', settings.appPort)
  updateIfProvided('app-bind', 'BUNWRITE_BIND', settings.appBind)
  updateIfProvided('caddy-bind', 'BUNWRITE_HTTP_BIND', settings.caddyBind)
  updateIfProvided('tls-mode', 'TLS_MODE', settings.tlsMode)
  if (flags.noCaddy || flags.caddy === false) updates.push(['COMPOSE_PROFILES', ''])
  if (flags.caddy === true) updates.push(['COMPOSE_PROFILES', 'caddy'])

  // Keys the generated compose needs. Add them to older hand-written .env
  // files without replacing values the operator already chose.
  const defaults: Array<[string, string]> = [
    ['BUNWRITE_BIND', settings.appBind],
    ['BUNWRITE_PORT', settings.appPort],
    ['BUNWRITE_HTTP_BIND', settings.caddyBind],
    ['BUNWRITE_HTTP_PORT', settings.httpPort],
    ['BUNWRITE_HTTPS_PORT', settings.httpsPort],
    ['TLS_MODE', settings.tlsMode],
  ]
  for (const [key, value] of defaults) {
    if (!hasEnvKey(content, key)) updates.push([key, value])
  }

  const certDir = current.TLS_CERT_DIR
  if (!certDir || !isHostAbsolute(certDir)) {
    updates.push(['TLS_CERT_DIR', joinHostPath(hostPath, certDir || 'certs')])
  }

  if (command === 'install' && !flags.noAdmin) {
    const email = flags.adminEmail ?? current.CONSOLE_ADMIN_EMAIL ?? settings.adminEmail
    const password = flags.adminPassword ?? current.CONSOLE_ADMIN_PASSWORD ?? settings.adminPassword
    if (email && !current.CONSOLE_ADMIN_EMAIL) updates.push(['CONSOLE_ADMIN_EMAIL', email])
    if (password && !current.CONSOLE_ADMIN_PASSWORD) updates.push(['CONSOLE_ADMIN_PASSWORD', password])
  }

  const merged = new Map<string, string>()
  for (const [key, value] of updates) merged.set(key, value)
  for (const [key, value] of merged) content = setEnvValue(content, key, value)
  return content
}

async function ask(question: string): Promise<string> {
  const readline = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return (await readline.question(question)).trim()
  } finally {
    readline.close()
  }
}

function composeArgs(targetDir: string): string[] {
  return ['docker', 'compose', '--project-name', PROJECT_NAME, '--env-file', join(targetDir, '.env'), '-f', join(targetDir, 'docker-compose.yml')]
}

function requireDocker(env: NodeJS.ProcessEnv): void {
  const version = capture(['docker', 'version', '--format', '{{.Server.Version}}'], env)
  if (version.code !== 0) {
    const detail = version.err ? `\n${version.err}` : ''
    throw new Error(
      'Cannot talk to the Docker daemon. Run the installer as root with the host socket mounted:\n' +
        '  --user 0 --volume /var/run/docker.sock:/var/run/docker.sock' +
        detail,
    )
  }
  const compose = capture(['docker', 'compose', 'version'], env)
  if (compose.code !== 0) {
    throw new Error('Docker Compose v2 is not available. Use an image that includes the compose plugin.')
  }
}

function imageExists(image: string, env: NodeJS.ProcessEnv): boolean {
  return capture(['docker', 'image', 'inspect', image], env).code === 0
}

function pullImage(targetDir: string, image: string, env: NodeJS.ProcessEnv, noPull: boolean): void {
  if (noPull) {
    if (!imageExists(image, env)) throw new Error(`Image "${image}" is not present locally and --no-pull was passed.`)
    return
  }
  const result = run([...composeArgs(targetDir), 'pull'], env)
  if (result === 0) return
  if (imageExists(image, env)) {
    process.stderr.write(`[install] Could not pull ${image}; continuing with the local image.\n`)
    return
  }
  throw new Error(`Could not pull "${image}". Check the image name and registry credentials.`)
}

async function waitForHealthy(targetDir: string, env: NodeJS.ProcessEnv, log: (...args: unknown[]) => void): Promise<boolean> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS
  let last = ''
  while (Date.now() < deadline) {
    const ids = capture([...composeArgs(targetDir), 'ps', '-q', PROJECT_NAME], env)
      .out.split('\n')
      .filter(Boolean)
    if (ids.length > 0) {
      const id = ids[0]!
      const status = capture(['docker', 'inspect', '--format', '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}', id], env).out
      const hasHealth = capture(['docker', 'inspect', '--format', '{{if .State.Health}}yes{{end}}', id], env).out === 'yes'
      if (status !== last) {
        log(`[install] Container ${status || 'starting'}...`)
        last = status
      }
      if (status === 'healthy' || (!hasHealth && status === 'running')) return true
      if (status === 'unhealthy' || status === 'exited' || status === 'dead') return false
    }
    await Bun.sleep(2_000)
  }
  return false
}

function bootstrapDetails(targetDir: string, env: NodeJS.ProcessEnv): { orgId?: string; projectId?: string } {
  const logs = capture([...composeArgs(targetDir), 'logs', '--no-color', '--no-log-prefix', '--tail', '200', PROJECT_NAME], env).out
  return {
    orgId: /ORG_ID=(\S+)/.exec(logs)?.[1],
    projectId: /PROJECT_ID=(\S+)/.exec(logs)?.[1],
  }
}

function consoleUrl(settings: ResolvedSettings): string {
  if (!settings.caddy) {
    const host = settings.appBind === '0.0.0.0' ? 'localhost' : settings.appBind
    return `http://${host}:${settings.appPort}/console`
  }
  const scheme = settings.tlsMode === 'off' ? 'http' : 'https'
  const host = settings.domain || 'localhost'
  const port = scheme === 'https' ? settings.httpsPort : settings.httpPort
  const suffix = (scheme === 'https' && port !== '443') || (scheme === 'http' && port !== '80') ? `:${port}` : ''
  return `${scheme}://${host}${suffix}/console`
}

function printSummary(
  hostPath: string,
  settings: ResolvedSettings,
  log: (...args: unknown[]) => void,
  details: { orgId?: string; projectId?: string } = {},
  showAdmin = false,
  showSetup = false,
): void {
  log('')
  log(`Bunwrite is running (${settings.image}).`)
  log(`  Console: ${consoleUrl(settings)}`)
  log(`  Data:    docker volume ${PROJECT_NAME}_bunwrite-data`)
  log(`  Files:   ${hostPath}`)
  if (showAdmin && settings.adminEmail && settings.adminPassword) {
    log('')
    log('  First console admin (save this password):')
    log(`    Email:    ${settings.adminEmail}`)
    log(`    Password: ${settings.adminPassword}`)
    log('    Remove CONSOLE_ADMIN_PASSWORD from .env after the first sign-in.')
  } else if (showSetup) {
    log('')
    log(`  First admin: ${consoleUrl(settings)}/setup (open until the first admin exists)`)
  }
  if (details.orgId || details.projectId) {
    log('')
    if (details.orgId) log(`  Organization ID: ${details.orgId}`)
    if (details.projectId) log(`  Project ID:      ${details.projectId}`)
  }
  log('')
  log(`  Logs:    cd '${hostPath}' && docker compose logs -f bunwrite`)
  log(`  Upgrade: run the new image with --entrypoint=upgrade and the same volume.`)
  if (settings.caddy && !settings.domain) {
    log('  Note:    DOMAIN is empty, so Caddy uses its local CA. Expect a browser warning.')
  }
  if (settings.caddy && settings.tlsMode === 'external') {
    log(`  TLS:     put the certificate and key in '${hostPath}/certs' and set TLS_CERT_FILE/TLS_KEY_FILE.`)
  }
}

function assertWritable(targetDir: string): void {
  try {
    accessSync(targetDir, fsConstants.W_OK)
  } catch {
    throw new Error(
      `Cannot write to ${targetDir}.\n` +
        'The installer runs as the image user (bunwrite). Re-run it as root, for example:\n' +
        '  docker run ... --user 0 --entrypoint=install <image>',
    )
  }
}

function chownGenerated(targetDir: string, files: string[]): void {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return
  try {
    const owner = statSync(targetDir)
    for (const file of files) {
      try {
        chownSync(file, owner.uid, owner.gid)
      } catch {
        // Best effort: a filesystem that does not map ownership can still keep the files.
      }
    }
  } catch {
    // The directory may have disappeared; the write above would already have failed.
  }
}

export async function runInstall(command: InstallCommand, argv: string[], context: InstallContext = {}): Promise<number> {
  const env = context.env ?? process.env
  const log = context.log ?? console.log
  const warn = context.warn ?? console.warn

  try {
    const flags = parseInstallArgs(argv)
    if (flags.help) {
      console.log(USAGE)
      return 0
    }
    const interactive = flags.yes ? false : (flags.interactive ?? context.interactive ?? Boolean(process.stdin.isTTY))

    const targetDir = resolve(flags.target ?? env.BUNWRITE_INSTALL_DIR ?? (isContainer() ? DEFAULT_TARGET : 'bunwrite'))
    const composePath = join(targetDir, 'docker-compose.yml')
    const envPath = join(targetDir, '.env')
    const hasEnv = existsSync(envPath)
    const existingInstall = existsSync(composePath) && hasEnv

    if (command === 'upgrade' && !existingInstall) {
      throw new Error(`No installation found in ${targetDir}.\n` + 'Run the installer against the directory that contains docker-compose.yml and .env.')
    }

    if (!flags.noStart) {
      requireDocker(env)
    }

    try {
      mkdirSync(targetDir, { recursive: true })
    } catch {
      throw new Error(`Cannot create ${targetDir}. Create it on the host and make it writable by this container.`)
    }
    assertWritable(targetDir)

    const hostPath = (flags.hostPath ?? detectHostPath(targetDir, env))?.replace(/[\\/]+$/, '')
    if (!hostPath) {
      throw new Error(
        `Could not detect the host path for ${targetDir}.\n` + 'Mount the directory at /usr/src/code/bunwrite, or pass --host-path /absolute/path.',
      )
    }
    if (!isHostAbsolute(hostPath)) {
      throw new Error(`--host-path must be absolute, got "${hostPath}".`)
    }

    const currentContent = hasEnv ? readFileSync(envPath, 'utf8') : ''
    const current = parseEnv(currentContent)
    const hadAdmin = Boolean(current.CONSOLE_ADMIN_EMAIL && current.CONSOLE_ADMIN_PASSWORD)

    let domain = flags.domain !== undefined ? normalizeDomain(flags.domain) : (current.DOMAIN ?? '')
    if (!hasEnv && flags.domain === undefined && interactive && !flags.noCaddy) {
      const answer = await ask('Domain name (leave blank for localhost): ')
      if (answer) domain = normalizeDomain(answer)
      flags.domain = domain
      flags.provided.add('domain')
    }
    validateDomain(domain)

    const settings = resolveSettings({ ...flags, domain }, current, env, existingInstall)
    settings.domain = domain

    if (command === 'install' && !flags.noAdmin) {
      if (!settings.adminEmail) settings.adminEmail = adminEmailFor(domain)
      if (!settings.adminPassword) settings.adminPassword = generatePassword()
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(settings.adminEmail)) {
        throw new Error(`Invalid console admin email "${settings.adminEmail}". Pass --admin-email.`)
      }
      if (settings.adminPassword.length < 8) {
        throw new Error('The console admin password must be at least 8 characters.')
      }
    }
    const showAdmin = command === 'install' && !flags.noAdmin && !hadAdmin
    const showSetup = command === 'install' && !existingInstall && (flags.noAdmin || !settings.adminEmail)
    if (hadAdmin && (flags.adminEmail !== undefined || flags.adminPassword !== undefined)) {
      warn('[install] A console admin already exists; --admin-email/--admin-password do not change it.')
      warn(`[install] Reset it with: cd '${hostPath}' && docker compose exec bunwrite bunwrite console:admin <email>`)
    }

    if (existingInstall) {
      log(`[install] Existing installation found in ${targetDir}; updating it in place.`)
    } else if (hasEnv) {
      log(`[install] Reusing the existing .env in ${targetDir}.`)
    }
    log(`[install] Bunwrite ${bakedVersion()} (${settings.image})`)
    log(`[install] Host directory: ${hostPath}`)

    const envContent = hasEnv ? applyExistingEnv(currentContent, { ...flags, domain }, settings, hostPath, command) : applyFreshEnv(settings, hostPath)

    const composeContent = renderCompose(composeTemplate, hostPath, settings.image)

    const generated: string[] = [envPath, composePath]
    writeIfChanged(envPath, envContent, 0o600)
    chmodSync(envPath, 0o600)
    writeIfChanged(composePath, composeContent, 0o644)

    const assets: Array<[string, string, number]> = [
      ['Caddyfile', caddyfile, 0o644],
      ['Caddyfile.external', caddyfileExternal, 0o644],
      ['Caddyfile.off', caddyfileOff, 0o644],
      ['caddy-entrypoint.sh', caddyEntrypoint, 0o755],
    ]
    for (const [name, content, mode] of assets) {
      const path = join(targetDir, name)
      writeIfChanged(path, content, mode)
      generated.push(path)
    }
    const certs = join(targetDir, 'certs')
    mkdirSync(certs, { recursive: true, mode: 0o755 })
    chmodSync(certs, 0o755)
    generated.push(certs)

    chownGenerated(targetDir, generated)

    if (flags.noStart) {
      log('')
      log('Files written. Start the stack with:')
      log(`  cd '${hostPath}' && docker compose up -d`)
      if (showAdmin && settings.adminEmail && settings.adminPassword) {
        log('')
        log(`First console admin: ${settings.adminEmail} / ${settings.adminPassword}`)
      } else if (showSetup) {
        log('')
        log(`First admin: ${consoleUrl(settings)}/setup (open until the first admin exists)`)
      }
      return 0
    }

    pullImage(targetDir, settings.image, env, flags.noPull)

    // Switching an existing install from the bundled proxy to an external one
    // must stop the old Caddy, or it keeps holding ports 80/443.
    if (!settings.caddy) {
      capture([...composeArgs(targetDir), '--profile', 'caddy', 'rm', '-s', '-f', 'caddy'], env)
    }

    const up = run([...composeArgs(targetDir), 'up', '-d', '--remove-orphans'], env)
    if (up !== 0) throw new Error('docker compose up failed. See the output above.')

    const healthy = await waitForHealthy(targetDir, env, log)
    if (!healthy) {
      run([...composeArgs(targetDir), 'ps'], env)
      run([...composeArgs(targetDir), 'logs', '--tail', '80', PROJECT_NAME], env)
      throw new Error('Bunwrite did not become healthy in time. See the logs above.')
    }

    if (settings.caddy) {
      const caddyId = capture([...composeArgs(targetDir), 'ps', '-q', 'caddy'], env)
        .out.split('\n')
        .find(Boolean)
      if (caddyId) {
        const status = capture(['docker', 'inspect', '--format', '{{.State.Status}}', caddyId], env).out
        if (status !== 'running') {
          warn(`[install] Caddy is ${status || 'not running'}; check: cd '${hostPath}' && docker compose logs caddy`)
        }
      }
    }

    const details = bootstrapDetails(targetDir, env)
    printSummary(hostPath, settings, log, details, showAdmin, showSetup)
    warn('')
    warn('[install] The installer talks to the host Docker daemon. Keep /var/run/docker.sock private.')
    return 0
  } catch (error) {
    console.error(`\n[install] ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

if (import.meta.main) {
  const [first, ...rest] = process.argv.slice(2)
  const command: InstallCommand = first === 'upgrade' ? 'upgrade' : 'install'
  const argv = first === 'install' || first === 'upgrade' ? rest : process.argv.slice(2)
  process.exitCode = await runInstall(command, argv)
}
