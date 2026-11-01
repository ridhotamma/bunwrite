import { describe, expect, test } from 'bun:test'

import { BackupService } from '~/backups/service'
import { maskStorage, walgStatus } from '~/backups/walg'
import { testConfig } from './helpers'

describe('WAL-G status', () => {
  test('reports the configured storage without leaking credentials', () => {
    const status = walgStatus({
      WALG_S3_PREFIX: 's3://access:secret@bucket/bunwrite/postgres',
      WALG_COMPRESSION_METHOD: 'zstd',
      WALG_LIBSODIUM_KEY: 'secret',
    })
    expect(status.configured).toBe(true)
    expect(status.storage).toContain('bucket/bunwrite/postgres')
    expect(status.storage).not.toContain('secret')
    expect(status.compression).toBe('zstd')
    expect(status.encrypted).toBe(true)
    expect(status.archiveCommand).toBe('wal-g wal-push %p')
    expect(status.restoreCommand).toBe('wal-g wal-fetch %f %p')
  })

  test('is unconfigured without a storage prefix', () => {
    const status = walgStatus({})
    expect(status.configured).toBe(false)
    expect(status.storage).toBeUndefined()
    expect(status.encrypted).toBe(false)
  })

  test('masks credentials in a plain string prefix', () => {
    expect(maskStorage('file://user:pass@/mnt/backups')).not.toContain('pass')
  })
})

describe('Postgres backup service', () => {
  test('does not offer file archives on a non-local database', async () => {
    const service = new BackupService(testConfig(), false)
    expect(await service.list()).toEqual([])
    await expect(service.create('manual')).rejects.toThrow('Backups are managed')
  })
})
