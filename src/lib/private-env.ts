/** Server secrets that function and site processes never inherit from the host environment. */
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
