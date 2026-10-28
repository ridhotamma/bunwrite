/**
 * Copy the Appwrite SDK code that Bunwrite can serve into packages/sdk.
 *
 *   bun scripts/sdk-sync.ts
 *
 * The `appwrite` (web) and `node-appwrite` devDependencies ship their original
 * TypeScript inside their source maps. This script reads it from there, keeps
 * each service method whose HTTP method and path Bunwrite routes, and writes
 * the result to packages/sdk/src. Run it again after upgrading those packages
 * or adding routes to the server.
 *
 * Hand-written files (client.ts, index.ts, inputFile.ts, services/health.ts,
 * services/render.ts) are not touched.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, normalize, resolve } from 'node:path'
import ts from 'typescript'

const ROOT = resolve(import.meta.dir, '..')
const OUT = join(ROOT, 'packages/sdk/src')
const NODE_MODULES = join(ROOT, 'node_modules')

// ---- Appwrite sources, read from the source maps ----

type Sources = Map<string, string>

function sourcesOf(maps: string[]): Sources {
  const out: Sources = new Map()
  for (const map of maps) {
    const json = JSON.parse(readFileSync(map, 'utf8')) as { sources: string[]; sourcesContent?: (string | null)[] }
    json.sources.forEach((source, i) => {
      const content = json.sourcesContent?.[i]
      if (!content || source.includes('node_modules')) return
      const path = normalize(join(dirname(map), source))
      const at = path.lastIndexOf('/src/')
      if (at >= 0) out.set(path.slice(at + 5), content)
    })
  }
  return out
}

const pkgVersion = (name: string) => JSON.parse(readFileSync(join(NODE_MODULES, name, 'package.json'), 'utf8')).version as string
const mapsIn = (dir: string) =>
  [...new Bun.Glob('**/*.mjs.map').scanSync(dir)].map((file) => join(dir, file))

const web = sourcesOf([join(NODE_MODULES, 'appwrite/dist/esm/sdk.js.map')])
const node = sourcesOf(mapsIn(join(NODE_MODULES, 'node-appwrite/dist')))
const WEB_VERSION = pkgVersion('appwrite')
const NODE_VERSION = pkgVersion('node-appwrite')

const read = (sources: Sources, file: string): string => {
  const text = sources.get(file)
  if (text === undefined) throw new Error(`Missing ${file} in the Appwrite sources`)
  return text
}

// ---- The routes Bunwrite serves ----

async function servedRoutes(): Promise<{ method: string; segments: string[] }[]> {
  const { Router } = await import('../src/lib/router')
  const seen: string[] = []
  const on = Router.prototype.on
  Router.prototype.on = function (method: string, path: string, ...rest: any[]) {
    seen.push(`${method} ${path}`)
    return (on as any).call(this, method, path, ...rest)
  }
  const { startServer } = await import('../test/helpers')
  startServer().stop()
  Router.prototype.on = on
  return [...new Set(seen)]
    .map((route) => route.split(' ') as [string, string])
    .filter(([method, path]) => method !== 'ANY' && (!path.startsWith('/console/') || path === '/console/variables'))
    .map(([method, path]) => ({ method: method.toLowerCase(), segments: path.split('/').filter(Boolean) }))
}

const routes = await servedRoutes()

// Route params that stand for a fixed set of names in Appwrite's paths.
const LITERALS: Record<string, string[]> = {
  type: ['string', 'varchar', 'text', 'mediumtext', 'longtext', 'email', 'url', 'ip', 'enum', 'integer', 'bigint', 'float', 'boolean', 'datetime'],
  policyId: [
    'password-dictionary',
    'password-history',
    'password-personal-data',
    'session-alert',
    'session-duration',
    'session-invalidation',
    'session-limit',
    'user-limit',
    'membership-privacy',
    'deny-aliased-email',
    'deny-disposable-email',
    'deny-free-email',
  ],
}

/** Does Bunwrite route this Appwrite method + path (`{param}` segments)? */
function served(method: string, path: string): boolean {
  const segments = path.split('/').filter(Boolean)
  return routes.some(
    (route) =>
      route.method === method &&
      route.segments.length === segments.length &&
      route.segments.every((s, i) => {
        const theirs = segments[i]!
        const param = theirs.startsWith('{')
        if (s.startsWith(':')) return param || (LITERALS[s.slice(1)] ?? []).includes(theirs)
        return s === theirs
      }),
  )
}

// ---- Service files ----

interface Method {
  name: string
  method: string
  path: string
  /** Full text, with the doc comments in front of each overload. */
  text: string
  start: number
  end: number
}

interface ServiceFile {
  text: string
  methods: Method[]
  /** Where the class body ends (its closing brace). */
  classEnd: number
}

