/** A bounded top-K selection so a search never keeps every scored row in memory. */
export interface Scored<T> {
  item: T
  score: number
}

export class TopK<T> {
  private heap: Scored<T>[] = []

  constructor(private limit: number) {
    this.limit = Math.max(1, Math.round(limit))
  }

  /** Insert when the item belongs in the best `limit`; otherwise drop it. */
  push(item: T, score: number): void {
    if (!Number.isFinite(score)) return
    const entry = { item, score }
    if (this.heap.length < this.limit) {
      this.heap.push(entry)
      this.up(this.heap.length - 1)
      return
    }
    if (score <= this.heap[0]!.score) return
    this.heap[0] = entry
    this.down(0)
  }

  /** Best first. */
  values(): Scored<T>[] {
    return [...this.heap].sort((a, b) => b.score - a.score)
  }

  private up(index: number): void {
    while (index > 0) {
      const parent = (index - 1) >> 1
      if (this.heap[parent]!.score <= this.heap[index]!.score) break
      this.swap(parent, index)
      index = parent
    }
  }

  private down(index: number): void {
    for (;;) {
      const left = index * 2 + 1
      const right = left + 1
      let smallest = index
      if (left < this.heap.length && this.heap[left]!.score < this.heap[smallest]!.score) smallest = left
      if (right < this.heap.length && this.heap[right]!.score < this.heap[smallest]!.score) smallest = right
      if (smallest === index) return
      this.swap(index, smallest)
      index = smallest
    }
  }

  private swap(a: number, b: number): void {
    const value = this.heap[a]!
    this.heap[a] = this.heap[b]!
    this.heap[b] = value
  }
}
