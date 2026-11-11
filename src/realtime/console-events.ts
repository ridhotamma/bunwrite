/**
 * Console change notifications, such as "this site's deployments changed".
 *
 * A build writes its status from whichever worker accepted it, while the
 * console tab watching it may be streaming from another worker. Each event is
 * delivered to this process's listeners at once and relayed over the realtime
 * bus to the others. Bursts are coalesced: a build that logs many lines a
 * second sends at most one event per topic every `THROTTLE_MS`, plus a final
 * one so the last change is never lost.
 */
const THROTTLE_MS = 250

export type ConsoleListener = (data: Record<string, unknown>) => void

export interface ConsoleRelay {
  /** Send an event to the other processes. */
  publish(topic: string, data: Record<string, unknown>): void
  /** This process's open listener count changed. */
  listeners(count: number): void
}

export class ConsoleEvents {
  private readonly topics = new Map<string, Set<ConsoleListener>>()
  /** Topics inside their throttle window, with the latest data still to send. */
  private readonly pending = new Map<string, { timer: ReturnType<typeof setTimeout>; data: Record<string, unknown> | null }>()
  private count = 0
  relay: ConsoleRelay | null = null

  /** Listen to one topic; returns the function that stops listening. */
  subscribe(topic: string, listener: ConsoleListener): () => void {
    let set = this.topics.get(topic)
    if (!set) this.topics.set(topic, (set = new Set()))
    set.add(listener)
    this.count++
    this.relay?.listeners(this.count)
    let done = false
    return () => {
      if (done) return
      done = true
      set.delete(listener)
      if (set.size === 0) this.topics.delete(topic)
      this.count--
      this.relay?.listeners(this.count)
    }
  }

  /** Something changed here: tell this process's listeners and the other processes. */
  emit(topic: string, data: Record<string, unknown> = {}): void {
    const pending = this.pending.get(topic)
    if (pending) {
      pending.data = data
      return
    }
    this.send(topic, data)
    const timer = setTimeout(() => {
      const last = this.pending.get(topic)
      this.pending.delete(topic)
      if (last?.data) this.emit(topic, last.data)
    }, THROTTLE_MS)
    timer.unref?.()
    this.pending.set(topic, { timer, data: null })
  }

  /** An event from another process: only this process's listeners hear it. */
  receive(topic: string, data: Record<string, unknown>): void {
    this.deliver(topic, data)
  }

  stop(): void {
    for (const { timer } of this.pending.values()) clearTimeout(timer)
    this.pending.clear()
  }

  private send(topic: string, data: Record<string, unknown>): void {
    this.deliver(topic, data)
    try {
      this.relay?.publish(topic, data)
    } catch (error) {
      console.error('[console-events] could not relay an event:', error)
    }
  }

  private deliver(topic: string, data: Record<string, unknown>): void {
    for (const listener of this.topics.get(topic) ?? []) {
      try {
        listener(data)
      } catch (error) {
        console.error('[console-events] a listener failed:', error)
      }
    }
  }
}
