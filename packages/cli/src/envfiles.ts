/**
 * The .env files behind `bunwrite env`, read and written in place so comments
 * and order survive a pull.
 *
 * For an environment named `staging`, later files win:
 *
 *   .env                  shared by every environment
 *   .env.staging          this environment
 *   .env.staging.local    this environment's secrets (keep out of git)
 *
 * Without an environment: `.env`, then `.env.local`. A variable from a
 * `.local` file is stored as secret on the server.
 */
import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import type { ProjectConfig } from './config'
import { projectDir } from './environments'

export interface EnvLine {
  key: string
  value: string
  /** Lines [start, end) of the file that hold this entry. */
  start: number
  end: number
}

export interface EnvFile {
  path: string
  /** Shown to people: relative to the project folder. */
  label: string
  secret: boolean
  /** The environment's own file (pull writes here); false for the shared .env of an environment. */
  own: boolean
}

export interface EnvValue {
  value: string
  secret: boolean
  /** The file it came from (the last one that sets it). */
  file: EnvFile
}

const ENTRY = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/

function unescapeDouble(text: string): string {
  return text.replace(/\\([\\"nrt$])/g, (_, c: string) => ({ n: '\n', r: '\r', t: '\t' })[c] ?? c)
}

/** Parse dotenv text: `KEY=value`, `export KEY=value`, quotes, `#` comments, multi-line double quotes. */
export function parseEnv(text: string): EnvLine[] {
  const lines = text.split(/\r?\n/)
  const out: EnvLine[] = []
  for (let i = 0; i < lines.length; i++) {
    const match = ENTRY.exec(lines[i]!)
    if (!match) continue
    const key = match[1]!
    let raw = match[2]!
    const start = i
    let value: string
    if (raw.startsWith('"')) {
      // Find the closing quote, across lines if needed.
      let body = raw.slice(1)
      let close = closingQuote(body)
      while (close < 0 && i + 1 < lines.length) {
        body += '\n' + lines[++i]
        close = closingQuote(body)
      }
      value = unescapeDouble(close < 0 ? body : body.slice(0, close))
    } else if (raw.startsWith("'")) {
      const close = raw.indexOf("'", 1)
      value = close < 0 ? raw.slice(1) : raw.slice(1, close)
    } else {
      // An unquoted value ends at ` #`; `KEY=  # note` is empty.
      const hash = raw.search(/(^|\s)#/)
      value = (hash < 0 ? raw : raw.slice(0, hash)).trim()
    }
    out.push({ key, value, start, end: i + 1 })
  }
  return out
}

function closingQuote(body: string): number {
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\\') i++
    else if (body[i] === '"') return i
  }
  return -1
}

/** A value as it should appear after `KEY=`. */
export function formatValue(value: string): string {
  if (/^[A-Za-z0-9_./:@,+=%-]*$/.test(value)) return value
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\$/g, '\\$')}"`
}

export function readEnvFile(path: string): Map<string, string> {
  const out = new Map<string, string>()
  if (!existsSync(path)) return out
  for (const entry of parseEnv(readFileSync(path, 'utf8'))) out.set(entry.key, entry.value)
  return out
}

/**
 * Apply changes to dotenv text: a string sets the key (in place when it is
 * there, else at the end), null removes it. Comments and other lines stay.
 */
export function editEnv(text: string, changes: Map<string, string | null>, comments: Map<string, string> = new Map()): string {
  const lines = text.length ? text.replace(/\r?\n$/, '').split(/\r?\n/) : []
  const entries = parseEnv(lines.join('\n'))
  const done = new Set<string>()
  // Work from the bottom so earlier line numbers stay right.
  for (const entry of [...entries].reverse()) {
    if (!changes.has(entry.key)) continue
    const next = changes.get(entry.key)
    // Only the last entry for a key counts; drop earlier duplicates when it changes.
    const replacement = next === null || done.has(entry.key) ? [] : [`${entry.key}=${formatValue(next!)}`]
    lines.splice(entry.start, entry.end - entry.start, ...replacement)
    done.add(entry.key)
  }
  for (const [key, value] of changes) {
    if (done.has(key) || value === null) continue
    const comment = comments.get(key)
    lines.push(`${key}=${formatValue(value)}${comment ? `  # ${comment}` : ''}`)
  }
  return lines.length ? lines.join('\n') + '\n' : ''
}

/** Where the .env files are: `envDir` from the config, relative to it, or the config's folder. */
export function envDir(config: ProjectConfig, dir = process.cwd()): string {
  const root = projectDir(dir)
  return config.envDir ? resolve(root, config.envDir) : root
}

/** The files for an environment (or none), in the order they apply. */
export function envFiles(config: ProjectConfig, name: string | null, dir = process.cwd()): EnvFile[] {
  const folder = envDir(config, dir)
  const root = projectDir(dir)
  const file = (base: string, secret: boolean, own: boolean): EnvFile => {
    const path = join(folder, base)
    return { path, label: relative(root, path) || base, secret, own }
  }
  if (!name) return [file('.env', false, true), file('.env.local', true, true)]
  return [file('.env', false, false), file(`.env.${name}`, false, true), file(`.env.${name}.local`, true, true)]
}

/** Every variable the files set, with the last file winning. */
export function mergeEnv(files: EnvFile[]): Map<string, EnvValue> {
  const out = new Map<string, EnvValue>()
  for (const file of files) {
    for (const [key, value] of readEnvFile(file.path)) out.set(key, { value, secret: file.secret, file })
  }
  return out
}

/** Names that look like credentials, so a value in a committed file gets a warning. */
export const SECRET_NAME = /(KEY|SECRET|TOKEN|PASSWORD|PASS|CREDENTIAL|PEPPER|PRIVATE|SERVICE_ACCOUNT)/i

/** Write a .env file; secret files are readable only by you. */
export function writeEnvFile(file: EnvFile, text: string): void {
  writeFileSync(file.path, text, file.secret ? { mode: 0o600 } : undefined)
  if (file.secret) chmodSync(file.path, 0o600)
}

/**
 * Make sure git ignores `.local` env files. Returns the .gitignore path when
 * a line was added.
 */
export function ignoreLocalFiles(dir = process.cwd()): string | null {
  const path = join(projectDir(dir), '.gitignore')
  const text = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const lines = text.split(/\r?\n/).map((l) => l.trim())
  if (lines.some((l) => ['.env*.local', '*.local', '**/.env*.local', '.env*', '.env.*'].includes(l))) return null
  appendFileSync(path, `${text && !text.endsWith('\n') ? '\n' : ''}# Secrets for bunwrite env (never commit)\n.env*.local\n`)
  return path
}
