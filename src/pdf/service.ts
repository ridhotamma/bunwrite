/**
 * HTML to PDF with headless Chromium, driven by Bun.WebView over the DevTools
 * protocol (Page.printToPDF). No Puppeteer or Playwright.
 *
 * Built for small hosts: one render at a time (others wait in line), Chromium
 * starts on the first request and is shut down after a minute idle, and remote
 * URLs are blocked unless allowed in settings.
 */
import { existsSync } from 'node:fs'

import type { Config } from '~/config'
import { err } from '~/lib/errors'

export interface PdfConfig {
  /** Accept POST /v1/pdf. Off by default. */
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

export const MAX_HTML_BYTES = 5 * 1024 * 1024
const RENDER_TIMEOUT_MS = 30_000
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

export class PdfService {
  private line: Promise<unknown> = Promise.resolve()
  private waiting = 0
  private idle: ReturnType<typeof setTimeout> | null = null
  private running = false

  constructor(private config: Config) {}

  status(): { enabled: boolean; chrome: string | null; running: boolean } {
    return { enabled: this.config.pdf.enabled, chrome: findChrome(), running: this.running }
  }

  /** Render HTML to PDF bytes. Throws when disabled, when Chromium is missing, or after 30 s. */
  async render(html: string, options: PdfOptions = {}): Promise<Uint8Array> {
    if (!this.config.pdf.enabled) throw err('general_service_disabled', 'PDF rendering is disabled. Turn it on in Console > Settings > PDF.')
    if (typeof html !== 'string' || !html.trim()) throw err('general_argument_invalid', 'Param "html" is required.')
    if (Buffer.byteLength(html) > MAX_HTML_BYTES) throw err('general_argument_invalid', 'Param "html" must be 5 MB or smaller.')
    const chrome = findChrome()
    if (!chrome) throw err('general_service_disabled', 'PDF rendering needs Chromium. Install it or set CHROME_PATH.')
    if (this.waiting >= MAX_WAITING) throw err('general_rate_limit_exceeded', 'Too many PDFs are waiting to render. Try again shortly.')

    this.waiting++
    if (this.idle) clearTimeout(this.idle)
    const job = this.line.then(() => this.withTimeout(this.renderNow(chrome, html, options)))
    this.line = job.catch(() => {})
    try {
      return await job
    } finally {
      this.waiting--
      if (this.waiting === 0) this.idle = setTimeout(() => this.shutdown(), IDLE_SHUTDOWN_MS)
    }
  }

  /** Stop Chromium now. The next render starts it again. */
  shutdown(): void {
    if (this.idle) clearTimeout(this.idle)
    this.idle = null
    if (this.running) Bun.WebView.closeAll()
    this.running = false
  }

  private async withTimeout<T>(work: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // Kill Chromium so a stuck page cannot hold memory or block the line.
        this.shutdown()
        reject(err('general_server_error', `The PDF did not render within ${RENDER_TIMEOUT_MS / 1000} seconds.`))
      }, RENDER_TIMEOUT_MS)
    })
    try {
      return await Promise.race([work, timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  private async renderNow(chrome: string, html: string, o: PdfOptions): Promise<Uint8Array> {
    this.running = true
    const view = new Bun.WebView({ width: 794, height: 1123, backend: { type: 'chrome', url: false, path: chrome, argv: chromeArgs() } })
    try {
      await view.navigate('about:blank')
      if (!this.config.pdf.allowRemote) {
        await view.cdp('Network.enable')
        await view.cdp('Network.setBlockedURLs', { urls: BLOCKED_URLS })
      }
      const { frameTree } = (await view.cdp('Page.getFrameTree')) as { frameTree: { frame: { id: string } } }
      await view.cdp('Page.setDocumentContent', { frameId: frameTree.frame.id, html })
      // Wait for images, then web fonts, before printing.
      await view.evaluate(`new Promise((resolve) => document.readyState === 'complete' ? resolve(true) : addEventListener('load', () => resolve(true), { once: true }))`)
      await view.evaluate('document.fonts.ready.then(() => true)')

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
    } finally {
      view.close()
    }
  }
}
