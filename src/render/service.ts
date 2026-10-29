/**
 * HTML to PDF or image with headless Chromium, driven by Bun.WebView over the
 * DevTools protocol (Page.printToPDF, Page.captureScreenshot). No Puppeteer
 * or Playwright.
 *
 * Built for small hosts: one render at a time across every project (others
 * wait in line), Chromium starts on the first request and is shut down after
 * a minute idle, and remote URLs are blocked unless allowed in settings.
 *
 * A render sent with `async: true` is a durable job in the built-in queue
 * (`_render`): the caller gets a job at once, a worker in this process renders
 * it when the line is free and saves it to a bucket. Jobs survive a restart
 * and are retried when Chromium fails.
 */
import { existsSync } from 'node:fs'

import { keyCaller } from '~/auth/caller'
import type { Config } from '~/config'
import { BunwriteError, err } from '~/lib/errors'
import { resolveId } from '~/lib/ids'
import type { QueueMessageRow, QueueService } from '~/queue/service'
import type { StorageService } from '~/storage/service'
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
  /** Device pixel ratio, 0.1–3. 2 gives sharp text on high-DPI screens; below 1 makes a smaller bitmap of the same layout. @default 1 */
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
/** The system queue that holds async render jobs. */
export const RENDER_QUEUE = '_render'
/** A job's lease; heartbeated while it waits in line and renders. */
const JOB_LEASE_S = 120
const JOB_ATTEMPTS = 3
/** How often each project looks for due jobs (retries, jobs left by a restart). */
const JOB_POLL_MS = 5_000
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

/** Where an async render is saved. */
export interface RenderTarget {
  bucketId: string
  fileId?: unknown
  fileName: string
  permissions?: unknown
}

interface RenderJobData {
  type: 'pdf' | 'image'
  /** Dropped once the job is finished, so old jobs do not keep 5 MB of HTML. */
  html?: string
  options: PdfOptions | ImageOptions
  bucketId: string
  fileId: string
  fileName: string
  permissions: unknown
}

export function renderJobModel(m: QueueMessageRow) {
  let data: Partial<RenderJobData> = {}
  try {
    data = JSON.parse(m.data) as RenderJobData
  } catch {
    // Not a render job's payload; report what the row has.
  }
  return {
    $id: m.id,
    $createdAt: m.created_at,
    $updatedAt: m.updated_at,
    type: data.type ?? '',
    status: m.status,
    attempts: m.attempts,
    maxAttempts: m.max_attempts,
    bucketId: data.bucketId ?? '',
    fileId: data.fileId ?? '',
    fileName: data.fileName ?? '',
    completedAt: m.completed_at,
    errors: m.errors,
  }
}

/**
 * Chromium is one browser for the whole process (Bun.WebView.closeAll closes
 * every tab), so the line is shared by every project, not one per project.
 */
const shared = {
  line: Promise.resolve() as Promise<unknown>,
  waiting: 0,
  idle: null as ReturnType<typeof setTimeout> | null,
  running: false,
}

function closeChrome(): void {
  if (shared.idle) clearTimeout(shared.idle)
  shared.idle = null
  if (shared.running) Bun.WebView.closeAll()
  shared.running = false
}

export class RenderService {
  private timer: ReturnType<typeof setInterval> | null = null
  private draining = false

  constructor(
    private config: Config,
    /** The queue and storage for async jobs; without them `async: true` is refused. */
    private jobs?: { queue: QueueService; storage: StorageService },
  ) {}

  status(): { enabled: boolean; chrome: string | null; running: boolean } {
    return { enabled: this.config.render.enabled, chrome: findChrome(), running: shared.running }
  }

