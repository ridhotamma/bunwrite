/** Bun's native S3 client, configured from console settings. */
import { S3Client } from 'bun'

import type { S3Config } from '~/config'

export const s3Key = (...parts: string[]) => parts.map((part) => part.replace(/^\/+|\/+$/g, '')).join('/')

export function s3Client(config: S3Config): S3Client {
  const base = config.endpoint.replace(/\/$/, '')
  const virtualHosted = !config.forcePathStyle
  let endpoint = base
  if (virtualHosted) {
    const url = new URL(base)
    endpoint = `${url.protocol}//${config.bucket}.${url.host}${url.pathname.replace(/\/$/, '')}`
  }
  return new S3Client({
    accessKeyId: config.accessKey,
    secretAccessKey: config.secret,
    bucket: config.bucket,
    region: config.region || 'us-east-1',
    endpoint,
    virtualHostedStyle: virtualHosted,
  })
}
