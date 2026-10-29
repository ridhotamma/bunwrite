/** The CLI's .env handling and push plan, without a server. */
import { describe, expect, test } from 'bun:test'

import { planPush } from '../packages/cli/src/envplan'
import { editEnv, formatValue, parseEnv, type EnvFile, type EnvValue } from '../packages/cli/src/envfiles'
import { environmentView } from '../packages/cli/src/overrides'

describe('parseEnv', () => {
  test('reads plain, exported, quoted, commented and multi-line values', () => {
    const text = [
      '# comment',
      'PLAIN=hello',
      'export EXPORTED=yes',
      'SPACED = value with spaces # trailing comment',
      'HASH=a#b',
      "SINGLE='raw $HOME # kept'",
      'DOUBLE="line\\nnext \\"quoted\\" \\$x"',
      'MULTI="first',
      'second"',
      'EMPTY=',
      'NOTE_ONLY=  # secret: set on the server',
      'not a variable',
    ].join('\n')
    const values = Object.fromEntries(parseEnv(text).map((e) => [e.key, e.value]))
    expect(values).toEqual({
      PLAIN: 'hello',
      EXPORTED: 'yes',
      SPACED: 'value with spaces',
      HASH: 'a#b',
      SINGLE: 'raw $HOME # kept',
      DOUBLE: 'line\nnext "quoted" $x',
      MULTI: 'first\nsecond',
      EMPTY: '',
      NOTE_ONLY: '',
    })
  })
})

describe('editEnv', () => {
  test('changes values in place, keeps comments and order, appends new keys', () => {
    const before = '# Settings\nA=1\n\n# Keep me\nB=2\nC="multi\nline"\nD=4\n'
    const after = editEnv(before, new Map([['B', 'two words'], ['C', null], ['E', 'new']]), new Map([['E', 'note']]))
    expect(after).toBe('# Settings\nA=1\n\n# Keep me\nB="two words"\nD=4\nE=new  # note\n')
  })

  test('collapses duplicate keys to one when the key changes', () => {
    expect(editEnv('A=1\nA=2\n', new Map([['A', '3']]))).toBe('A=3\n')
  })

  test('values survive a write and read back', () => {
    for (const value of ['', 'simple', 'with space', 'quote " and \\ backslash', 'multi\nline', '$HOME', '#hash', 'url=https://x.y/?a=1&b=2']) {
      const text = editEnv('', new Map([['K', value]]))
      expect(parseEnv(text)[0]?.value).toBe(value)
    }
    expect(formatValue('abc-123_./:@')).toBe('abc-123_./:@')
  })
})

describe('planPush', () => {
  const file = (secret: boolean): EnvFile => ({ path: '', label: secret ? '.env.staging.local' : '.env.staging', secret, own: true, context: '' })
  const local = (entries: [string, string, boolean][]) =>
    new Map<string, EnvValue>(entries.map(([k, value, secret]) => [k, { value, secret, file: file(secret) }]))
  const variable = (key: string, value: string, secret = false) => ({ $id: `id-${key}`, key, value, secret }) as any

  test('creates, updates, re-sends secrets, keeps placeholders, and lists what is only on the server', () => {
    const plan = planPush(
      local([
        ['NEW', '1', false],
        ['NEW_SECRET', 's', true],
        ['SAME', 'x', false],
        ['CHANGED', 'new', false],
        ['NOW_SECRET', 'v', true],
        ['SECRET_SET', 'value', true],
        ['PLACEHOLDER', '', true],
        ['UNSET', '', true],
      ]),
      [
        variable('SAME', 'x'),
        variable('CHANGED', 'old'),
        variable('NOW_SECRET', 'v'),
        variable('SECRET_SET', '', true),
        variable('PLACEHOLDER', '', true),
        variable('SERVER_ONLY', 'z'),
      ],
    )
    expect(plan.create.map((c) => [c.key, c.secret])).toEqual([['NEW', false], ['NEW_SECRET', true]])
    expect(plan.update.map((u) => [u.variable.key, u.becomesSecret])).toEqual([['CHANGED', false], ['NOW_SECRET', true]])
    expect(plan.resend.map((r) => r.variable.key)).toEqual(['SECRET_SET'])
    expect(plan.missing.map((m) => m.key)).toEqual(['UNSET'])
    expect(plan.remove.map((v) => v.key)).toEqual(['SERVER_ONLY'])
    expect(plan.unchanged).toBe(2)
  })
})

describe('environmentView', () => {
  const config: any = {
    projectId: 'p',
    settings: { services: { sites: true }, protocols: { rest: true } },
    functions: [{ $id: 'api', name: 'API', schedule: '0 * * * *' }, { $id: 'backup', name: 'Backup', schedule: '0 2 * * *' }],
    sites: [{ $id: 'web', name: 'Web', domains: ['example.com'], apiFunctionId: 'api' }],
    buckets: [{ $id: 'media', name: 'Media' }],
  }
  const env = {
    idSuffix: '-staging',
    overrides: {
      sites: { web: { domains: ['staging.example.com'] } },
      functions: { backup: { schedule: '' } },
      buckets: { media: { name: 'Media (staging)' } },
      settings: { protocols: { rest: false } },
    },
  }

  test('suffixes site and function IDs, follows apiFunctionId, and applies overrides', () => {
    const view = environmentView(config, env)
    expect(view.config.functions!.map((f: any) => f.$id)).toEqual(['api-staging', 'backup-staging'])
    expect(view.config.sites![0]).toMatchObject({ $id: 'web-staging', domains: ['staging.example.com'], apiFunctionId: 'api-staging' })
    expect(view.config.functions![1].schedule).toBe('')
    expect(view.config.buckets![0]).toEqual({ $id: 'media', name: 'Media (staging)' })
    expect(view.config.settings.protocols).toEqual({ rest: false })
    expect(view.envId('functions', 'backup')).toBe('backup-staging')
    expect(view.envId('buckets', 'media')).toBe('media')
    // The shared config is left alone.
    expect(config.sites[0].$id).toBe('web')
  })

  test('restore maps a pulled config back to shared IDs and shared values', () => {
    const view = environmentView(config, env)
    const pulled: any = JSON.parse(JSON.stringify(view.config))
    pulled.functions.push({ $id: 'new-staging', name: 'New' })
    pulled.sites[0].name = 'Web renamed'
    const back: any = view.restore(pulled)
    expect(back.sites[0]).toEqual({ $id: 'web', name: 'Web renamed', domains: ['example.com'], apiFunctionId: 'api' })
    expect(back.functions.map((f: any) => [f.$id, f.schedule])).toEqual([['api', '0 * * * *'], ['backup', '0 2 * * *'], ['new', undefined]])
    expect(back.buckets[0].name).toBe('Media')
    expect(back.settings.protocols).toEqual({ rest: true })
  })

  test('an override for an entry the config lacks is an error, and no environment changes nothing', () => {
    expect(() => environmentView(config, { overrides: { sites: { nope: { domains: [] } } } })).toThrow('overrides.sites.nope')
    expect(environmentView(config, null).config).toBe(config)
  })
})
