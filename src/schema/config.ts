/**
 * The project-config shape shared by the SQLite push and the Postgres push.
 *
 * The config file also has databases and collections; those are read by
 * `readConfig` in `push.ts` because it normalises them into `ConfigCollection`.
 */

export interface BucketConfig {
  $id: string
  name?: string
  enabled?: boolean
  fileSecurity?: boolean
  $permissions?: string[]
  maximumFileSize?: number
  allowedFileExtensions?: string[]
  compression?: string
  encryption?: boolean
  antivirus?: boolean
  transformations?: boolean
}

export interface FunctionConfig {
  $id: string
  name?: string
  runtime?: string
  entrypoint?: string
  path?: string
  execute?: string[]
  events?: string[]
  schedule?: string
  timeout?: number
  enabled?: boolean
  scopes?: string[]
  commands?: string
  logging?: boolean
  buildSpecification?: string
  runtimeSpecification?: string
  deploymentRetention?: number
}

export interface ProjectConfig {
  buckets?: BucketConfig[]
  functions?: FunctionConfig[]
  [key: string]: unknown
}
