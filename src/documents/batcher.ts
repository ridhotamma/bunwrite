/**
 * Coalesces document writes that arrive together into one transaction.
 *
 * Under load, N single-document requests used to mean N `BEGIN IMMEDIATE`
 * commits. They queue on the same write lock anyway, so grouping the writes
 * that are already waiting costs nothing and saves a commit per request.
 *
 * When nothing is committing, the queue flushes on the next event-loop turn,
 * which still groups every write that arrived in the same I/O pass but never
 * makes a lone write wait. While a batch is committing, new writes wait up to
 * the window and go in the next batch. The batch is capped, so latency stays
 * bounded even when the writer is saturated. Each operation keeps its
 * own savepoint, permissions and events; one failure never rolls back the
 * other requests in the batch.
 */
import { err } from '~/lib/errors'
import type { BatchOutcome, DocEvent, DocumentBackend } from './store'

/** A committed write: its result plus the realtime/webhook events it produced. */
export interface WriteResult<T> {
  value: T
  events: DocEvent[]
}

interface Pending {
  run: (events: DocEvent[]) => Promise<unknown> | unknown
  events: DocEvent[]
  resolve: (result: WriteResult<unknown>) => void
  reject: (error: unknown) => void
}

/** Bounds both latency and memory when requests arrive faster than the writer. */
const MAX_BATCH = 256
/** A hard ceiling on queued writes; beyond it the caller gets backpressure. */
const MAX_QUEUED = 10_000

export class WriteBatcher {
  private queue: Pending[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private immediate: ReturnType<typeof setImmediate> | null = null
  /** Serialises flushes so two timers cannot commit overlapping batches. */
  private flushing: Promise<void> | null = null

  /** Committed transactions and writes; exposed for logs and tests. */
  batches = 0
  writes = 0

  constructor(
    private readonly store: DocumentBackend,
    /** Milliseconds to collect writes; 0 disables batching and writes immediately. */
    private readonly windowMs: number,
    private readonly maxBatch = MAX_BATCH,
  ) {}

  get enabled(): boolean {
    return this.windowMs > 0
  }

  /** Writes waiting for the next flush. */
  get pending(): number {
    return this.queue.length
  }

  /**
   * Queue `run` and resolve with its value and events. `run` must use the
   * store's `...InTx` methods, because it executes inside the shared
   * transaction.
   */
  submit<T>(run: (events: DocEvent[]) => Promise<T> | T): Promise<WriteResult<T>> {
    if (!this.enabled) {
      const events: DocEvent[] = []
      return this.store.runBatch([() => run(events)]).then((outcomes) => {
        const outcome = outcomes[0]
        if (!outcome) throw new Error('Write batch produced no result')
        if (!outcome.ok) throw outcome.error
        this.batches++
        this.writes++
        return { value: outcome.value as T, events }
      })
    }

    if (this.queue.length >= MAX_QUEUED) {
      return Promise.reject(err('general_rate_limit_exceeded', 'The write queue is full. Try again shortly.'))
    }

    return new Promise<WriteResult<T>>((resolve, reject) => {
      this.queue.push({
        run,
        events: [],
        resolve: resolve as (result: WriteResult<unknown>) => void,
        reject,
      })
      // A full batch flushes at once; waiting only adds latency.
      if (this.queue.length >= this.maxBatch) void this.flush()
      else this.schedule()
    })
  }

  /** Commit everything waiting now, for example before a graceful shutdown. */
  async drain(): Promise<void> {
    await this.flush()
    // A flush started before the last submit may still be committing.
    while (this.flushing) await this.flushing
  }

  private schedule(): void {
    if (this.timer || this.immediate || this.queue.length === 0) return
    if (!this.flushing) {
      // Idle writer: a fixed window made a single write wait (updates at 10
      // clients halved); the next turn already collects concurrent arrivals.
      this.immediate = setImmediate(() => {
        this.immediate = null
        void this.flush()
      })
      return
    }
    this.timer = setTimeout(() => void this.flush(), this.windowMs)
  }

  private flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.immediate) {
      clearImmediate(this.immediate)
      this.immediate = null
    }
    if (this.queue.length === 0) return Promise.resolve()
    if (this.flushing) return this.flushing.then(() => this.flush())
    const batch = this.queue.splice(0, this.maxBatch)
    this.batches++
    this.writes += batch.length
    this.flushing = this.commit(batch).finally(() => {
      this.flushing = null
    })
    return this.flushing
  }

  private async commit(batch: Pending[]): Promise<void> {
    let outcomes: Array<BatchOutcome<unknown>>
    try {
      outcomes = await this.store.runBatch(batch.map((pending) => () => pending.run(pending.events)))
    } catch (error) {
      for (const pending of batch) pending.reject(error)
      this.schedule()
      return
    }

    batch.forEach((pending, index) => {
      const outcome = outcomes[index]
      if (!outcome) {
        pending.reject(new Error('Write batch produced no result'))
        return
      }
      if (outcome.ok) pending.resolve({ value: outcome.value, events: pending.events })
      else pending.reject(outcome.error)
    })
    this.schedule()
  }
}
