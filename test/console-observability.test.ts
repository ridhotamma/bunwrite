/** Console-managed observability settings: persistence, live reconfigure and reset. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { ConsoleAuth } from '~/console/auth'
import { PROJECT, startServer, type TestServer } from './helpers'

let server: TestServer
let base: string
let cookie = ''

async function form(path: string, fields: Record<string, string | string[]>) {
  const body = new URLSearchParams()
  for (const [key, value] of Object.entries(fields)) for (const one of ([] as string[]).concat(value)) body.append(key, one)
  return fetch(`${base}${path}`, {
    method: 'POST',
    body,
    redirect: 'manual',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
  })
}

const get = (path: string) => fetch(`${base}${path}`, { headers: { cookie }, redirect: 'manual' })

beforeAll(async () => {
  server = startServer()
  base = server.endpoint.replace(/\/v1$/, '')
  await new ConsoleAuth(server.db).upsert('admin@example.com', 'console-password')
  const login = await fetch(`${base}/console/login`, {
    method: 'POST',
    body: new URLSearchParams({ email: 'admin@example.com', password: 'console-password' }),
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  })
  cookie = `${login.headers.get('set-cookie')!.split(';')[0]!}; console_project=${PROJECT}`
})

afterAll(() => server.stop())

describe('observability settings console', () => {
  test('the settings tab renders the current environment defaults', async () => {
    const res = await get('/console/observability/settings')
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('Observability settings')
    expect(body).toContain('href="/console/observability/settings" class="on"')
    expect(body).toContain('Environment defaults')
    expect(body).toContain('Local console')
    expect(body).toContain('External exporters')
    expect(body).toContain('OTLP/HTTP')
    expect(body).toContain('Datadog')
    expect(body).toContain('PostHog')
    expect(body).toContain('Feature flags')
    expect(body).toContain('name="console"')
    expect(body).toContain('name="otlpEndpoint"')
    expect(body).toContain('name="localFlags"')
  })

  test('saving updates the live facade and hides secrets on the page', async () => {
    const saved = await form('/console/observability/settings', {
      consoleSampleRate: '50',
      spanLimit: '1234',
      eventLimit: '4321',
      consoleRetentionDays: '14',
      flushMs: '1000',
      timeoutMs: '2000',
      queueLimit: '1000',
      serviceName: 'booking-api',
      serviceVersion: '2.0.0',
      environment: 'staging',
      sampleRate: '25',
      otlpEndpoint: 'https://otlp.example.com',
      signals: ['traces', 'metrics'],
      otlpHeaders: 'api-key=abc',
      datadogApiKey: 'dd-console',
      datadogSite: 'datadoghq.eu',
      datadogLogs: 'on',
      datadogMetrics: 'on',
      posthogApiKey: 'phc_console',
      posthogHost: 'https://eu.i.posthog.com',
      posthogFlagsTtl: '60',
      localFlags: '{"new-checkout":true,"theme":"dark"}',
    })
    expect(saved.status).toBe(303)
    expect(saved.headers.get('location')).toContain('/console/observability/settings')

    const live = server.observability.config
    expect(live).toMatchObject({
      console: false,
      serviceName: 'booking-api',
      serviceVersion: '2.0.0',
      environment: 'staging',
      sampleRate: 0.25,
      consoleSampleRate: 0.5,
      spanLimit: 1234,
      eventLimit: 4321,
      consoleRetentionDays: 14,
      flushMs: 1000,
      timeoutMs: 2000,
      queueLimit: 1000,
      localFlags: { 'new-checkout': true, theme: 'dark' },
    })
    expect(live.otlp?.traces).toBe('https://otlp.example.com/v1/traces')
    expect([...(live.otlp?.signals ?? [])].sort()).toEqual(['metrics', 'traces'])
    expect(live.otlp?.headers).toEqual({ 'api-key': 'abc' })
    expect(live.datadog).toMatchObject({ apiKey: 'dd-console', site: 'datadoghq.eu', logs: true, metrics: true })
    expect(live.posthog).toMatchObject({
      apiKey: 'phc_console',
      host: 'https://eu.i.posthog.com',
      flags: false,
      analytics: false,
      flagsTtlMs: 60_000,
    })

    const page = await (await get('/console/observability/settings')).text()
    expect(page).toContain('Console override')
    expect(page).toContain('value="1234"')
    expect(page).toContain('value="https://otlp.example.com"')
    expect(page).toContain('Configured; leave blank to keep')
    // Secrets never come back in the page.
    expect(page).not.toContain('dd-console')
    expect(page).not.toContain('phc_console')
    expect(page).not.toContain('api-key=abc')

    // Local flags are evaluated without contacting PostHog.
    const flags = await (await get('/console/observability/flags?subject=project:test-project')).text()
    expect(flags).toContain('new-checkout')
    expect(flags).toContain('Local override')
    expect(flags).toContain('Local only')
  })

  test('a malformed flags object comes back as a page error', async () => {
    const bad = await form('/console/observability/settings', { localFlags: '{bad' })
    expect(bad.status).toBe(200)
    expect(await bad.text()).toContain('Feature flags must be a JSON object.')
  })

  test('reset removes the override and returns to the environment', async () => {
    expect(server.services.observabilitySettings.overridden).toBe(true)
    const reset = await form('/console/observability/settings/reset', {})
    expect(reset.status).toBe(303)
    expect(server.services.observabilitySettings.overridden).toBe(false)
    expect(server.observability.config.otlp).toBeNull()
    expect(server.observability.config.posthog).toBeNull()
    expect(server.observability.config.datadog).toBeNull()

    const page = await (await get('/console/observability/settings')).text()
    expect(page).toContain('Environment defaults')
    expect(page).not.toContain('Console override')
  })
})
