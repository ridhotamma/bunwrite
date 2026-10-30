/**
 * Size the process to the machine (or container) it runs on.
 *
 * os.cpus() and os.totalmem() report the host, so read the cgroup limit first:
 * that is what a Docker container, a systemd MemoryMax or a Kubernetes pod
 * actually gets. Explicit environment variables always win, and AUTOTUNE=false
 * turns the whole thing off.
 */
import { readFileSync } from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'

export const MB = 1024 * 1024

export type ResourceSource = 'cgroup' | 'host' | 'override'

export interface DetectedResources {
  cpus: number
  memoryMb: number
  cpuSource: ResourceSource
  memorySource: ResourceSource
}

export interface Tuning extends DetectedResources {
  sharpConcurrency: number
  sharpCacheMb: number
  previewConcurrency: number
  renderMaxMegapixels: number
  avifMaxMegapixels: number
  sqliteCacheMb: number
  maxRequestBodyMb: number
  maxRequestBodyBytes: number
  jscHeapMb: number
  mallocArenaMax: number
  summary: string
}

type Env = Record<string, string | undefined>
type ReadFile = (path: string) => string | null

export interface DetectOptions {
  readFile?: ReadFile
  cpuCount?: () => number
  totalMemory?: () => number
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))

function readText(path: string): string | null {
  try {
    const text = readFileSync(path, 'utf8').trim()
    return text === '' ? null : text
  } catch {
    return null
  }
}

function readFirst(paths: string[], read: ReadFile): string | null {
  for (const path of paths) {
    const value = read(path)
    if (value !== null && value !== '') return value
  }
  return null
}

/**
 * Paths for a cgroup file. The process's own cgroup comes first: on a systemd
 * host the root cgroup is usually unlimited while the service's cgroup is not.
 * Inside a container with a cgroup namespace both resolve to the same files.
 */
function cgroupCandidates(file: string, controller: string | null, read: ReadFile): string[] {
  const paths: string[] = []
  const self = read('/proc/self/cgroup')
  if (self) {
    for (const line of self.split('\n')) {
      if (controller === null) {
        const match = /^0::(.+)$/.exec(line.trim())
        if (match?.[1]) paths.push(join('/sys/fs/cgroup', match[1], file))
        continue
      }
      const match = /^\d+:([^:]*):(.+)$/.exec(line.trim())
      if (match?.[1] && match[2] && match[1].split(',').includes(controller)) {
        paths.push(join('/sys/fs/cgroup', controller, match[2], file))
      }
    }
  }
  paths.push(controller === null ? join('/sys/fs/cgroup', file) : join('/sys/fs/cgroup', controller, file))
  return [...new Set(paths)]
}

/** `quota period` from cgroup v2 `cpu.max`; null means unlimited or unreadable. */
export function parseCpuLimit(text: string | null): number | null {
  if (!text) return null
  const [quota, period] = text.trim().split(/\s+/)
  if (!quota || quota === 'max') return null
  const q = Number(quota)
  const p = Number(period)
  if (!Number.isFinite(q) || !Number.isFinite(p) || q <= 0 || p <= 0) return null
  return q / p
}

/** Bytes from `memory.max` or v1 `memory.limit_in_bytes`; null means unlimited. */
export function parseMemoryLimit(text: string | null): number | null {
  if (!text || text.trim() === 'max') return null
  const value = Number(text.trim())
  // cgroup v1 reports this sentinel when there is no limit.
  if (!Number.isFinite(value) || value <= 0 || value > 1e15) return null
  return value
}

function hostCpuCount(): number {
  const available = (os as typeof os & { availableParallelism?: () => number }).availableParallelism
  try {
    const count = typeof available === 'function' ? available() : os.cpus().length
    return Number.isFinite(count) && count > 0 ? count : 1
  } catch {
    return 1
  }
}

function hostMemoryBytes(): number {
  try {
    const bytes = os.totalmem()
    return Number.isFinite(bytes) && bytes > 0 ? bytes : 512 * MB
  } catch {
    return 512 * MB
  }
}

function positive(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : null
}

function nonNegative(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : null
}

