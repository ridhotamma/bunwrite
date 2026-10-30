import { describe, expect, test } from 'bun:test'

import { checkCustomDomains, type DomainResolver } from '~/proxy/verify'

const serverIp = '203.0.113.10'

const resolver: DomainResolver = {
  addresses: async (host) => {
    if (host === 'landing.sites.example.com' || host === 'appwrite.example.com') return [serverIp]
    if (host === 'apex.example.org') return [serverIp]
    if (host.startsWith('wildcard-check-') && host.endsWith('.example.org')) return [serverIp]
    if (host === 'stale.example.org') return ['198.51.100.9']
    throw new Error('ENOTFOUND')
  },
  cnames: async (host) => {
    if (host === 'www.example.org') return ['landing.sites.example.com']
    if (host === 'stale.example.org') return ['old.sites.example.com']
    throw new Error('ENODATA')
  },
}

describe('custom-domain verification', () => {
  test('accepts a matching CNAME or an A record for the server', async () => {
    const overview = await checkCustomDomains(['www.example.org', 'apex.example.org'], {
      target: 'landing.sites.example.com',
      publicEndpoint: 'https://appwrite.example.com/v1',
      resolver,
    })

    expect(overview.cnameTarget).toBe('landing.sites.example.com')
    expect(overview.ipv4).toBe(serverIp)
    expect(overview.domains).toEqual([
      { domain: 'www.example.org', status: 'verified' },
      { domain: 'apex.example.org', status: 'verified' },
    ])
  })

  test('verifies a wildcard by probing a label it covers', async () => {
    const overview = await checkCustomDomains(['*.example.org'], {
      target: 'landing.sites.example.com',
      publicEndpoint: 'https://appwrite.example.com/v1',
      resolver,
    })

    expect(overview.domains).toEqual([{ domain: '*.example.org', status: 'verified' }])
  })

  test('probes a wildcard with a fresh label each time', async () => {
    const probes: string[] = []
    const freshResolver: DomainResolver = {
      addresses: async (host) => {
        if (host.startsWith('wildcard-check-') && host.endsWith('.example.org')) {
          probes.push(host)
          return [serverIp]
        }
        if (host === 'landing.sites.example.com' || host === 'appwrite.example.com') return [serverIp]
        throw new Error('ENOTFOUND')
      },
      cnames: async () => {
        throw new Error('ENODATA')
      },
    }

    await checkCustomDomains(['*.example.org'], { target: 'landing.sites.example.com', publicEndpoint: 'https://appwrite.example.com/v1', resolver: freshResolver })
    await checkCustomDomains(['*.example.org'], { target: 'landing.sites.example.com', publicEndpoint: 'https://appwrite.example.com/v1', resolver: freshResolver })

    expect(probes).toHaveLength(2)
    expect(new Set(probes).size).toBe(2)
  })

  test('marks a different record as unverified', async () => {
    const overview = await checkCustomDomains(['stale.example.org', 'missing.example.org'], {
      target: 'landing.sites.example.com',
      publicEndpoint: 'https://appwrite.example.com/v1',
      resolver,
    })

    expect(overview.domains).toEqual([
      { domain: 'stale.example.org', status: 'unverified' },
      { domain: 'missing.example.org', status: 'unverified' },
    ])
  })

  test('does not block when DNS fails', async () => {
    const overview = await checkCustomDomains(['missing.example.org'], {
      target: 'landing.sites.example.com',
      publicEndpoint: 'https://appwrite.example.com/v1',
      resolver,
    })

    expect(overview.domains).toEqual([{ domain: 'missing.example.org', status: 'unverified' }])
  })
})
