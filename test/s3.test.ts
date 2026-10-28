import { describe, expect, test } from 'bun:test'

import { s3Call, s3Client, s3Endpoint, s3Key } from '~/storage/s3'

const base = {
  enabled: true,
  endpoint: 'https://s3.example.com',
  bucket: 'bunwrite',
  region: 'us-east-1',
  accessKey: 'key',
  secret: 'secret',
  forcePathStyle: false,
}

describe('S3 storage configuration', () => {
  test('builds virtual-hosted and path-style presigned URLs', () => {
    expect(s3Client(base).presign('bucket/file.txt', { expiresIn: 60 })).toContain('https://bunwrite.s3.example.com/')
    expect(s3Client({ ...base, forcePathStyle: true }).presign('bucket/file.txt', { expiresIn: 60 })).toContain('https://s3.example.com/bunwrite/')
    expect(s3Key('/bucket/', '/file.txt')).toBe('bucket/file.txt')
  })

  test('a bucket already in the endpoint is not added twice', () => {
    // AWS and Bun document the virtual-hosted endpoint with the bucket in it.
    const named = { ...base, endpoint: 'https://bunwrite.s3.example.com' }
    expect(s3Endpoint(named)).toBe('https://bunwrite.s3.example.com')
    // Path style moves the bucket from the host into the path.
    expect(s3Endpoint({ ...named, forcePathStyle: true })).toBe('https://s3.example.com')
    // An endpoint with a path (Supabase) keeps it in both styles.
    const supabase = { ...base, endpoint: 'https://acct.supabase.co/storage/v1/s3', bucket: 'files' }
    expect(s3Endpoint(supabase)).toBe('https://files.acct.supabase.co/storage/v1/s3')
    expect(s3Endpoint({ ...supabase, forcePathStyle: true })).toBe('https://acct.supabase.co/storage/v1/s3')
  })

  test('a certificate failure names the endpoint and the setting that fixes it', async () => {
    const refused = Object.assign(new Error('an unexpected error has occurred'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' })
    await expect(
      s3Call(base, async () => {
        throw refused
      }),
    ).rejects.toThrow('https://bunwrite.s3.example.com')
    await expect(
      s3Call(base, async () => {
        throw refused
      }),
    ).rejects.toThrow('Force path-style addressing')
    // Anything else keeps the error it came with.
    const missing = Object.assign(new Error('NoSuchBucket'), { code: 'NoSuchBucket' })
    const caught = await s3Call(base, async () => {
      throw missing
    }).catch((error) => error)
    expect(caught).toBe(missing)
  })
})
