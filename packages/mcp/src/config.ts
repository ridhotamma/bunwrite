/**
 * Configuration for the Bunwrite MCP server.
 *
 * Self-hosted Bunwrite mirrors Appwrite's local MCP server: the process runs on
 * the developer's machine over stdio and talks to a project with an API key.
 * The hosted HTTP mode is optional and stateless.
 */
import { Client } from '@bunwrite/sdk'

export type Transport = 'stdio' | 'http'

export interface McpConfig {
  endpoint: string
  project: string
  key: string
  transport: Transport
  host: string
  port: number
  /** Hide write tools and refuse writes even with confirm_write. */
  readOnly: boolean
  /** Cap a single tool result; larger results are truncated with a note. */
  maxResultChars: number
  selfSigned: boolean
  docsDir?: string
}

export class ConfigError extends Error {}

type Env = Record<string, string | undefined>

const text = (value: string | undefined): string => (value ?? '').trim()

const bool = (value: string | undefined, fallback: boolean): boolean => {
  const setting = text(value).toLowerCase()
  if (!setting) return fallback
  if (['1', 'true', 'yes', 'on'].includes(setting)) return true
  if (['0', 'false', 'no', 'off'].includes(setting)) return false
  return fallback
}

const positive = (value: string | undefined, fallback: number, min: number, max: number): number => {
  const parsed = Number(text(value))
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.round(parsed)))
}

/** Accept `https://host` or `https://host/v1`; the SDK appends API paths. */
export function normalizeEndpoint(value: string): string {
  const endpoint = value.trim().replace(/\/+$/, '')
  if (!endpoint) return 'http://localhost:8080/v1'
  return /\/v1$/.test(endpoint) ? endpoint : `${endpoint}/v1`
}

interface ParsedArgs {
  values: Record<string, string>
  flags: Set<string>
}

function parse(argv: string[]): ParsedArgs {
  const values: Record<string, string> = {}
  const flags = new Set<string>()
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!
    if (!argument.startsWith('--')) continue
    const equals = argument.indexOf('=')
    if (equals > 2) {
      values[argument.slice(2, equals)] = argument.slice(equals + 1)
      continue
    }
    const name = argument.slice(2)
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith('--')) {
      values[name] = next
      index++
    } else {
      flags.add(name)
    }
  }
  return { values, flags }
}

export const USAGE = `Bunwrite MCP server

Usage:
  bunwrite-mcp [options]

Options:
  --endpoint <url>      Bunwrite endpoint, for example https://api.example.com/v1
  --project <id>        Project ID
  --key <key>           Project API key (server-side only)
  --transport <mode>    stdio (default) or http
  --host <host>         HTTP bind address (default 127.0.0.1)
  --port <port>         HTTP port (default 7801)
  --read-only           Hide and refuse write operations
  --self-signed         Accept a self-signed TLS certificate
  --docs-dir <path>     Search a local Bunwrite docs folder
  --help                Show this help
  --version             Print the version

Environment:
  BUNWRITE_ENDPOINT, BUNWRITE_PROJECT_ID, BUNWRITE_API_KEY
  APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, APPWRITE_API_KEY (aliases)
  BUNWRITE_MCP_TRANSPORT, BUNWRITE_MCP_HOST, BUNWRITE_MCP_PORT
  BUNWRITE_MCP_READ_ONLY, BUNWRITE_MCP_MAX_RESULT, BUNWRITE_SELF_SIGNED
  BUNWRITE_DOCS_DIR

The API key is sent only to the configured endpoint. Never put it in a browser
or a public repository.`

export function readConfig(argv: string[] = process.argv.slice(2), env: Env = process.env): McpConfig {
  const { values, flags } = parse(argv)
  const endpoint = normalizeEndpoint(
    values.endpoint || text(env.BUNWRITE_ENDPOINT) || text(env.APPWRITE_ENDPOINT) || 'http://localhost:8080/v1',
  )
  const project = values.project || text(env.BUNWRITE_PROJECT_ID) || text(env.APPWRITE_PROJECT_ID)
  const key = values.key || text(env.BUNWRITE_API_KEY) || text(env.APPWRITE_API_KEY)
  if (!project) throw new ConfigError('No project ID. Set BUNWRITE_PROJECT_ID or pass --project.')
  if (!key) throw new ConfigError('No API key. Set BUNWRITE_API_KEY or pass --key. Use a server-side key, never a browser key.')
  const transport = (values.transport ?? (text(env.BUNWRITE_MCP_TRANSPORT) || 'stdio')).toLowerCase()
  if (transport !== 'stdio' && transport !== 'http') throw new ConfigError('Transport must be stdio or http.')

  return {
    endpoint,
    project,
    key,
    transport,
    host: values.host ?? (text(env.BUNWRITE_MCP_HOST) || '127.0.0.1'),
    port: positive(values.port ?? env.BUNWRITE_MCP_PORT, 7801, 1, 65_535),
    readOnly: flags.has('read-only') || bool(env.BUNWRITE_MCP_READ_ONLY, false),
    maxResultChars: positive(env.BUNWRITE_MCP_MAX_RESULT, 200_000, 10_000, 2_000_000),
    selfSigned: flags.has('self-signed') || bool(env.BUNWRITE_SELF_SIGNED, false),
    docsDir: values['docs-dir'] ?? (text(env.BUNWRITE_DOCS_DIR) || undefined),
  }
}

export function createClient(config: McpConfig): Client {
  const client = new Client().setEndpoint(config.endpoint).setProject(config.project).setKey(config.key)
  if (config.selfSigned) client.setSelfSigned(true)
  return client
}

/** Never print the key. */
export function describeTarget(config: McpConfig): string {
  return `${config.endpoint} (project ${config.project})`
}
