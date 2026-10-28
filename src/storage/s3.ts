/** Bun's native S3 client, configured from console settings. */
import { S3Client } from 'bun'

import type { S3Config } from '~/config'

export const s3Key = (...parts: string[]) => parts.map((part) => part.replace(/^\/+|\/+$/g, '')).join('/')

/**
 * The URL Bun talks to. Virtual-hosted style puts the bucket in the host; path
 * style keeps it in the path. An endpoint that already names the bucket, as
 * AWS and Bun document the virtual-hosted form, is used once, never twice:
 * `<bucket>.<bucket>.<host>` has no certificate and no DNS record.
 */
export function s3Endpoint(config: S3Config): string {
  const url = new URL(config.endpoint.replace(/\/$/, ''))
  const path = url.pathname.replace(/\/$/, '')
  const prefixed = Boolean(config.bucket) && url.host.startsWith(`${config.bucket}.`)
  const host = prefixed ? url.host.slice(config.bucket.length + 1) : url.host
  return `${url.protocol}//${config.forcePathStyle ? host : `${config.bucket}.${host}`}${path}`
}

export function s3Client(config: S3Config): S3Client {
  return new S3Client({
    accessKeyId: config.accessKey,
    secretAccessKey: config.secret,
    bucket: config.bucket,
    region: config.region || 'us-east-1',
    endpoint: s3Endpoint(config),
    virtualHostedStyle: !config.forcePathStyle,
  })
}

/** A certificate or host failure, the usual result of an addressing style the endpoint does not serve. */
const ADDRESS_ERROR = /CERT|TLS|ENOTFOUND|EHOSTUNREACH|ECONNREFUSED|EPROTO/

/**
 * Run an S3 operation. A certificate or DNS failure is explained with the URL
 * that failed and the setting that usually fixes it; every other error is
 * passed through as it came.
 */
export async function s3Call<T>(config: S3Config, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    const code = String((error as { code?: unknown } | null)?.code ?? '')
    if (!ADDRESS_ERROR.test(code)) throw error
    let endpoint = config.endpoint
    try {
      endpoint = s3Endpoint(config)
    } catch {
      /* the message keeps the endpoint as configured */
    }
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `S3 request to ${endpoint} failed (${code}: ${message}). Check the endpoint, bucket and region. If this is an S3-compatible service or an AWS bucket name with dots, turn on Force path-style addressing in Settings → File storage.`,
    )
  }
}