export function detectResources(env: Env = process.env, options: DetectOptions = {}): DetectedResources {
  const read = options.readFile ?? readText
  const cpuCount = options.cpuCount ? options.cpuCount() : hostCpuCount()
  const memoryCount = options.totalMemory ? options.totalMemory() : hostMemoryBytes()
  const hostCpus = Number.isFinite(cpuCount) && cpuCount > 0 ? cpuCount : 1
  const hostMemory = Number.isFinite(memoryCount) && memoryCount > 0 ? memoryCount : 512 * MB

  const cpuOverride = positive(env.AUTOTUNE_CPUS)
  const memoryOverride = positive(env.AUTOTUNE_MEMORY_MB)

  let cgroupCpus: number | null = null
  const cpuMax = readFirst(cgroupCandidates('cpu.max', null, read), read)
  if (cpuMax !== null) {
    cgroupCpus = parseCpuLimit(cpuMax)
  } else {
    const quota = Number(readFirst(cgroupCandidates('cpu.cfs_quota_us', 'cpu', read), read) ?? '')
    const period = Number(readFirst(cgroupCandidates('cpu.cfs_period_us', 'cpu', read), read) ?? '')
    if (Number.isFinite(quota) && quota > 0 && Number.isFinite(period) && period > 0) cgroupCpus = quota / period
  }

  let cgroupMemory: number | null = null
  const memoryMax = readFirst(cgroupCandidates('memory.max', null, read), read)
  if (memoryMax !== null) {
    cgroupMemory = parseMemoryLimit(memoryMax)
    // A soft limit (systemd MemoryHigh) is still a useful ceiling.
    if (cgroupMemory === null) cgroupMemory = parseMemoryLimit(readFirst(cgroupCandidates('memory.high', null, read), read))
  } else {
    cgroupMemory = parseMemoryLimit(readFirst(cgroupCandidates('memory.limit_in_bytes', 'memory', read), read))
  }

  const cpus = cpuOverride ?? (cgroupCpus !== null ? Math.min(cgroupCpus, hostCpus) : hostCpus)
  const memoryBytes = memoryOverride !== null ? memoryOverride * MB : cgroupMemory !== null ? Math.min(cgroupMemory, hostMemory) : hostMemory
  return {
    cpus: Math.max(0.1, cpus),
    memoryMb: Math.max(64, Math.floor(memoryBytes / MB)),
    cpuSource: cpuOverride !== null ? 'override' : cgroupCpus !== null ? 'cgroup' : 'host',
    memorySource: memoryOverride !== null ? 'override' : cgroupMemory !== null ? 'cgroup' : 'host',
  }
}

const disabled = (env: Env): boolean => ['false', '0', 'no', 'off'].includes((env.AUTOTUNE ?? '').trim().toLowerCase())

const setIfBlank = (env: Env, key: string, value: number): void => {
  const current = env[key]
  if (current === undefined || current.trim() === '') env[key] = String(value)
}

const formatCpu = (cpus: number): string => (Number.isInteger(cpus) ? String(cpus) : cpus.toFixed(1))

const formatMemory = (memoryMb: number): string =>
  memoryMb >= 1024 ? `${(memoryMb / 1024).toFixed(memoryMb % 1024 === 0 ? 0 : 1)} GB` : `${memoryMb} MB`

