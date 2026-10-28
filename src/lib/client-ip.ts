/**
 * The caller's IP address, used for login limits, sessions and logs.
 *
 * Forwarding headers (X-Forwarded-For, X-Real-IP, CF-Connecting-IP) are only
 * believed when the connection comes from a trusted proxy. Otherwise a client
 * could send a new address with every request and never hit a login limit.
 *
 * TRUSTED_PROXIES is a comma-separated list:
 *   private     loopback and private networks (the default): Caddy in Docker
 *               Compose, nginx on the host, Cloudflare Tunnel
 *   cloudflare  Cloudflare's edge addresses, and believe CF-Connecting-IP
 *   none        trust no proxy; always use the connection's address
 *   1.2.3.4, 10.1.0.0/16, fd00::/8   specific proxies
 */
import { BlockList, isIP } from 'node:net'

export interface TrustedProxies {
  list: BlockList
  /** Believe CF-Connecting-IP from a trusted proxy. */
  cloudflare: boolean
}

const PRIVATE_V4: [string, number][] = [
  ['127.0.0.0', 8],
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['100.64.0.0', 10],
]
const PRIVATE_V6: [string, number][] = [
  ['::1', 128],
  ['fc00::', 7],
]

// https://www.cloudflare.com/ips/
const CLOUDFLARE_V4 = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18',
  '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17',
  '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
]
const CLOUDFLARE_V6 = ['2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32']

/** `::ffff:10.0.0.1` → `10.0.0.1`; anything that is not an IP → null. */
function normalize(value: string | undefined | null): string | null {
  if (!value) return null
  let ip = value.trim()
  if (ip.startsWith('[') && ip.includes(']')) ip = ip.slice(1, ip.indexOf(']'))
  if (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(ip)) ip = ip.slice(7)
  return isIP(ip) ? ip : null
}

function addCidr(list: BlockList, cidr: string): void {
  const [address, bits] = cidr.split('/')
  const ip = normalize(address)
  if (!ip) throw new Error(`TRUSTED_PROXIES: "${cidr}" is not an IP address or CIDR range.`)
  const type = isIP(ip) === 4 ? 'ipv4' : 'ipv6'
  const max = type === 'ipv4' ? 32 : 128
  const prefix = bits === undefined ? max : Number(bits)
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) throw new Error(`TRUSTED_PROXIES: "${cidr}" has an invalid prefix length.`)
  list.addSubnet(ip, prefix, type)
}

export function parseTrustedProxies(spec: string | undefined): TrustedProxies {
  const list = new BlockList()
  let cloudflare = false
  const tokens = (spec ?? 'private').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean)
  for (const token of tokens.length ? tokens : ['private']) {
    if (token === 'none') continue
    if (token === 'private') {
      for (const [a, b] of PRIVATE_V4) list.addSubnet(a, b, 'ipv4')
      for (const [a, b] of PRIVATE_V6) list.addSubnet(a, b, 'ipv6')
    } else if (token === 'cloudflare') {
      cloudflare = true
      for (const cidr of [...CLOUDFLARE_V4, ...CLOUDFLARE_V6]) addCidr(list, cidr)
    } else {
      addCidr(list, token)
    }
  }
  return { list, cloudflare }
}

const trusted = (trust: TrustedProxies, ip: string) => trust.list.check(ip, isIP(ip) === 4 ? 'ipv4' : 'ipv6')

/**
 * Work out the client's address. `peer` is the connection's address; when it
 * is unknown (the app called without a server, as in tests) the headers are
 * believed.
 */
export function resolveClientIp(request: Request, peer: string | undefined, trust: TrustedProxies): string {
  const direct = normalize(peer)
  if (direct && !trusted(trust, direct)) return direct

  if (trust.cloudflare) {
    const cf = normalize(request.headers.get('cf-connecting-ip'))
    if (cf) return cf
  }

  // Proxies append the address they saw, so read from the right and stop at
  // the first hop that is not one of our proxies.
  const hops = (request.headers.get('x-forwarded-for') ?? '').split(',').map(normalize)
  let leftmost: string | null = null
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = hops[i]
    if (!hop) break
    if (!trusted(trust, hop)) return hop
    leftmost = hop
  }
  if (leftmost) return leftmost

  return normalize(request.headers.get('x-real-ip')) ?? direct ?? ''
}

const resolved = new WeakMap<Request, string>()
let defaultTrust: TrustedProxies | null = null

/** Record the client's address for this request, once, where the server is known. */
export function rememberClientIp(request: Request, peer: string | undefined, trust: TrustedProxies): string {
  const ip = resolveClientIp(request, peer, trust)
  resolved.set(request, ip)
  return ip
}

/** The client's address for this request (see rememberClientIp). */
export function clientIpOf(request: Request): string {
  const known = resolved.get(request)
  if (known !== undefined) return known
  defaultTrust ??= parseTrustedProxies(process.env.TRUSTED_PROXIES)
  return resolveClientIp(request, undefined, defaultTrust)
}
