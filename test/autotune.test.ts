import { describe, expect, test } from 'bun:test'

import {
  applyAutotune,
  bodyLimitBytes,
  configuredSqliteCacheMb,
  configuredSqliteMmapMb,
  configuredWalAutocheckpoint,
  detectResources,
  MB,
  parseCpuLimit,
  parseMemoryLimit,
  tuningFor,
  type DetectedResources,
} from '~/system/autotune'

const resources = (cpus: number, memoryMb: number): DetectedResources => ({
  cpus,
  memoryMb,
  cpuSource: 'cgroup',
  memorySource: 'cgroup',
})

const fakeRead = (files: Record<string, string>) => (path: string) => files[path] ?? null

describe('cgroup parsing', () => {
  test('cpu.max quota and period', () => {
    expect(parseCpuLimit('200000 100000')).toBe(2)
    expect(parseCpuLimit('50000 100000')).toBe(0.5)
    expect(parseCpuLimit('max 100000')).toBeNull()
    expect(parseCpuLimit(null)).toBeNull()
  })

  test('memory bytes and unlimited sentinels', () => {
    expect(parseMemoryLimit('536870912')).toBe(536870912)
    expect(parseMemoryLimit('max')).toBeNull()
    expect(parseMemoryLimit('9223372036854771712')).toBeNull()
    expect(parseMemoryLimit(null)).toBeNull()
  })
})

describe('tuningFor', () => {
  test('512 MB profile matches the old hand-tuned compose values', () => {
    const tuning = tuningFor(resources(1, 512), {})
    expect(tuning).toMatchObject({
      sharpConcurrency: 1,
      sharpCacheMb: 16,
      previewConcurrency: 2,
      renderMaxMegapixels: 8,
      avifMaxMegapixels: 4,
      sqliteCacheMb: 16,
      maxRequestBodyMb: 64,
      maxRequestBodyBytes: 64 * MB,
      jscHeapMb: 256,
      mallocArenaMax: 2,
    })
  })

  test('grows with a 2 vCPU / 1 GB host', () => {
    const tuning = tuningFor(resources(2, 1024), {})
    expect(tuning).toMatchObject({
      sharpConcurrency: 2,
      sharpCacheMb: 32,
      previewConcurrency: 4,
      renderMaxMegapixels: 16,
      avifMaxMegapixels: 8,
      sqliteCacheMb: 32,
      maxRequestBodyMb: 128,
      jscHeapMb: 512,
      mallocArenaMax: 4,
    })
  })

  test('caps image and render work on a 4 vCPU / 2 GB host', () => {
    const tuning = tuningFor(resources(4, 2048), {})
    expect(tuning).toMatchObject({
      sharpConcurrency: 4,
      sharpCacheMb: 64,
      previewConcurrency: 8,
      renderMaxMegapixels: 30,
      avifMaxMegapixels: 16,
      sqliteCacheMb: 64,
      maxRequestBodyMb: 256,
      jscHeapMb: 1024,
      mallocArenaMax: 8,
    })
  })

  test('stays conservative on a 256 MB host', () => {
    const tuning = tuningFor(resources(1, 256), {})
    expect(tuning).toMatchObject({
      sharpConcurrency: 1,
      sharpCacheMb: 16,
      previewConcurrency: 1,
      renderMaxMegapixels: 4,
      avifMaxMegapixels: 2,
      sqliteCacheMb: 8,
      maxRequestBodyMb: 32,
      jscHeapMb: 128,
      mallocArenaMax: 2,
    })
  })

  test('explicit environment values win', () => {
    const tuning = tuningFor(resources(1, 512), {
      SHARP_CONCURRENCY: '3',
      SHARP_CACHE_MB: '0',
      PREVIEW_CONCURRENCY: '5',
      RENDER_MAX_MEGAPIXELS: '20',
      AVIF_MAX_MEGAPIXELS: '10',
      SQLITE_CACHE_MB: '48',
      MAX_REQUEST_BODY_MB: '200',
      BUN_JSC_forceRAMSize: String(300 * MB),
      MALLOC_ARENA_MAX: '6',
    })
    expect(tuning).toMatchObject({
      sharpConcurrency: 3,
      sharpCacheMb: 0,
      previewConcurrency: 5,
      renderMaxMegapixels: 20,
      avifMaxMegapixels: 10,
      sqliteCacheMb: 48,
      maxRequestBodyMb: 200,
      jscHeapMb: 300,
      mallocArenaMax: 6,
    })
  })
})

describe('applyAutotune', () => {
  test('fills blanks and keeps explicit values', () => {
    const env: Record<string, string | undefined> = { SHARP_CONCURRENCY: '3', PREVIEW_CONCURRENCY: '' }
    const tuning = applyAutotune(env, resources(1, 512))
    expect(tuning).not.toBeNull()
    expect(env.SHARP_CONCURRENCY).toBe('3')
    expect(env.PREVIEW_CONCURRENCY).toBe('2')
    expect(env.SHARP_CACHE_MB).toBe('16')
    expect(env.RENDER_MAX_MEGAPIXELS).toBe('8')
    expect(env.AVIF_MAX_MEGAPIXELS).toBe('4')
    expect(env.SQLITE_CACHE_MB).toBe('16')
    expect(env.MAX_REQUEST_BODY_MB).toBe('64')
    expect(env.BUN_JSC_forceRAMSize).toBe(String(256 * MB))
    expect(env.MALLOC_ARENA_MAX).toBe('2')
  })

  test('AUTOTUNE=false leaves the environment alone', () => {
    const env: Record<string, string | undefined> = { AUTOTUNE: 'false' }
    expect(applyAutotune(env, resources(1, 512))).toBeNull()
    expect(env).toEqual({ AUTOTUNE: 'false' })
  })
})