function parseService(text: string): ServiceFile {
  const sf = ts.createSourceFile('service.ts', text, ts.ScriptTarget.Latest, true)
  const cls = sf.statements.find((s): s is ts.ClassDeclaration => ts.isClassDeclaration(s))
  if (!cls) throw new Error('No class in service file')
  const methods: Method[] = []
  for (const member of cls.members) {
    if (!ts.isMethodDeclaration(member)) continue
    const name = member.name.getText(sf)
    let current = methods.at(-1)
    if (!current || current.name !== name) {
      current = { name, method: '', path: '', text: '', start: member.getFullStart(), end: 0 }
      methods.push(current)
    }
    current.end = member.getEnd()
    if (member.body) {
      const body = member.body.getText(sf)
      current.path = /const apiPath =\s*'([^']+)'/.exec(body)?.[1] ?? ''
      current.method = (/this\.client\.(?:call|chunkedUpload|redirect)\(\s*'(\w+)'/.exec(body)?.[1] ?? 'get').toLowerCase()
    }
  }
  for (const m of methods) m.text = text.slice(m.start, m.end)
  return { text, methods, classEnd: cls.getEnd() - 1 }
}

interface ServiceSpec {
  file: string
  /** Methods taken from the web SDK instead of the Node one. */
  fromWeb?: string[]
  /** Node methods kept under another name, next to the web method of the original name. */
  rename?: Record<string, string>
}

const SERVICES: ServiceSpec[] = [
  // createOAuth2Token: the web version sends the browser to the provider, or returns the URL.
  { file: 'account', fromWeb: ['createOAuth2Token', 'createJWT'] },
  { file: 'databases' },
  { file: 'tables-db' },
  // The web versions return URLs for <img src>; the Node versions download the bytes.
  {
    file: 'storage',
    fromWeb: ['getFileDownload', 'getFilePreview', 'getFileView'],
    rename: { getFileDownload: 'getFileDownloadBytes', getFilePreview: 'getFilePreviewBytes', getFileView: 'getFileViewBytes' },
  },
  { file: 'functions' },
  { file: 'teams' },
  { file: 'users' },
  { file: 'messaging' },
  { file: 'webhooks' },
  { file: 'project' },
  { file: 'organization' },
]

const header = (from: string) =>
  `// Copied from ${from} (BSD-3-Clause, see LICENSE) by scripts/sdk-sync.ts,\n// keeping only what Bunwrite serves. Edit that script, not this file.\n\n`

const renameMethod = (text: string, from: string, to: string) =>
  text.replace(new RegExp(`^(\\s+)${from}(?=[<(])`, 'gm'), `$1${to}`)

/** Shared rewrites for every copied file. */
function rebrand(text: string): string {
  return text
    .replace(/\bAppwriteException\b/g, 'BunwriteException')
    .replace(/\bService\.flatten\b/g, 'Client.flatten')
    .replace(/^import \{ Service \} from '\.\.\/service';\n/m, '')
    .replace(/^import \{ File \} from 'undici';\n/m, '')
    .replace(/^import JSONbigModule from 'json-bigint';\nconst JSONbig = JSONbigModule\(\{ useNativeBigInt: true \}\);\n/m, "import { JSONbig } from './json';\n")
    // Types imported as values, for `verbatimModuleSyntax`.
    .replace(/^import \{([^}]*)\} from '([^']+)';/gm, (_line, names: string, from: string) => {
      const fixed = names.replace(/(^|[\s,])(UploadProgress|ActionableChannel|ResolvedChannel)\b/g, '$1type $2')
      return `import {${fixed}} from '${from}';`
    })
    // Bunwrite has no impersonation.
    .replace(/^\s*payload\['impersonateuserid'\] = this\.client\.config\.impersonateuserid;\n/gm, '')
}

/** Files that test for a browser use `window`; declare it so they compile without DOM types. */
function declareWindow(text: string): string {
  if (!/\bwindow\b/.test(text.slice(text.search(/^export /m)))) return text
  const at = text.search(/^export /m)
  return text.slice(0, at) + '// Only set in browsers.\ndeclare const window: any;\n\n' + text.slice(at)
}

/** Drop named imports the file no longer uses. */
function pruneImports(text: string): string {
  const firstCode = text.search(/^export /m)
  const body = text.slice(firstCode)
  const head = text.slice(0, firstCode)
  const pruned = head.replace(/^import (type )?\{([^}]*)\} from '([^']+)';\n/gm, (_line, type: string | undefined, names: string, from: string) => {
    const kept = names
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean)
      .filter((n) => new RegExp(`\\b${n.replace(/^type\s+/, '')}\\b`).test(body))
    return kept.length ? `import ${type ?? ''}{ ${kept.join(', ')} } from '${from}';\n` : ''
  })
  return pruned + body
}

const enumsUsed = new Set<string>()
const noteEnums = (text: string) => {
  for (const m of text.matchAll(/from '\.\.?\/enums\/([\w-]+)'/g)) enumsUsed.add(m[1]!)
}

