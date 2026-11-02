/**
 * Outbound URL checks for user-controlled destinations (webhooks, renders).
 *
 * A webhook URL is chosen by a project key holder, but the request is made by
 * the server from inside the private network. Without a guard it can reach
 * loopback services, Docker-internal hostnames or a cloud metadata endpoint.
 * The literal check runs when a URL is saved; `assertPublicDestination` also
 * resolves DNS at delivery time, so a hostname cannot be rebound between the
 * two.
 */
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

/** Names that never point at public infrastructure. */
const INTERNAL_NAMES = new Set([
  'localhost',
  'metadata',
  'metadata.google.internal',
  'instance-data',
  '169.254.169.254.nip.io',
])

const INTERNAL_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa', '.localdomain', '.svc', '.cluster.local']

const ipv4Parts = (ip: string): number[] | null => {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null
  return parts
}

export function isPrivateIpv4(ip: string): boolean {
  const p = ipv4Parts(ip)
  if (!p) return false
  const [a, b, c] = p as [number, number, number, number]
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  )
}

/** Expand an IPv6 address to its eight 16-bit groups, or null. */
function ipv6Groups(ip: string): number[] | null {
  let value = ip.split('%')[0]!
  // IPv4-mapped/embedded forms end in a dotted quad.
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(value)
  if (v4) {
    const parts = ipv4Parts(v4[1]!)
    if (!parts) return null
    value = value.slice(0, -v4[1]!.length) + `${((parts[0]! << 8) | parts[1]!).toString(16)}:${((parts[2]! << 8) | parts[3]!).toString(16)}`
  }
  const halves = value.split('::')
  if (halves.length > 2) return null
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = 8 - left.length - right.length
  if (halves.length === 1 ? left.length !== 8 : missing < 0) return null
  const groups = [...left, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...right]
  const parsed = groups.map((group) => Number.parseInt(group, 16))
  return parsed.length === 8 && parsed.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff) ? parsed : null
}

export function isPrivateIpv6(ip: string): boolean {
  const g = ipv6Groups(ip)
  if (!g) return false
  // :: and ::1
  if (g.every((group) => group === 0)) return true
  if (g.slice(0, 7).every((group) => group === 0) && g[7] === 1) return true
  // IPv4-mapped ::ffff:0:0/96 and IPv4-compatible ::/96.
  if (g.slice(0, 5).every((group) => group === 0) && (g[5] === 0xffff || g[5] === 0)) {
    const v4 = `${g[6]! >> 8}.${g[6]! & 0xff}.${g[7]! >> 8}.${g[7]! & 0xff}`
    if (isPrivateIpv4(v4)) return true
  }
  // fc00::/7 unique local, fe80::/10 link local, ff00::/8 multicast,
  // 2001:db8::/32 documentation, 100::/64 discard.
  if ((g[0]! & 0xfe00) === 0xfc00) return true
  if ((g[0]! & 0xffc0) === 0xfe80) return true
  if ((g[0]! & 0xff00) === 0xff00) return true
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true
  if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true
  return false
}

export function isPrivateAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, '').split('%')[0]!
  const family = isIP(bare)
  if (family === 4) return isPrivateIpv4(bare)
  if (family === 6) return isPrivateIpv6(bare)
  return true
}

function isInternalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  if (!host) return true
  if (INTERNAL_NAMES.has(host)) return true
  if (INTERNAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true
  // A single label resolves through the host's own search domains, which is
  // exactly how internal Docker/Kubernetes services are named.
  if (!host.includes('.') && isIP(host) === 0) return true
  return false
}

/** Reject a URL whose literal host is private. No DNS lookup yet. */
export function assertPublicUrlShape(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('URL must be a valid http or https URL.')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('URL must be a valid http or https URL.')
  if (url.username || url.password) throw new Error('URL must not contain credentials.')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new Error('URL must point at a public address.')
  } else if (isInternalHostname(host)) {
    throw new Error('URL must point at a public host.')
  }
  return url
}

/**
 * Resolve the host and reject every private address it maps to. Called right
 * before a request leaves the server; set `allowPrivate` for local
 * development and trusted internal receivers.
 */
export async function assertPublicDestination(value: string, allowPrivate = false): Promise<URL> {
  const url = assertPublicUrlShape(value)
  if (allowPrivate) return url
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host)) return url
  let addresses: Array<{ address: string }>
  try {
    addresses = await lookup(host, { all: true })
  } catch (error) {
    throw new Error(`Could not resolve the webhook host: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  if (addresses.length === 0) throw new Error('The webhook host did not resolve to an address.')
  if (addresses.some((entry) => isPrivateAddress(entry.address))) throw new Error('URL must point at a public address.')
  return url
}

/** Private destinations are allowed in tests and behind an explicit opt-in. */
export const allowPrivateDestinations = (): boolean =>
  process.env.NODE_ENV === 'test' || process.env.WEBHOOKS_ALLOW_PRIVATE === 'true'