/** Work out every limit from the detected resources and any explicit env values. */
export function tuningFor(detected: DetectedResources, env: Env = process.env): Tuning {
  const cpus = Math.max(0.1, detected.cpus)
  const memoryMb = Math.max(64, detected.memoryMb)

  const sharpConcurrency = positive(env.SHARP_CONCURRENCY) ?? clamp(Math.round(cpus), 1, 4)
  const sharpCacheMb = nonNegative(env.SHARP_CACHE_MB) ?? clamp(Math.round(memoryMb / 32), 16, 128)
  const previewConcurrency = positive(env.PREVIEW_CONCURRENCY) ?? clamp(Math.min(Math.round(cpus * 2), Math.floor(memoryMb / 192)), 1, 8)
  const renderMaxMegapixels = positive(env.RENDER_MAX_MEGAPIXELS) ?? clamp(Math.floor(memoryMb / 64), 4, 30)
  const avifMaxMegapixels = positive(env.AVIF_MAX_MEGAPIXELS) ?? clamp(Math.floor(memoryMb / 128), 2, 16)
  const sqliteCacheMb = positive(env.SQLITE_CACHE_MB) ?? clamp(Math.floor(memoryMb / 32), 8, 64)
  const maxRequestBodyMb = positive(env.MAX_REQUEST_BODY_MB) ?? clamp(Math.floor(memoryMb / 8), 16, 256)
  const jscBytes = positive(env.BUN_JSC_forceRAMSize)
  const jscHeapMb = jscBytes !== null ? Math.floor(jscBytes / MB) : clamp(Math.floor(memoryMb / 2), 64, 2048)
  const mallocOverride = positive(env.MALLOC_ARENA_MAX)
  const mallocArenaMax = mallocOverride !== null ? Math.round(mallocOverride) : clamp(Math.round(cpus * 2), 2, 8)

  const summary =
    `${formatCpu(cpus)} vCPU / ${formatMemory(memoryMb)} (${detected.cpuSource} CPU, ${detected.memorySource} memory) · ` +
    `sharp ${sharpConcurrency} thread${sharpConcurrency === 1 ? '' : 's'}/${sharpCacheMb} MB · ` +
    `${previewConcurrency} preview${previewConcurrency === 1 ? '' : 's'} · render ${renderMaxMegapixels} MP · ` +
    `AVIF ${avifMaxMegapixels} MP · SQLite ${sqliteCacheMb} MB · body ${maxRequestBodyMb} MB · ` +
    `JSC ${jscHeapMb} MB · malloc ${mallocArenaMax}`

  return {
    ...detected,
    cpus,
    memoryMb,
    sharpConcurrency,
    sharpCacheMb,
    previewConcurrency,
    renderMaxMegapixels,
    avifMaxMegapixels,
    sqliteCacheMb,
    maxRequestBodyMb,
    maxRequestBodyBytes: Math.round(maxRequestBodyMb * MB),
    jscHeapMb,
    mallocArenaMax,
    summary,
  }
}

/**
 * Fill blank environment variables with the tuned values. Values already set by
 * the user are never touched. Returns null when AUTOTUNE is off.
 */
export function applyAutotune(env: Env = process.env, detected?: DetectedResources): Tuning | null {
  if (disabled(env)) return null
  const tuning = tuningFor(detected ?? detectResources(env), env)
  setIfBlank(env, 'SHARP_CONCURRENCY', tuning.sharpConcurrency)
  setIfBlank(env, 'SHARP_CACHE_MB', tuning.sharpCacheMb)
  setIfBlank(env, 'PREVIEW_CONCURRENCY', tuning.previewConcurrency)
  setIfBlank(env, 'RENDER_MAX_MEGAPIXELS', tuning.renderMaxMegapixels)
  setIfBlank(env, 'AVIF_MAX_MEGAPIXELS', tuning.avifMaxMegapixels)
  setIfBlank(env, 'SQLITE_CACHE_MB', tuning.sqliteCacheMb)
  setIfBlank(env, 'MAX_REQUEST_BODY_MB', tuning.maxRequestBodyMb)
  setIfBlank(env, 'BUN_JSC_forceRAMSize', tuning.jscHeapMb * MB)
  setIfBlank(env, 'MALLOC_ARENA_MAX', tuning.mallocArenaMax)
  return tuning
}

/** The request body cap when autotune is off (or for small helper processes). */
export function bodyLimitBytes(env: Env = process.env): number {
  return Math.round((positive(env.MAX_REQUEST_BODY_MB) ?? 64) * MB)
}

/** SQLite page cache for callers that do not pass a tuned value. */
export function configuredSqliteCacheMb(env: Env = process.env): number {
  return positive(env.SQLITE_CACHE_MB) ?? 16
}

/** `SQLITE_MMAP_MB`: memory-mapped database window per connection; 0 disables it. */
export function configuredSqliteMmapMb(env: Env = process.env): number {
  const value = Number(env.SQLITE_MMAP_MB)
  if (env.SQLITE_MMAP_MB === undefined || env.SQLITE_MMAP_MB === '' || !Number.isFinite(value) || value < 0) return 256
  return Math.round(value)
}

