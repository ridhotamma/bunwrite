/** Command-line arguments: positional words, then `--flag value`, `--flag=value` or `--flag`. */
export interface Args {
  positional: string[]
  flags: Map<string, string[]>
}

/** Flags that take no value. `--no-x` sets `x` to false. */
const BOOLEAN = new Set(['all', 'force', 'code', 'prune', 'json', 'help', 'version', 'self-signed', 'reset', 'yes', 'create', 'clear'])

export function parseArgs(argv: string[]): Args {
  const positional: string[] = []
  const flags = new Map<string, string[]>()
  const add = (name: string, value: string) => flags.set(name, [...(flags.get(name) ?? []), value])

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (token === '--') {
      positional.push(...argv.slice(i + 1))
      break
    }
    if (token === '-h') {
      add('help', 'true')
      continue
    }
    if (token === '-v') {
      add('version', 'true')
      continue
    }
    if (!token.startsWith('--')) {
      positional.push(token)
      continue
    }
    const body = token.slice(2)
    const eq = body.indexOf('=')
    if (eq >= 0) {
      add(body.slice(0, eq), body.slice(eq + 1))
      continue
    }
    if (body.startsWith('no-') && !argv[i + 1]?.match(/^(true|false)$/)) {
      add(body.slice(3), 'false')
      continue
    }
    const next = argv[i + 1]
    if (BOOLEAN.has(body) && next !== 'true' && next !== 'false') {
      add(body, 'true')
      continue
    }
    if (next === undefined || next.startsWith('--')) {
      add(body, 'true')
      continue
    }
    add(body, next)
    i++
  }
  return { positional, flags }
}

export const flag = (args: Args, name: string): string | undefined => args.flags.get(name)?.at(-1)

/** Every value of a repeated flag; commas split values too. */
export const flagList = (args: Args, name: string): string[] =>
  (args.flags.get(name) ?? []).flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean)

export function bool(args: Args, name: string, fallback = false): boolean {
  const value = flag(args, name)
  if (value === undefined) return fallback
  return value !== 'false' && value !== '0' && value !== 'no'
}

export const kebabToCamel = (s: string) => s.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())
export const camelToKebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
