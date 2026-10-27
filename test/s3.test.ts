import { describe, expect, test } from 'bun:test'

import { s3Client, s3Key } from '~/storage/s3'

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
})
