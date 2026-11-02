/**
 * Server secrets that function and site processes never inherit from the host
 * environment. This is a denylist of *host* variables, not of the project or
 * function variables the operator explicitly configured: those are merged in
 * after the host environment and still work.
 *
 * The exact list is kept for documentation and backwards-compatible tests;
 * `isPrivateEnv` also applies prefix/suffix rules, so a newly added
 * `SOMETHING_API_KEY` is not exposed just because nobody remembered to add it
 * to the list.
 */
export const PRIVATE_ENV = [
  'SECRET',
  'API_KEYS',
  'GOOGLE_CLIENT_SECRET',
  'FACEBOOK_CLIENT_SECRET',
  'GITHUB_CLIENT_SECRET',
  'APPLE_PRIVATE_KEY',
  'SMTP_PASSWORD',
  'CONSOLE_ADMIN_PASSWORD',
  'BACKUP_ENCRYPTION_KEY',
]

const EXACT = new Set(PRIVATE_ENV.map((key) => key.toUpperCase()))

/** Whole families of host configuration that user code must never read. */
const PREFIX = /^(AWS|DATABASE|DB|REDIS|VCS|GITHUB|GOOGLE|FACEBOOK|APPLE|OAUTH|LITESTREAM|SMTP|CONSOLE|BUNWRITE|APPWRITE|OTEL|POSTHOG|DATADOG|DD|OPENAI|RAG|EMBEDDING|CLOUDFLARE|CF)_/

/** Credential-shaped names, whatever service they belong to. */
const SUFFIX = /_(SECRET|SECRET_KEY|PASSWORD|PASSWD|PRIVATE_KEY|API_KEY|ACCESS_KEY|ACCESS_TOKEN|AUTH_TOKEN|REFRESH_TOKEN|CREDENTIALS|TOKEN|ENCRYPTION_KEY|WEBHOOK_SECRET)$/

export function isPrivateEnv(key: string): boolean {
  const upper = key.toUpperCase()
  return EXACT.has(upper) || PREFIX.test(upper) || SUFFIX.test(upper)
}
