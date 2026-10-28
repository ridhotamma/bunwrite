/**
 * The runtimes sites and functions can build and run on. Node.js and Bun are
 * downloaded on first use (see install.ts); the Bun line this server runs on
 * uses the server's own binary. Python uses the host's python3.
 *
 * Any `node-<major>` or `bun-<major>.<minor>` is accepted, as on Appwrite;
 * this list is what the console offers.
 */
export type RuntimeKind = 'node' | 'bun' | 'python'

export interface RuntimeOption {
  id: string
  kind: RuntimeKind
  label: string
  /** Shown after the label, such as "this server, no download". */
  note: string
}

/** The Bun line this server itself runs on, such as `1.4`. */
export const SERVER_BUN_LINE = (process.versions.bun ?? '1.0.0').split('.').slice(0, 2).join('.')
export const SERVER_BUN = `bun-${SERVER_BUN_LINE}`

/** New sites and functions start on this. */
export const DEFAULT_RUNTIME = 'node-22'

const NODE_LINES: [string, string][] = [
  ['26', ''],
  ['24', ''],
  ['22', ''],
  ['20', 'end of life'],
]
const BUN_LINES = [...new Set(['1.4', '1.3', '1.2', '1.1', SERVER_BUN_LINE])].sort((a, b) => Number(b.split('.')[1]) - Number(a.split('.')[1]) || b.localeCompare(a))
const PYTHON_LINES = ['3.13', '3.12', '3.11', '3.10', '3.9']

export const NODE_RUNTIMES: RuntimeOption[] = NODE_LINES.map(([line, note]) => ({ id: `node-${line}`, kind: 'node', label: `Node.js ${line}`, note }))
export const BUN_RUNTIMES: RuntimeOption[] = BUN_LINES.map((line) => ({ id: `bun-${line}`, kind: 'bun', label: `Bun ${line}`, note: line === SERVER_BUN_LINE ? 'this server, no download' : '' }))
export const PYTHON_RUNTIMES: RuntimeOption[] = PYTHON_LINES.map((line) => ({ id: `python-${line}`, kind: 'python', label: `Python ${line}`, note: "the server's python3" }))

/** Runtimes a site can build and run on. */
export const SITE_RUNTIMES = [...NODE_RUNTIMES, ...BUN_RUNTIMES]
/** Runtimes a function can run on. */
export const FUNCTION_RUNTIMES = [...NODE_RUNTIMES, ...BUN_RUNTIMES, ...PYTHON_RUNTIMES]

/** What a runtime ID asks for, or null when it is not one. `line` is the major (Node) or major.minor (Bun, Python). */
export function parseRuntime(id: string): { kind: RuntimeKind; line: string } | null {
  const node = /^node-(\d+)(?:\.\d+)*$/.exec(id)
  if (node) return { kind: 'node', line: node[1]! }
  const bun = /^bun-(\d+\.\d+)(?:\.\d+)*$/.exec(id)
  if (bun) return { kind: 'bun', line: bun[1]! }
  const python = /^python-(\d+(?:\.\d+)*)(?:-ml)?$/.exec(id)
  if (python) return { kind: 'python', line: python[1]! }
  return null
}

export const isRuntime = (id: string) => parseRuntime(id) !== null

/** A readable name, such as "Node.js 22" or "Bun 1.4 (this server)". */
export function runtimeLabel(id: string): string {
  if (!id) return "This server's Bun"
  const known = FUNCTION_RUNTIMES.find((r) => r.id === id)
  if (known) return known.note ? `${known.label} (${known.note})` : known.label
  const parsed = parseRuntime(id)
  if (!parsed) return id
  return `${parsed.kind === 'node' ? 'Node.js' : parsed.kind === 'bun' ? 'Bun' : 'Python'} ${parsed.line}`
}
