// A push queue exposed as an AsyncIterable: the producer pushes LoopEvents as
// the session log grows, the consumer (the ledger tail) pulls them in order.
// `close()` ends iteration after the buffered items drain.

export class EventQueue<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = []
  private readonly waiters: Array<(r: IteratorResult<T>) => void> = []
  private closed = false

  push(item: T): void {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter) waiter({ value: item, done: false })
    else this.buffer.push(item)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.buffer.shift()
        if (item !== undefined) return Promise.resolve({ value: item, done: false })
        if (this.closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => this.waiters.push(resolve))
      },
    }
  }
}