describe('detectResources', () => {
  test('reads cgroup v2 limits', () => {
    const detected = detectResources(
      {},
      {
        readFile: fakeRead({
          '/proc/self/cgroup': '0::/',
          '/sys/fs/cgroup/cpu.max': '150000 100000',
          '/sys/fs/cgroup/memory.max': '1073741824',
        }),
        cpuCount: () => 8,
        totalMemory: () => 8 * 1024 * MB,
      },
    )
    expect(detected).toMatchObject({ cpus: 1.5, memoryMb: 1024, cpuSource: 'cgroup', memorySource: 'cgroup' })
  })

  test('prefers the process cgroup over an unlimited root', () => {
    const detected = detectResources(
      {},
      {
        readFile: fakeRead({
          '/proc/self/cgroup': '0::/user.slice/bunwrite.service',
          '/sys/fs/cgroup/cpu.max': 'max 100000',
          '/sys/fs/cgroup/user.slice/bunwrite.service/cpu.max': '100000 100000',
          '/sys/fs/cgroup/memory.max': 'max',
          '/sys/fs/cgroup/user.slice/bunwrite.service/memory.max': '536870912',
        }),
        cpuCount: () => 8,
        totalMemory: () => 8 * 1024 * MB,
      },
    )
    expect(detected).toMatchObject({ cpus: 1, memoryMb: 512, cpuSource: 'cgroup', memorySource: 'cgroup' })
  })

  test('reads cgroup v1 limits from the process cgroup path', () => {
    const detected = detectResources(
      {},
      {
        readFile: fakeRead({
          '/proc/self/cgroup': '4:cpu,cpuacct:/docker/abc\n5:memory:/docker/abc',
          '/sys/fs/cgroup/cpu/docker/abc/cpu.cfs_quota_us': '50000',
          '/sys/fs/cgroup/cpu/docker/abc/cpu.cfs_period_us': '100000',
          '/sys/fs/cgroup/memory/docker/abc/memory.limit_in_bytes': '268435456',
        }),
        cpuCount: () => 4,
        totalMemory: () => 4 * 1024 * MB,
      },
    )
    expect(detected).toMatchObject({ cpus: 0.5, memoryMb: 256, cpuSource: 'cgroup', memorySource: 'cgroup' })
  })

  test('uses memory.high when memory.max is unlimited', () => {
    const detected = detectResources(
      {},
      {
        readFile: fakeRead({
          '/proc/self/cgroup': '0::/',
          '/sys/fs/cgroup/cpu.max': 'max 100000',
          '/sys/fs/cgroup/memory.max': 'max',
          '/sys/fs/cgroup/memory.high': '536870912',
        }),
        cpuCount: () => 4,
        totalMemory: () => 2048 * MB,
      },
    )
    expect(detected).toMatchObject({ cpus: 4, memoryMb: 512, cpuSource: 'host', memorySource: 'cgroup' })
  })

  test('falls back to the host when cgroup limits are unlimited', () => {
    const detected = detectResources(
      {},
      {
        readFile: fakeRead({
          '/proc/self/cgroup': '0::/',
          '/sys/fs/cgroup/cpu.max': 'max 100000',
          '/sys/fs/cgroup/memory.max': 'max',
        }),
        cpuCount: () => 4,
        totalMemory: () => 2048 * MB,
      },
    )
    expect(detected).toMatchObject({ cpus: 4, memoryMb: 2048, cpuSource: 'host', memorySource: 'host' })
  })

  test('AUTOTUNE_CPUS and AUTOTUNE_MEMORY_MB override detection', () => {
    const detected = detectResources(
      { AUTOTUNE_CPUS: '3', AUTOTUNE_MEMORY_MB: '2048' },
      {
        readFile: fakeRead({}),
        cpuCount: () => 8,
        totalMemory: () => 8 * 1024 * MB,
      },
    )
    expect(detected).toMatchObject({ cpus: 3, memoryMb: 2048, cpuSource: 'override', memorySource: 'override' })
  })
})

describe('fallback limits', () => {
  test('bodyLimitBytes uses MAX_REQUEST_BODY_MB or 64 MB', () => {
    expect(bodyLimitBytes({})).toBe(64 * MB)
    expect(bodyLimitBytes({ MAX_REQUEST_BODY_MB: '32' })).toBe(32 * MB)
  })

  test('configuredSqliteCacheMb uses SQLITE_CACHE_MB or 16 MB', () => {
    expect(configuredSqliteCacheMb({})).toBe(16)
    expect(configuredSqliteCacheMb({ SQLITE_CACHE_MB: '48' })).toBe(48)
  })

  test('configuredSqliteMmapMb uses SQLITE_MMAP_MB or 256 MB', () => {
    expect(configuredSqliteMmapMb({})).toBe(256)
    expect(configuredSqliteMmapMb({ SQLITE_MMAP_MB: '64' })).toBe(64)
    expect(configuredSqliteMmapMb({ SQLITE_MMAP_MB: '0' })).toBe(0)
  })

  test('configuredWalAutocheckpoint uses SQLITE_WAL_AUTOCHECKPOINT or 2000 pages', () => {
    expect(configuredWalAutocheckpoint({})).toBe(2000)
    expect(configuredWalAutocheckpoint({ SQLITE_WAL_AUTOCHECKPOINT: '500' })).toBe(500)
    expect(configuredWalAutocheckpoint({ SQLITE_WAL_AUTOCHECKPOINT: '0' })).toBe(0)
  })
})