function buildService(spec: ServiceSpec): { text: string; kept: string[]; dropped: number } {
  const base = parseService(read(node, `services/${spec.file}.ts`))
  const webFile = web.has(`services/${spec.file}.ts`) ? parseService(read(web, `services/${spec.file}.ts`)) : undefined
  const webMethod = (name: string) => {
    const found = webFile?.methods.find((m) => m.name === name)
    if (!found) throw new Error(`${spec.file}.${name} is not in the web SDK`)
    return found
  }

  const kept: string[] = []
  let text = base.text
  const edits: { start: number; end: number; text: string }[] = []
  for (const m of base.methods) {
    if (!served(m.method, m.path)) {
      edits.push({ start: m.start, end: m.end, text: '' })
      continue
    }
    const fromWeb = spec.fromWeb?.includes(m.name)
    const renamed = spec.rename?.[m.name]
    let replacement = m.text
    if (renamed) {
      replacement = webMethod(m.name).text + renameMethod(m.text, m.name, renamed)
      kept.push(m.name, renamed)
    } else if (fromWeb) {
      replacement = webMethod(m.name).text
      kept.push(m.name)
    } else {
      kept.push(m.name)
    }
    edits.push({ start: m.start, end: m.end, text: replacement })
  }
  // Web-only methods go at the end of the class.
  for (const name of spec.fromWeb ?? []) {
    if (base.methods.some((m) => m.name === name)) continue
    const m = webMethod(name)
    if (!served(m.method, m.path)) throw new Error(`${spec.file}.${name} is not served by Bunwrite`)
    edits.push({ start: base.classEnd, end: base.classEnd, text: m.text + '\n' })
    kept.push(name)
  }
  for (const e of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, e.start) + e.text + text.slice(e.end)
  // Whole web methods use `payload`, Node ones `apiPayload`; both work. Make sure the
  // web methods' helpers are imported.
  if (/Client\.flatten|Service\.flatten/.test(text) && !/import \{[^}]*\bClient\b/.test(text)) {
    throw new Error(`${spec.file}: Client is not imported`)
  }
  text = declareWindow(pruneImports(rebrand(text)))
  noteEnums(text)
  const dropped = base.methods.length - base.methods.filter((m) => served(m.method, m.path)).length
  return { text: header(`node-appwrite ${NODE_VERSION}${spec.fromWeb ? ` and appwrite ${WEB_VERSION}` : ''}`) + text, kept, dropped }
}

// ---- Write ----

const write = (file: string, text: string) => {
  const path = join(OUT, file)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text.endsWith('\n') ? text : text + '\n')
}

rmSync(join(OUT, 'enums'), { recursive: true, force: true })

const summary: string[] = []
for (const spec of SERVICES) {
  const { text, kept, dropped } = buildService(spec)
  write(`services/${spec.file}.ts`, text)
  summary.push(`${spec.file.padEnd(14)} ${String(kept.length).padStart(3)} methods (${dropped} not served by Bunwrite)`)
}

// Realtime (web only). It runs outside browsers too, where there is no `window`.
{
  let text = rebrand(read(web, 'services/realtime.ts'))
    .replace(/window\?\.setInterval/g, 'globalThis.setInterval')
    .replace(/window\?\.clearInterval/g, 'globalThis.clearInterval')
    .replace(/private heartbeatTimer\?: number;/, 'private heartbeatTimer?: ReturnType<typeof setInterval>;')
    .replace(
      /window\.localStorage\.getItem\('cookieFallback'\)/g,
      "(typeof window !== 'undefined' && window.localStorage ? window.localStorage.getItem('cookieFallback') : null)",
    )
  write('services/realtime.ts', header(`appwrite ${WEB_VERSION}`) + declareWindow(text))
  summary.push('realtime       WebSocket service')
}

// Helpers, the same in both SDKs.
for (const file of ['id.ts', 'query.ts', 'permission.ts', 'role.ts', 'operator.ts', 'channel.ts']) {
  const text = rebrand(read(web, file))
  noteEnums(text)
  write(file, header(`appwrite ${WEB_VERSION}`) + text)
}

// Models: the Node SDK's declarations, as a types-only module.
{
  let text = readFileSync(join(NODE_MODULES, 'node-appwrite/dist/models.d.ts'), 'utf8')
    .replace(/^import \{ (\w+) \} from '\.\/enums\/([\w-]+)\.js';$/gm, "import type { $1 } from './enums/$2';")
    .replace('declare namespace Models', 'export declare namespace Models')
    .replace(/\nexport \{ Models \};\s*$/, '\n')
  noteEnums(text)
  write('models.ts', header(`node-appwrite ${NODE_VERSION}`) + text)
}

// The enums anything above refers to, and one module that exports them all.
const barrel: string[] = []
for (const name of [...enumsUsed].sort()) {
  const file = `enums/${name}.ts`
  const text = node.get(file) ?? web.get(file)
  if (!text) throw new Error(`Missing ${file}`)
  write(file, text)
  const exported = /export enum (\w+)/.exec(text)?.[1]
  if (exported) barrel.push(`export { ${exported} } from './enums/${name}';`)
}
write('enums.ts', `// Written by scripts/sdk-sync.ts.\n${barrel.join('\n')}\n`)

if (!existsSync(join(OUT, 'client.ts'))) console.warn('packages/sdk/src/client.ts is missing; it is hand-written.')
console.log(summary.join('\n'))
console.log(`enums          ${enumsUsed.size} files`)
