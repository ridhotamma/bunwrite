/**
 * HTML to PDF or image with headless Chromium, driven by Bun.WebView over the
 * DevTools protocol (Page.printToPDF, Page.captureScreenshot). No Puppeteer
 * or Playwright.
 *
 * Built for small hosts: one render at a time (others wait in line), Chromium
 * starts on the first request and is shut down after a minute idle, and remote
 * URLs are blocked unless allowed in settings.
 */
import { existsSync } from 'node:fs'

import type { Config } from '~/config'
import { AppwriteError, err } from '~/lib/errors'
import { loadSharp } from '~/storage/sharp'
import { avifTooLarge, maxAvifPixels } from '~/storage/transform'

export interface RenderConfig {
  /** Accept POST /v1/pdf and /v1/image. Off by default. */
  enabled: boolean
  /** Let pages load http(s) images, fonts and stylesheets. Off keeps renders offline. */
  allowRemote: boolean
}

export const PAPER_SIZES = { A3: [297, 420], A4: [210, 297], A5: [148, 210], Letter: [215.9, 279.4], Legal: [215.9, 355.6], Tabloid: [279.4, 431.8] } as const
export type PaperSize = keyof typeof PAPER_SIZES

export interface PdfOptions {
  format?: PaperSize
  landscape?: boolean
  printBackground?: boolean
  /** Millimetres. CSS `@page` size and margin win over these. */
  margin?: { top?: number; right?: number; bottom?: number; left?: number }
  scale?: number
  /** e.g. "1-3, 5". */
  pageRanges?: string
  /** Chromium header/footer templates; may use <span class="pageNumber"></span> and <span class="totalPages"></span>. */
  headerTemplate?: string
  footerTemplate?: string
}

export const IMAGE_OUTPUTS = ['png', 'jpg', 'webp', 'avif', 'gif'] as const
export type ImageOutput = (typeof IMAGE_OUTPUTS)[number]

export interface ImageOptions {
  /** @default 'png' */
  output?: ImageOutput
  /** Viewport width in CSS pixels. @default 1200 */
  width?: number
  /** Viewport height in CSS pixels; the minimum height with fullPage. @default 800 */
  height?: number
  /** Capture the whole page, not just the viewport. @default true */
  fullPage?: boolean
  /** Capture only the first element matching this CSS selector. */
  selector?: string
  /** Device pixel ratio, 1–3. 2 gives sharp text on high-DPI screens. @default 1 */
  scale?: number
  /** 1–100 for jpg, webp and avif. */
  quality?: number
  /** No white page background (png, webp, avif, gif). */
  transparent?: boolean
}

export const IMAGE_MIME: Record<ImageOutput, string> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', avif: 'image/avif', gif: 'image/gif' }

export const MAX_HTML_BYTES = 5 * 1024 * 1024
/**
 * Output pixels per image (width × height × scale²). Measured peak in a 512 MB
 * container: about 190 MB plus 17 MB per megapixel (439 MB at 15 MP). The
 * auto-tuned default keeps a capture near 300 MB on 512 MB, leaving room for
 * image previews at the same time. RENDER_MAX_MEGAPIXELS overrides it.
 */
export function maxImagePixels(): number {
  const megapixels = Number(process.env.RENDER_MAX_MEGAPIXELS)
  return (Number.isFinite(megapixels) && megapixels > 0 ? megapixels : 8) * 1_000_000
}

/** Chromium cannot capture taller than this many device pixels. */
const MAX_CAPTURE_PX = 16_384
const RENDER_TIMEOUT_MS = 30_000
const RETRY_DELAY_MS = 300
const IDLE_SHUTDOWN_MS = 60_000
const MAX_WAITING = 20
const BLOCKED_URLS = ['http://*', 'https://*', 'ws://*', 'wss://*', 'file://*', 'ftp://*']

const CHROME_ARGS = [
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-default-apps',
  '--disable-sync',
  '--mute-audio',
  '--no-first-run',
  '--hide-scrollbars',
  '--renderer-process-limit=1',
  '--js-flags=--max-old-space-size=128',
  '--font-render-hinting=none',
]

/** The Chromium executable: CHROME_PATH, then PATH, then the usual macOS locations. */
export function findChrome(): string | null {
  const configured = process.env.CHROME_PATH || process.env.BUN_CHROME_PATH
  if (configured) return existsSync(configured) ? configured : null
  for (const name of ['chromium', 'chromium-browser', 'google-chrome-stable', 'google-chrome', 'chrome']) {
    const found = Bun.which(name)
    if (found) return found
  }
  for (const path of ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']) {
    if (existsSync(path)) return path
  }
  return null
}

