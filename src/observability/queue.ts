/**
 * Bounded, batched delivery. Exporters must never grow without limit or block
 * the request path, so a slow or down provider only costs dropped events.
 */
export interface BatchQueueOptions<T> {
  /** Most items kept while the provider is slow. */
  limit: number
  /** How often to drain automatically. 0 disables the timer (tests). */
  flushMs: number
  send: (batch: T[]) => Promise<void>
  onError?: (error: unknown, dropped: number) => void
  startTimer?: boolean
}

export class BatchQueue<T> {
  private items: T[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private sending: Promise<void> | null = null
  private stopped = false
  private dropped = 0
  private lastErrorAt = 0

  constructor(private readonly options: BatchQueueOptions<T>) {
    if (options.startTimer !== false && options.flushMs > 0) {
      this.timer = setInterval(() => void this.flush(), options.flushMs)
      this.timer.unref?.()
    }
  }

  add(item: T): void {
    if (this.stopped) return
    if (this.items.length >= this.options.limit) {
      this.items.shift()
      this.dropped++
    }
    this.items.push(item)
  }

  get size(): number {
    return this.items.length
  }

  get droppedCount(): number {
    return this.dropped
  }

  async flush(): Promise<void> {
    if (this.sending) return this.sending
    if (this.items.length === 0) return
    const batch = this.items
    this.items = []
    this.sending = this.options
      .send(batch)
      .catch((error) => {
        // Keep what fits, newest first, so an outage does not lose the tail.
        const room = Math.max(0, this.options.limit - this.items.length)
        if (room > 0) this.items = [...batch.slice(-room), ...this.items]
        this.dropped += Math.max(0, batch.length - room)
        const now = Date.now()
        if (this.options.onError && now - this.lastErrorAt > 60_000) {
          this.lastErrorAt = now
          this.options.onError(error, this.dropped)
        }
      })
      .finally(() => {
        this.sending = null
      })
    return this.sending
  }

  /** Stop accepting work and drain what is queued. */
  async close(): Promise<void> {
    this.stopped = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    // The first flush may have been in flight; the second sends the remainder.
    await this.flush()
    await this.flush()
  }
}
