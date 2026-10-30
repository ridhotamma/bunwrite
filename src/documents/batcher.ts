/**
 * Coalesces document writes that arrive together into one SQLite transaction.
 *
 * Under load, N single-document requests used to mean N `BEGIN IMMEDIATE`
 * commits. They queue on the same write lock anyway, so grouping the writes
 * that are already waiting costs nothing and saves a commit per request.
 *
 * A write joins the next batch if it arrives while the window is open. The
 * window is short (a few milliseconds) and the batch is capped, so latency
 * stays bounded even when the writer is saturated. Each operation keeps its
 * own savepoint, permissions and events; one failure never rolls back the
 * other requests in the batch.
 */
import type { BatchOutcome, DocEvent, DocumentStore } from './store'

/** A committed write: its result plus the realtime/webhook events it produced. */
export interface WriteResult<T> {
  value: T
  events: DocEvent[]
}

interface Pending {
  run: (events: DocEvent[]) => unknown
  events: DocEvent[]
  resolve: (result: WriteResult<unknown>) => void
  reject: (error: unknown) => void
}

/** Bounds both latency and memory when requests arrive faster than the writer. */
const MAX_BATCH = 256

export class WriteBatcher {
  private queue: Pending[] = []
  private timer: ReturnType<typeof setTimeout> | null = null

  /** Committed transactions and writes; exposed for logs and tests. */
  batches = 0
  writes = 0

  constructor(
    private readonly store: DocumentStore,
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
  submit<T>(run: (events: DocEvent[]) => T): Promise<WriteResult<T>> {
    if (!this.enabled) {
      const events: DocEvent[] = []
      try {
        const outcome = this.store.runBatch([() => run(events)])[0]
        if (!outcome) return Promise.reject(new Error('Write batch produced no result'))
        if (!outcome.ok) return Promise.reject(outcome.error)
        this.batches++
        this.writes++
        return Promise.resolve({ value: outcome.value as T, events })
      } catch (error) {
        return Promise.reject(error)
      }
    }

    return new Promise<WriteResult<T>>((resolve, reject) => {
      this.queue.push({
        run,
        events: [],
        resolve: resolve as (result: WriteResult<unknown>) => void,
        reject,
      })
      // A full batch flushes at once; waiting only adds latency.
      if (this.queue.length >= this.maxBatch) this.flush()
      else this.schedule()
    })
  }

  /** Commit everything waiting now, for example before a graceful shutdown. */
  drain(): void {
    this.flush()
  }

  private schedule(): void {
    if (this.timer || this.queue.length === 0) return
    this.timer = setTimeout(() => this.flush(), this.windowMs)
  }

  private flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.queue.length === 0) return
    const batch = this.queue.splice(0, this.maxBatch)
    this.batches++
    this.writes += batch.length

    let outcomes: Array<BatchOutcome<unknown>>
    try {
      outcomes = this.store.runBatch(batch.map((pending) => () => pending.run(pending.events)))
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