function chromeArgs(): string[] {
  const args = [...CHROME_ARGS]
  // Containers usually lack the user namespaces Chromium's sandbox needs; root cannot use it at all.
  if (process.env.CHROME_NO_SANDBOX === 'true' || process.getuid?.() === 0) args.push('--no-sandbox')
  // Extra flags, space-separated (CHROME_ARGS).
  args.push(...(process.env.CHROME_ARGS ?? '').split(/\s+/).filter(Boolean))
  return args
}

const inches = (mm: number) => mm / 25.4

interface PageSetup {
  width: number
  height: number
  scale: number
  transparent: boolean
}

type View = InstanceType<typeof Bun.WebView>

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export class RenderService {
  private line: Promise<unknown> = Promise.resolve()
  private waiting = 0
  private idle: ReturnType<typeof setTimeout> | null = null
  private running = false

  constructor(private config: Config) {}

  status(): { enabled: boolean; chrome: string | null; running: boolean } {
    return { enabled: this.config.render.enabled, chrome: findChrome(), running: this.running }
  }

  /** Render HTML to PDF bytes. */
  pdf(html: string, o: PdfOptions = {}): Promise<Uint8Array> {
    return this.queue(html, { width: 794, height: 1123, scale: 1, transparent: false }, async (view) => {
      const [width, height] = PAPER_SIZES[o.format ?? 'A4']
      const margin = o.margin ?? {}
      const header = o.headerTemplate ?? ''
      const footer = o.footerTemplate ?? ''
      const { data } = (await view.cdp('Page.printToPDF', {
        landscape: o.landscape ?? false,
        printBackground: o.printBackground ?? true,
        scale: o.scale ?? 1,
        paperWidth: inches(width),
        paperHeight: inches(height),
        marginTop: inches(margin.top ?? 10),
        marginRight: inches(margin.right ?? 10),
        marginBottom: inches(margin.bottom ?? 10),
        marginLeft: inches(margin.left ?? 10),
        pageRanges: o.pageRanges ?? '',
        displayHeaderFooter: Boolean(header || footer),
        headerTemplate: header || '<span></span>',
        footerTemplate: footer || '<span></span>',
        preferCSSPageSize: true,
      })) as { data: string }
      return Buffer.from(data, 'base64')
    })
  }

  /** Render HTML to an image. Returns the bytes and their MIME type. */
  async image(html: string, o: ImageOptions = {}): Promise<{ bytes: Uint8Array; mime: string }> {
    const output = o.output ?? 'png'
    const width = o.width ?? 1200
    const height = o.height ?? 800
    const scale = o.scale ?? 1
    const transparent = Boolean(o.transparent) && output !== 'jpg'
    const maxPixels = maxImagePixels()
    if (width * height * scale * scale > maxPixels) throw tooLarge(maxPixels)
    const bytes = await this.queue(html, { width, height, scale, transparent }, async (view) => {
      let clip: Rect = { x: 0, y: 0, width, height }
      if (o.selector) {
        const found = await view.evaluate<Rect | null>(
          `(() => { const el = document.querySelector(${JSON.stringify(o.selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height } })()`,
        )
        if (!found || found.width < 1 || found.height < 1) throw err('general_argument_invalid', `No visible element matches selector "${o.selector}".`)
        clip = found
      } else if (o.fullPage ?? true) {
        const metrics = (await view.cdp('Page.getLayoutMetrics')) as { cssContentSize: { height: number } }
        clip.height = Math.max(height, Math.ceil(metrics.cssContentSize.height))
      }
      const pixels = clip.width * clip.height * scale * scale
      if (pixels > maxPixels || clip.height * scale > MAX_CAPTURE_PX) throw tooLarge(maxPixels)
      if (output === 'avif' && pixels > maxAvifPixels()) throw avifTooLarge()

      // Chromium encodes png, jpeg and webp itself; avif and gif go through sharp.
      const native = output === 'png' || output === 'jpg' || output === 'webp'
      const quality = o.quality !== undefined && output !== 'png' ? { quality: o.quality } : {}
      const { data } = (await view.cdp('Page.captureScreenshot', {
        format: native ? (output === 'jpg' ? 'jpeg' : output) : 'png',
        ...(native ? quality : {}),
        clip: { ...clip, scale: 1 },
        captureBeyondViewport: true,
        fromSurface: true,
      })) as { data: string }
      const png = Buffer.from(data, 'base64')
      if (native) return png
      const sharp = await loadSharp(this.config)
      return output === 'avif' ? sharp(png).avif(quality).toBuffer() : sharp(png).gif().toBuffer()
    })
    return { bytes, mime: IMAGE_MIME[output] }
  }

  /** Stop Chromium now. The next render starts it again. */
  shutdown(): void {
    if (this.idle) clearTimeout(this.idle)
    this.idle = null
    if (this.running) Bun.WebView.closeAll()
    this.running = false
  }

  /** Checks, then one render at a time with a timeout; Chromium stops after a minute idle. */
  private async queue<T>(html: string, setup: PageSetup, work: (view: View) => Promise<T>): Promise<T> {
    if (!this.config.render.enabled) throw err('general_service_disabled', 'HTML rendering is disabled. Turn it on in Console > Settings > HTML rendering.')
    if (typeof html !== 'string' || !html.trim()) throw err('general_argument_invalid', 'Param "html" is required.')
    if (Buffer.byteLength(html) > MAX_HTML_BYTES) throw err('general_argument_invalid', 'Param "html" must be 5 MB or smaller.')
    const chrome = findChrome()
    if (!chrome) throw err('general_service_disabled', 'HTML rendering needs Chromium. Install it or set CHROME_PATH.')
    if (this.waiting >= MAX_WAITING) throw err('general_rate_limit_exceeded', 'Too many renders are waiting. Try again shortly.')

    this.waiting++
    if (this.idle) clearTimeout(this.idle)
    const attempt = (): Promise<T> => {
      const chrome = findChrome()
      if (!chrome) throw err('general_service_disabled', 'HTML rendering needs Chromium. Install it or set CHROME_PATH.')
      return this.withTimeout(this.withPage(chrome, html, setup, work))
    }
    const job = this.line.then(async () => {
      try {
        return await attempt()
      } catch (error) {
        // Chromium can be briefly unlaunchable: it may be auto-updating, or the
        // browser from a killed render may not have exited yet. One fresh
        // attempt recovers without turning a transient failure into a 500.
        if (error instanceof AppwriteError) throw error
        console.warn(`[render] Chromium failed, retrying once: ${error instanceof Error ? error.message : String(error)}`)
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS))
        return attempt()
      }
    })
    this.line = job.catch(() => {})
    try {
      return await job
    } finally {
      this.waiting--
      if (this.waiting === 0) this.idle = setTimeout(() => this.shutdown(), IDLE_SHUTDOWN_MS)
    }
  }

  private async withTimeout<T>(work: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // Kill Chromium so a stuck page cannot hold memory or block the line.
        this.shutdown()
        reject(err('general_server_error', `The page did not render within ${RENDER_TIMEOUT_MS / 1000} seconds.`))
      }, RENDER_TIMEOUT_MS)
    })
    try {
      return await Promise.race([work, timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  /** Open a tab, load the HTML, wait for images and fonts, run `work`, close the tab. */
  private async withPage<T>(chrome: string, html: string, setup: PageSetup, work: (view: View) => Promise<T>): Promise<T> {
    this.running = true
    const view = new Bun.WebView({ width: setup.width, height: setup.height, backend: { type: 'chrome', url: false, path: chrome, argv: chromeArgs() } })
    try {
      await view.navigate('about:blank')
      if (!this.config.render.allowRemote) {
        await view.cdp('Network.enable')
        await view.cdp('Network.setBlockedURLs', { urls: BLOCKED_URLS })
      }
      await view.cdp('Emulation.setDeviceMetricsOverride', { width: setup.width, height: setup.height, deviceScaleFactor: setup.scale, mobile: false })
      // Same result on every host: light colour scheme, white page unless transparent was asked for.
      await view.cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
      await view.cdp('Emulation.setDefaultBackgroundColorOverride', { color: setup.transparent ? { r: 0, g: 0, b: 0, a: 0 } : { r: 255, g: 255, b: 255, a: 1 } })
      const { frameTree } = (await view.cdp('Page.getFrameTree')) as { frameTree: { frame: { id: string } } }
      await view.cdp('Page.setDocumentContent', { frameId: frameTree.frame.id, html })
      await view.evaluate(`new Promise((resolve) => document.readyState === 'complete' ? resolve(true) : addEventListener('load', () => resolve(true), { once: true }))`)
      await view.evaluate('document.fonts.ready.then(() => true)')
      return await work(view)
    } finally {
      view.close()
    }
  }
}

const tooLarge = (maxPixels: number) =>
  err('general_argument_invalid', `The image would be larger than ${maxPixels / 1_000_000} megapixels or ${MAX_CAPTURE_PX}px tall. Lower width, height or scale, or set fullPage to false.`)
