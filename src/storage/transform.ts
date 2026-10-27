/**
 * Appwrite file preview transformations (`/storage/buckets/:id/files/:id/preview`):
 * width, height, gravity, quality, borderWidth, borderColor, borderRadius,
 * opacity, rotation, background and output. Applied in Appwrite's order:
 * crop → opacity → background → border → border radius → rotation.
 */
import { err } from '~/lib/errors'

export const OUTPUTS = ['jpg', 'png', 'webp', 'avif', 'gif'] as const
export type OutputFormat = (typeof OUTPUTS)[number]

/** Sources larger than this are refused, which keeps decoding inside a small memory limit. */
export const MAX_INPUT_PIXELS = 40_000_000

const GRAVITY: Record<string, string> = {
  center: 'centre',
  'top-left': 'northwest',
  top: 'north',
  'top-right': 'northeast',
  left: 'west',
  right: 'east',
  'bottom-left': 'southwest',
  bottom: 'south',
  'bottom-right': 'southeast',
}

export interface Rgba {
  r: number
  g: number
  b: number
  alpha: number
}

export interface PreviewOptions {
  width: number
  height: number
  gravity: string
  /** -1 keeps the encoder default. */
  quality: number
  borderWidth: number
  borderColor: string
  borderRadius: number
  opacity: number
  /** Clockwise degrees, 0–359. */
  rotation: number
  /** Hex colour without '#', or '' for none. */
  background: string
  format: OutputFormat
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

function number(params: URLSearchParams, key: string, min: number, max: number, fallback: number): number {
  const raw = params.get(key)
  if (raw === null || raw === '') return fallback
  const value = Number(raw)
  return Number.isFinite(value) ? clamp(value, min, max) : fallback
}

/** `#abc`, `abc`, `aabbcc` or `aabbccdd` → lowercase hex without '#', or '' if invalid. */
export function hexColor(value: string | null): string {
  const hex = (value ?? '').trim().replace(/^#/, '').toLowerCase()
  return /^([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(hex) ? hex : ''
}

export function rgba(hex: string): Rgba {
  const full = hex.length <= 4 ? [...hex].map((c) => c + c).join('') : hex
  const at = (i: number) => parseInt(full.slice(i, i + 2), 16)
  return { r: at(0), g: at(2), b: at(4), alpha: full.length === 8 ? at(6) / 255 : 1 }
}

/** Read the query string the Appwrite SDKs send (getFilePreview / getFilePreviewURL). */
export function previewOptions(params: URLSearchParams, mimeType: string): PreviewOptions {
  let output = (params.get('output') || '').toLowerCase()
  if (output === 'jpeg') output = 'jpg'
  if (output === 'heic') throw err('general_argument_invalid', 'HEIC output is not supported on this server. Use avif or webp.')
  if (output && !(OUTPUTS as readonly string[]).includes(output)) throw err('general_argument_invalid', `Invalid output: use one of ${OUTPUTS.join(', ')}.`)
  const source = mimeType.split('/')[1]!.replace('jpeg', 'jpg')
  const gravity = (params.get('gravity') || 'center').toLowerCase()
  const rotation = Math.round(number(params, 'rotation', -360, 360, 0))
  return {
    width: Math.round(number(params, 'width', 0, 4000, 0)),
    height: Math.round(number(params, 'height', 0, 4000, 0)),
    gravity: gravity in GRAVITY ? gravity : 'center',
    quality: Math.round(number(params, 'quality', -1, 100, -1)),
    borderWidth: Math.round(number(params, 'borderWidth', 0, 100, 0)),
    borderColor: hexColor(params.get('borderColor')) || '000000',
    borderRadius: Math.round(number(params, 'borderRadius', 0, 4000, 0)),
    opacity: number(params, 'opacity', 0, 1, 1),
    rotation: ((rotation % 360) + 360) % 360,
    background: hexColor(params.get('background')),
    format: (output || ((OUTPUTS as readonly string[]).includes(source) ? source : 'jpg')) as OutputFormat,
  }
}

/** Cache file name: one per distinct set of options. */
export function previewKey(o: PreviewOptions): string {
  return [
    `${o.width}x${o.height}`,
    o.gravity,
    `q${o.quality}`,
    `b${o.borderWidth}-${o.borderColor}`,
    `r${o.borderRadius}`,
    `o${o.opacity}`,
    `rot${o.rotation}`,
    `bg${o.background || 'none'}`,
  ].join('_') + `.${o.format}`
}

const hasEffects = (o: PreviewOptions) =>
  o.opacity < 1 || o.background !== '' || o.borderWidth > 0 || o.borderRadius > 0 || o.rotation !== 0

interface Raw {
  data: Buffer
  info: { width: number; height: number; channels: number }
}

/** Run the transformations with sharp and return the encoded image. */
export async function renderPreview(sharp: any, source: string | Uint8Array, o: PreviewOptions): Promise<Buffer> {
  const effects = hasEffects(o)
  // Animated GIFs keep their frames only for plain resizes.
  let pipeline = sharp(source, { animated: o.format === 'gif' && !effects, limitInputPixels: MAX_INPUT_PIXELS }).rotate()
  if (o.width || o.height) {
    pipeline = pipeline.resize({
      width: o.width || undefined,
      height: o.height || undefined,
      fit: o.width && o.height ? 'cover' : 'inside',
      position: GRAVITY[o.gravity],
      withoutEnlargement: true,
    })
  }

  if (effects) {
    // Each step works on raw pixels so it sees the size the previous step produced.
    let cur: Raw = await pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const step = async (fn: (img: any, w: number, h: number) => any) => {
      const { width, height, channels } = cur.info
      cur = await fn(sharp(cur.data, { raw: { width, height, channels } }), width, height).raw().toBuffer({ resolveWithObject: true })
    }
    if (o.opacity < 1) {
      const alpha = Buffer.from([255, 255, 255, Math.round(o.opacity * 255)])
      await step((img) => img.ensureAlpha().composite([{ input: alpha, raw: { width: 1, height: 1, channels: 4 }, tile: true, blend: 'dest-in' }]))
    }
    if (o.background) await step((img) => img.flatten({ background: rgba(o.background) }))
    if (o.borderWidth > 0) {
      const b = o.borderWidth
      await step((img) => img.extend({ top: b, bottom: b, left: b, right: b, background: rgba(o.borderColor) }))
    }
    if (o.borderRadius > 0) {
      await step((img, w, h) => {
        const r = Math.min(o.borderRadius, Math.floor(Math.min(w, h) / 2))
        const mask = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="${r}" ry="${r}"/></svg>`)
        return img.ensureAlpha().composite([{ input: mask, blend: 'dest-in' }])
      })
    }
    if (o.rotation !== 0) {
      const background = o.background ? rgba(o.background) : { r: 0, g: 0, b: 0, alpha: 0 }
      await step((img) => img.rotate(o.rotation, { background }))
    }
    const { width, height, channels } = cur.info
    pipeline = sharp(cur.data, { raw: { width, height, channels } })
  }

  const quality = o.quality >= 0 ? { quality: Math.max(1, o.quality) } : {}
  switch (o.format) {
    case 'jpg':
      // JPEG has no alpha: transparent areas become white unless a background was given.
      return pipeline.flatten({ background: '#ffffff' }).jpeg(quality).toBuffer()
    case 'png':
      return pipeline.png().toBuffer()
    case 'webp':
      return pipeline.webp(quality).toBuffer()
    case 'avif':
      return pipeline.avif(quality).toBuffer()
    case 'gif':
      return pipeline.gif().toBuffer()
  }
}
