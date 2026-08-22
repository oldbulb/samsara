// Single-consumer async queue backing `LoopRun.events`.

export class EventQueue<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = []
  private waiter: (() => void) | undefined
  private closed = false

  push(item: T): void {
    if (this.closed) return
    this.buffer.push(item)
    this.waiter?.()
  }

  close(): void {
    this.closed = true
    this.waiter?.()
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      if (this.buffer.length) {
        yield this.buffer.shift()!
        continue
      }
      if (this.closed) return
      await new Promise<void>((resolve) => {
        this.waiter = () => {
          this.waiter = undefined
          resolve()
        }
      })
    }
  }
}
