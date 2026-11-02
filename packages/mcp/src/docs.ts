/**
 * Documentation search for `bunwrite_search_docs` and the MCP resources.
 *
 * When the server runs from a Bunwrite checkout (or `BUNWRITE_DOCS_DIR` points
 * at a docs folder), it searches the real Markdown files. Otherwise it falls
 * back to a small built-in index, so an installed package still answers common
 * questions with links instead of failing.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

export interface DocResource {
  uri: string
  name: string
  description: string
  mimeType: string
}

export interface DocHit {
  title: string
  url: string
  snippet: string
}

interface DocPage {
  slug: string
  title: string
  url: string
  summary: string
  keywords: string
  content?: string
}

const REPO = 'https://github.com/ridhotamma/bunwrite/blob/main'
const RAW = 'https://raw.githubusercontent.com/ridhotamma/bunwrite/main'

const STATIC: DocPage[] = [
  {
    slug: 'configuration',
    title: 'Configuration reference',
    url: `${REPO}/docs/CONFIGURATION.md`,
    summary: 'Every environment variable: server, domains, databases, workers, MAX_INFLIGHT, logs, observability and functions.',
    keywords: 'env environment variable configuration workers max_inflight port database url sqlite postgres driver pool logs observability',
  },
  {
    slug: 'database',
    title: 'Database backends',
    url: `${REPO}/docs/DATABASE.md`,
    summary: 'SQLite and Postgres: DB_DRIVER, DATABASE_URL, per-project schemas, pooling, writer sharding and backups.',
    keywords: 'database sqlite postgres db_driver database_url schema pool wal writer sharding backup pg_dump',
  },
  {
    slug: 'deploy',
    title: 'Deployment',
    url: `${REPO}/docs/DEPLOY.md`,
    summary: 'Docker Compose, Caddy, TLS, workers, backups, Litestream, Postgres and production tuning.',
    keywords: 'deploy docker compose caddy tls domain workers worker_ports upstream backup litestream postgres production',
  },
  {
    slug: 'observability',
    title: 'Observability',
    url: `${REPO}/docs/OBSERVABILITY.md`,
    summary: 'Request logs, traces, metrics, product analytics, feature flags, OTLP, Datadog and PostHog, plus the console pages.',
    keywords: 'observability datadog posthog otlp opentelemetry traces metrics logs feature flags analytics console',
  },
  {
    slug: 'mcp',
    title: 'MCP server',
    url: `${REPO}/docs/MCP.md`,
    summary: 'Connect Claude Code, Cursor, Codex, OpenCode and other MCP clients to a Bunwrite project.',
    keywords: 'mcp model context protocol ai agent claude cursor codex opencode tools',
  },
  {
    slug: 'queue',
    title: 'Queue',
    url: `${REPO}/docs/QUEUE.md`,
    summary: 'Durable jobs, workers, retries, visibility and the queue API.',
    keywords: 'queue job worker retry lease visibility durable',
  },
  {
    slug: 'sites',
    title: 'Sites',
    url: `${REPO}/docs/SITES.md`,
    summary: 'Static sites, output folders, single-page fallback, custom domains and API functions.',
    keywords: 'sites static hosting deploy output folder spa fallback domain api function',
  },
  {
    slug: 'render',
    title: 'HTML rendering',
    url: `${REPO}/docs/RENDER.md`,
    summary: 'PDF and image rendering with Chromium, limits and the render API.',
    keywords: 'render pdf image chromium screenshot html',
  },
  {
    slug: 'limitations',
    title: 'Limitations',
    url: `${REPO}/docs/LIMITATIONS.md`,
    summary: 'What Bunwrite does not do: HA, function isolation, observability gaps, scaling notes.',
    keywords: 'limitations not supported gaps high availability isolation scaling',
  },
  {
    slug: 'architecture',
    title: 'Architecture',
    url: `${REPO}/docs/ARCHITECTURE.md`,
    summary: 'Process model, request path, storage, realtime, functions and sites.',
    keywords: 'architecture process workers request path storage realtime functions sites',
  },
]

let cachedDir: string | null | undefined
let cachedDocs: DocPage[] | null = null

function candidateDirs(configured?: string): string[] {
  const dirs: string[] = []
  if (configured) dirs.push(resolve(configured))
  dirs.push(resolve(process.cwd(), 'docs'))
  dirs.push(resolve(HERE, '..', '..', '..', 'docs'))
  dirs.push(resolve(HERE, '..', '..', '..', '..', 'docs'))
  return dirs
}

function docsDir(configured?: string): string | null {
  if (cachedDir !== undefined && !configured) return cachedDir
  for (const candidate of candidateDirs(configured)) {
    try {
      if (statSync(candidate).isDirectory()) {
        cachedDir = candidate
        return candidate
      }
    } catch {
      // Try the next location.
    }
  }
  if (!configured) cachedDir = null
  return null
}

function titleOf(markdown: string, fallback: string): string {
  return /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim() || fallback
}

function loadDocs(configured?: string): DocPage[] {
  if (cachedDocs) return cachedDocs
  const dir = docsDir(configured)
  if (!dir) {
    cachedDocs = STATIC
    return cachedDocs
  }
  const pages: DocPage[] = []
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.md')) continue
    const path = join(dir, file)
    let content: string
    try {
      if (!statSync(path).isFile()) continue
      content = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    const slug = basename(file, '.md').toLowerCase()
    pages.push({
      slug,
      title: titleOf(content, slug),
      url: `${REPO}/docs/${file}`,
      summary: content.split('\n').find((line) => line.trim() && !line.startsWith('#'))?.trim().slice(0, 240) ?? '',
      content,
      keywords: `${slug} ${titleOf(content, slug)} ${file}`.toLowerCase(),
    })
  }
  cachedDocs = pages.length ? pages : STATIC
  return cachedDocs
}

function score(page: DocPage, terms: string[]): number {
  const haystack = `${page.title} ${page.summary} ${page.keywords} ${page.content?.slice(0, 4000) ?? ''}`.toLowerCase()
  let total = 0
  for (const term of terms) {
    if (!term) continue
    if (page.title.toLowerCase().includes(term)) total += 6
    else if (page.slug.includes(term)) total += 4
    else if (haystack.includes(term)) total += 1
  }
  return total
}

function snippet(page: DocPage, terms: string[]): string {
  if (!page.content) return page.summary
  const lower = page.content.toLowerCase()
  let at = -1
  for (const term of terms) {
    const found = lower.indexOf(term)
    if (found !== -1 && (at === -1 || found < at)) at = found
  }
  if (at === -1) return page.summary
  const start = Math.max(0, at - 120)
  const end = Math.min(page.content.length, at + 300)
  return `${start > 0 ? '…' : ''}${page.content.slice(start, end).replace(/\s+/g, ' ').trim()}…`
}

export function searchDocs(query: string, limit = 5, configuredDir?: string): DocHit[] {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((term) => term.length > 1)
  const docs = loadDocs(configuredDir)
  if (terms.length === 0) return docs.slice(0, limit).map((page) => ({ title: page.title, url: page.url, snippet: page.summary }))
  return docs
    .map((page) => ({ page, score: score(page, terms) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.page.title.localeCompare(b.page.title))
    .slice(0, limit)
    .map((entry) => ({ title: entry.page.title, url: entry.page.url, snippet: snippet(entry.page, terms) }))
}

export function docResources(configuredDir?: string): DocResource[] {
  return loadDocs(configuredDir).map((page) => ({
    uri: `bunwrite://docs/${page.slug}`,
    name: page.title,
    description: page.summary,
    mimeType: 'text/markdown',
  }))
}

export function readDoc(slug: string, configuredDir?: string): { uri: string; text: string; mimeType: string } | null {
  const page = loadDocs(configuredDir).find((entry) => entry.slug === slug)
  if (!page) return null
  return {
    uri: `bunwrite://docs/${page.slug}`,
    text: page.content ?? `# ${page.title}\n\n${page.summary}\n\n${page.url}`,
    mimeType: 'text/markdown',
  }
}

/** The canonical GitHub URL for a page, useful in tool output. */
export function docUrl(slug: string): string | null {
  const page = loadDocs().find((entry) => entry.slug === slug)
  return page ? page.url : null
}

/** The raw documentation URL, used by tests and agents that want the latest text. */
export function rawDocUrl(slug: string): string | null {
  const page = loadDocs().find((entry) => entry.slug === slug)
  if (!page) return null
  return page.url.replace(REPO, RAW)
}
