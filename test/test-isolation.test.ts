import { expect, test } from 'bun:test'

import { deploymentDir } from '~/functions/deployments'
import { sitesDir } from '~/sites/paths'
import { startServer } from './helpers'

test('each test server builds in its own deployment folder', () => {
  const first = startServer()
  const second = startServer()
  try {
    // Test servers share an in-memory database and the project ID; without a
    // per-server key one file's cleanup can delete another file's build.
    expect(sitesDir(first.config, 'app')).not.toBe(sitesDir(second.config, 'app'))
    expect(deploymentDir(first.config, 'api')).not.toBe(deploymentDir(second.config, 'api'))
  } finally {
    first.stop()
    second.stop()
  }
})