  /** Render HTML to PDF bytes. */
  pdf(html: string, o: PdfOptions = {}, fromJob = false): Promise<Uint8Array> {
    return this.inLine(html, { width: 794, height: 1123, scale: 1, transparent: false }, fromJob, async (view) => {
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
  async image(html: string, o: ImageOptions = {}, fromJob = false): Promise<{ bytes: Uint8Array; mime: string }> {
    const output = o.output ?? 'png'
    const width = o.width ?? 1200
    const height = o.height ?? 800
    const scale = o.scale ?? 1
    const transparent = Boolean(o.transparent) && output !== 'jpg'
    const maxPixels = maxImagePixels()
    if (width * height * scale * scale > maxPixels) throw tooLarge(maxPixels)
    const bytes = await this.inLine(html, { width, height, scale, transparent }, fromJob, async (view) => {
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

  /**
   * Queue a render. Everything that can be checked now is checked now, so a
   * bad request fails here with 4xx instead of later as a failed job.
   */
  enqueue(type: 'pdf' | 'image', html: string, options: PdfOptions | ImageOptions, target: RenderTarget): QueueMessageRow {
    if (!this.jobs) throw err('general_service_disabled', 'Async rendering is not available on this server.')
    this.check(html)
    if (type === 'image') {
      const o = options as ImageOptions
      const maxPixels = maxImagePixels()
      if ((o.width ?? 1200) * (o.height ?? 800) * (o.scale ?? 1) ** 2 > maxPixels) throw tooLarge(maxPixels)
    }
    const caller = keyCaller()
    this.jobs.storage.bucket(target.bucketId, true)
    // Fixed now, so the caller knows the file ID and a retry writes the same file.
    const fileId = resolveId(target.fileId, 'File ID')
    let exists = false
    try {
      this.jobs.storage.file(caller, target.bucketId, fileId)
      exists = true
    } catch {
      // Not there yet: good.
    }
    if (exists) throw err('storage_file_already_exists')
    const data: RenderJobData = { type, html, options, bucketId: target.bucketId, fileId, fileName: target.fileName, permissions: target.permissions ?? null }
    const { message } = this.jobs.queue.enqueue(RENDER_QUEUE, { data, maxAttempts: JOB_ATTEMPTS })
    queueMicrotask(() => this.drain())
    return message
  }

  /** One async render job. */
  job(id: string): QueueMessageRow {
    if (!this.jobs) throw err('queue_message_not_found', 'Render job with the requested ID could not be found.')
    try {
      return this.jobs.queue.getMessage(RENDER_QUEUE, id)
    } catch {
      throw err('queue_message_not_found', 'Render job with the requested ID could not be found.')
    }
  }

  /** Look for due jobs regularly: retries after backoff, and jobs left by a restart. */
  start(): void {
    if (this.timer || !this.jobs) return
    this.drain()
    this.timer = setInterval(() => this.drain(), JOB_POLL_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /**
   * Run waiting jobs, one at a time per project. Each job joins the same line
   * as direct requests, so queued work never adds a second Chromium tab.
   */
  drain(): void {
    if (this.draining || !this.jobs || !this.config.render.enabled) return
    this.draining = true
    void (async () => {
      try {
        while (this.config.render.enabled) {
          const [message] = this.jobs!.queue.claim(RENDER_QUEUE, { count: 1, lease: JOB_LEASE_S })
          if (!message) break
          await this.runJob(message)
        }
      } catch (error) {
        console.error('[render] job worker failed', error)
      } finally {
        this.draining = false
      }
    })()
  }

  private async runJob(message: QueueMessageRow): Promise<void> {
    const { queue, storage } = this.jobs!
    // Waiting in line counts against the lease too, so keep it alive.
    const beat = setInterval(() => {
      try {
        queue.heartbeat(RENDER_QUEUE, message.id, JOB_LEASE_S)
      } catch {
        // Already finished or reaped; the result write below reports it.
      }
    }, (JOB_LEASE_S * 1000) / 4)
    beat.unref?.()
    let data: RenderJobData | null = null
    try {
      data = JSON.parse(message.data) as RenderJobData
      if (typeof data.html !== 'string') throw err('general_argument_invalid', 'The job has no HTML.')
      const { bytes, mime } =
        data.type === 'pdf'
          ? { bytes: await this.pdf(data.html, data.options as PdfOptions, true), mime: 'application/pdf' }
          : await this.image(data.html, data.options as ImageOptions, true)
      try {
        await storage.createFile(keyCaller(), data.bucketId, {
          fileId: data.fileId,
          file: new File([bytes], data.fileName, { type: mime }),
          permissions: data.permissions ?? null,
          contentRange: null,
          uploadId: null,
        })
      } catch (error) {
        // An earlier attempt saved it, then stopped before acking.
        const savedBefore = error instanceof BunwriteError && error.type === 'storage_file_already_exists' && message.attempts > 1
        if (!savedBefore) throw error
      }
      queue.ack(RENDER_QUEUE, message.id, { bucketId: data.bucketId, fileId: data.fileId })
      this.dropHtml(message.id, data)
    } catch (error) {
      // A 4xx (bad selector, too large, bucket gone) fails the same way again.
      const final =
        error instanceof BunwriteError && error.code < 500 && error.type !== 'general_rate_limit_exceeded' && error.type !== 'general_service_disabled'
      const text = error instanceof Error ? error.message : String(error)
      try {
        const row = queue.fail(RENDER_QUEUE, message.id, text, undefined, final)
        if (row.status === 'failed' && data) this.dropHtml(message.id, data)
      } catch {
        // The lease was lost; whoever holds it now reports the outcome.
      }
      if (!final) console.warn(`[render] job ${message.id} failed: ${text}`)
    } finally {
      clearInterval(beat)
    }
  }

  private dropHtml(id: string, data: RenderJobData): void {
    const { html: _html, ...rest } = data
    this.jobs!.queue.replaceData(RENDER_QUEUE, id, rest)
  }

  /**
   * Stop Chromium now; the next render starts it again. Unless `force`, a
   * render in progress (any project's) is left to finish, and Chromium stops
   * after the usual idle minute instead.
   */
  shutdown(force = false): void {
    if (!force && shared.waiting > 0) return
    closeChrome()
  }

  private check(html: string): void {
    if (!this.config.render.enabled) throw err('general_service_disabled', 'HTML rendering is disabled. Turn it on in Console > Settings > HTML rendering.')
    if (typeof html !== 'string' || !html.trim()) throw err('general_argument_invalid', 'Param "html" is required.')
    if (Buffer.byteLength(html) > MAX_HTML_BYTES) throw err('general_argument_invalid', 'Param "html" must be 5 MB or smaller.')
    if (!findChrome()) throw err('general_service_disabled', 'HTML rendering needs Chromium. Install it or set CHROME_PATH.')
  }

  /**
   * Checks, then one render at a time with a timeout; Chromium stops after a
   * minute idle. Direct requests are refused once MAX_WAITING are in line;
   * queued jobs always get a place (at most one per project).
   */
  private async inLine<T>(html: string, setup: PageSetup, fromJob: boolean, work: (view: View) => Promise<T>): Promise<T> {
    this.check(html)
    if (!fromJob && shared.waiting >= MAX_WAITING) {
      throw err(
        'general_rate_limit_exceeded',
        this.jobs
          ? 'Too many renders are waiting. Try again shortly, or send async: true with a bucketId to queue it.'
          : 'Too many renders are waiting. Try again shortly.',
      )
    }

    shared.waiting++
    if (shared.idle) clearTimeout(shared.idle)
    shared.idle = null
    const attempt = (): Promise<T> => {
      const chrome = findChrome()
      if (!chrome) throw err('general_service_disabled', 'HTML rendering needs Chromium. Install it or set CHROME_PATH.')
      return this.withTimeout(this.withPage(chrome, html, setup, work))
    }
    const job = shared.line.then(async () => {
      try {
        return await attempt()
      } catch (error) {
        // Chromium can be briefly unlaunchable: it may be auto-updating, or the
        // browser from a killed render may not have exited yet. The same is true
        // of a slow first launch under load, which ends as a 500 timeout. One
        // fresh attempt recovers without turning a transient failure into a 500.
        const retryable = !(error instanceof BunwriteError) || (error.code >= 500 && error.type !== 'general_service_disabled')
        if (!retryable) throw error
        console.warn(`[render] Chromium failed, retrying once: ${error instanceof Error ? error.message : String(error)}`)
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS))
        return attempt()
      }
    })
    shared.line = job.catch(() => {})
    try {
      return await job
    } finally {
      shared.waiting--
      if (shared.waiting === 0) {
        if (shared.idle) clearTimeout(shared.idle)
        shared.idle = setTimeout(closeChrome, IDLE_SHUTDOWN_MS)
        shared.idle.unref?.()
      }
    }
  }

  private async withTimeout<T>(work: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // Kill Chromium so a stuck page cannot hold memory or block the line.
        closeChrome()
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
    shared.running = true
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
