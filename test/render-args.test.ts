import { describe, expect, test } from 'bun:test'

import { chromeArgs, chromeSandboxDisabled } from '~/render/service'

describe('Chromium sandbox flags', () => {
  test('CHROME_NO_SANDBOX=true always disables the sandbox', () => {
    const context = { env: { CHROME_NO_SANDBOX: 'true' }, uid: 1000, container: false }
    expect(chromeSandboxDisabled(context)).toBe(true)
    expect(chromeArgs(context)).toContain('--no-sandbox')
  })

  test('CHROME_NO_SANDBOX=false keeps the sandbox even for root in a container', () => {
    const context = { env: { CHROME_NO_SANDBOX: 'false' }, uid: 0, container: true }
    expect(chromeSandboxDisabled(context)).toBe(false)
    expect(chromeArgs(context)).not.toContain('--no-sandbox')
  })

  test('auto disables the sandbox for root and inside containers', () => {
    expect(chromeSandboxDisabled({ env: {}, uid: 0, container: false })).toBe(true)
    expect(chromeSandboxDisabled({ env: {}, uid: 1000, container: true })).toBe(true)
    expect(chromeSandboxDisabled({ env: {}, uid: 1000, container: false })).toBe(false)
    expect(chromeSandboxDisabled({ env: { CHROME_NO_SANDBOX: 'auto' }, uid: 1000, container: false })).toBe(false)
  })

  test('CHROME_ARGS is appended after the built-in flags', () => {
    const args = chromeArgs({ env: { CHROME_ARGS: '--foo --bar', CHROME_NO_SANDBOX: 'false' }, uid: 1000, container: false })
    expect(args.slice(-2)).toEqual(['--foo', '--bar'])
  })
})
