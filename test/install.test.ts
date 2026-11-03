/**
 * The installer has to produce the same stack on a developer laptop and inside
 * the one-shot container. These tests cover the file generation without a
 * Docker daemon; only `--no-start` runs are used.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import composeTemplate from '../deploy/install/docker-compose.yml' with { type: 'text' }
import { normalizeDomain, parseEnv, renderCompose, runInstall, setEnvValue } from '../src/cli/install'

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bunwrite-install-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function quietContext() {
  return {
    interactive: false,
    env: { PATH: process.env.PATH, HOME: process.env.HOME } as NodeJS.ProcessEnv,
    log: () => {},
    warn: () => {},
  }
}

async function install(dir: string, ...args: string[]): Promise<number> {
  return runInstall('install', ['--no-start', '--non-interactive', '--target', dir, '--host-path', dir, '--image', 'bunwrite:test', ...args], quietContext())
}

describe('installer arguments and env files', () => {
  test('normalizes a pasted URL to a hostname', () => {
    expect(normalizeDomain('https://Example.COM:8443/path')).toBe('example.com')
    expect(normalizeDomain('example.com.')).toBe('example.com')
    expect(normalizeDomain('')).toBe('')
  })

  test('replaces commented and active keys and appends missing ones', () => {
    const source = '# DOMAIN=old.example.com\nCOMPOSE_PROFILES=caddy\n'
    const domain = setEnvValue(source, 'DOMAIN', 'new.example.com')
    expect(domain).toContain('DOMAIN=new.example.com')
    expect(domain).not.toContain('# DOMAIN=')

    const profiles = setEnvValue(domain, 'COMPOSE_PROFILES', '')
    expect(profiles).toContain('COMPOSE_PROFILES=')

    const appended = setEnvValue(profiles, 'BUNWRITE_PORT', '8080')
    expect(parseEnv(appended)).toMatchObject({
      DOMAIN: 'new.example.com',
      COMPOSE_PROFILES: '',
      BUNWRITE_PORT: '8080',
    })
  })
})

describe('compose rendering', () => {
  test('uses the requested image and absolute host mounts', () => {
    const compose = renderCompose(composeTemplate, '/srv/bunwrite', 'ghcr.io/example/bunwrite:1.2.3')
    expect(compose).toContain('image: "ghcr.io/example/bunwrite:1.2.3"')
    expect(compose).toContain("'/srv/bunwrite/Caddyfile:/etc/caddy/Caddyfile:ro'")
    expect(compose).not.toContain('__BUNWRITE_')
    expect(compose).not.toContain('build:')
  })
})

describe('install --no-start', () => {
  test('writes a runnable stack and a private env file', async () => {
    const dir = tempDir()
    expect(await install(dir, '--domain', 'example.com', '--admin-email', 'admin@example.com', '--admin-password', 'password123')).toBe(0)

    const env = readFileSync(join(dir, '.env'), 'utf8')
    expect(env).toContain('DOMAIN=example.com')
    expect(env).toContain('COMPOSE_PROFILES=caddy')
    expect(env).toContain('CONSOLE_ADMIN_EMAIL=admin@example.com')
    expect(env).toContain('CONSOLE_ADMIN_PASSWORD=password123')
    expect(env).toContain('TLS_CERT_DIR=' + join(dir, 'certs'))

    expect(statSync(join(dir, '.env')).mode & 0o777).toBe(0o600)
    expect(readFileSync(join(dir, 'docker-compose.yml'), 'utf8')).toContain(`'${dir}/Caddyfile:/etc/caddy/Caddyfile:ro'`)
    for (const name of ['Caddyfile', 'Caddyfile.external', 'Caddyfile.off', 'caddy-entrypoint.sh']) {
      expect(readFileSync(join(dir, name), 'utf8').length).toBeGreaterThan(100)
    }
    expect(statSync(join(dir, 'caddy-entrypoint.sh')).mode & 0o777).toBe(0o755)
  })

  test('reuses the admin and domain on a second run', async () => {
    const dir = tempDir()
    expect(await install(dir, '--domain', 'one.example.com', '--admin-password', 'keep-this-password')).toBe(0)
    expect(await install(dir, '--domain', 'two.example.com', '--image', 'bunwrite:test2')).toBe(0)

    const env = readFileSync(join(dir, '.env'), 'utf8')
    expect(env).toContain('DOMAIN=two.example.com')
    expect(env).toContain('CONSOLE_ADMIN_PASSWORD=keep-this-password')
    expect(readFileSync(join(dir, 'docker-compose.yml'), 'utf8')).toContain('image: "bunwrite:test2"')

    const backups = readdirSync(dir)
    expect(backups.some((name) => name.startsWith('.env.') && name.endsWith('.backup'))).toBe(true)
    expect(backups.some((name) => name.startsWith('docker-compose.yml.') && name.endsWith('.backup'))).toBe(true)
  })

  test('a custom proxy gets no Caddy profile', async () => {
    const dir = tempDir()
    expect(await install(dir, '--no-caddy', '--app-port', '9090')).toBe(0)
    let env = parseEnv(readFileSync(join(dir, '.env'), 'utf8'))
    expect(env.COMPOSE_PROFILES).toBe('')
    expect(env.BUNWRITE_PORT).toBe('9090')
    expect(env.DOMAIN).toBe('')

    expect(await install(dir, '--caddy')).toBe(0)
    env = parseEnv(readFileSync(join(dir, '.env'), 'utf8'))
    expect(env.COMPOSE_PROFILES).toBe('caddy')
  })

  test('upgrade requires an existing installation', async () => {
    const dir = tempDir()
    const errors: string[] = []
    const original = console.error
    console.error = (...args: unknown[]) => errors.push(args.join(' '))
    try {
      const code = await runInstall('upgrade', ['--no-start', '--target', dir, '--host-path', dir], quietContext())
      expect(code).toBe(1)
      expect(errors.join('\n')).toContain('No installation found')
    } finally {
      console.error = original
    }
  })
})