/** `SQLITE_WAL_AUTOCHECKPOINT`: pages before a WAL checkpoint; 0 turns automatic checkpoints off. */
export function configuredWalAutocheckpoint(env: Env = process.env): number {
  const value = Number(env.SQLITE_WAL_AUTOCHECKPOINT)
  // 10,000 pages (~40 MB) instead of SQLite's 1,000-page default: a busy
  // writer checkpoints less often, and each checkpoint is off the read path
  // because a cluster gives the writer its own process.
  if (env.SQLITE_WAL_AUTOCHECKPOINT === undefined || env.SQLITE_WAL_AUTOCHECKPOINT === '' || !Number.isFinite(value) || value < 0) return 10000
  return Math.round(value)
}

/**
 * `SQLITE_BUSY_TIMEOUT_MS`: how long a write waits for SQLite's lock. The
 * writer owns that lock, so it can afford to wait; readers must fail fast
 * instead of blocking a public worker's event loop for seconds.
 */
export function configuredBusyTimeout(env: Env = process.env): number {
  const value = Number(env.SQLITE_BUSY_TIMEOUT_MS)
  if (env.SQLITE_BUSY_TIMEOUT_MS === undefined || env.SQLITE_BUSY_TIMEOUT_MS === '' || !Number.isFinite(value) || value < 0) return 5000
  return Math.round(value)
}

export function configuredReaderBusyTimeout(env: Env = process.env): number {
  const value = Number(env.SQLITE_READER_BUSY_TIMEOUT_MS)
  if (env.SQLITE_READER_BUSY_TIMEOUT_MS === undefined || env.SQLITE_READER_BUSY_TIMEOUT_MS === '' || !Number.isFinite(value) || value < 0) return 500
  return Math.round(value)
}

/** `bunwrite autotune`, `--json` or `--shell` for the startup-only values. */
export function reportAutotune(args: string[] = [], env: Env = process.env): void {
  if (disabled(env)) {
    if (args.includes('--json')) console.log(JSON.stringify({ enabled: false }, null, 2))
    else if (!args.includes('--shell')) console.log('Autotune is disabled (AUTOTUNE=false).')
    return
  }

  const detected = detectResources(env)
  const tuning = tuningFor(detected, env)

  if (args.includes('--json')) {
    console.log(JSON.stringify({ enabled: true, detected, tuning }, null, 2))
    return
  }

  if (args.includes('--shell')) {
    const lines: string[] = []
    if (env.BUN_JSC_forceRAMSize === undefined || env.BUN_JSC_forceRAMSize.trim() === '') {
      lines.push(`export BUN_JSC_forceRAMSize=${tuning.jscHeapMb * MB}`)
    }
    if (env.MALLOC_ARENA_MAX === undefined || env.MALLOC_ARENA_MAX.trim() === '') {
      lines.push(`export MALLOC_ARENA_MAX=${tuning.mallocArenaMax}`)
    }
    if (lines.length > 0) console.log(lines.join('\n'))
    return
  }

  console.log(`Detected ${formatCpu(detected.cpus)} vCPU / ${formatMemory(detected.memoryMb)} (${detected.cpuSource} CPU, ${detected.memorySource} memory)`)
  console.log(`  sharp: ${tuning.sharpConcurrency} threads, ${tuning.sharpCacheMb} MB cache`)
  console.log(`  previews: ${tuning.previewConcurrency} at once`)
  console.log(`  render: ${tuning.renderMaxMegapixels} MP, AVIF ${tuning.avifMaxMegapixels} MP`)
  console.log(`  SQLite cache: ${tuning.sqliteCacheMb} MB`)
  console.log(`  request body: ${tuning.maxRequestBodyMb} MB`)
  console.log(`  JSC heap: ${tuning.jscHeapMb} MB`)
  console.log(`  malloc arenas: ${tuning.mallocArenaMax}`)
  console.log('Explicit env values win; AUTOTUNE=false disables this.')
}
