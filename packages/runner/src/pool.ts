// Tiny pure concurrency helpers for runSet: a counting semaphore, a bounded
// worker pool, and a serialized writer queue. No I/O, no dependencies.

export class Semaphore {
  private free: number
  private readonly waiters: (() => void)[] = []

  constructor(readonly size: number) {
    if (!Number.isInteger(size) || size < 1) throw new Error(`semaphore size must be a positive integer, got ${size}`)
    this.free = size
  }

  /** Resolves with the release function once a slot is free. Release is idempotent. */
  acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      const grant = () => {
        this.free--
        let released = false
        resolve(() => {
          if (released) return
          released = true
          this.free++
          this.waiters.shift()?.()
        })
      }
      if (this.free > 0) grant()
      else this.waiters.push(grant)
    })
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire()
    try {
      return await fn()
    } finally {
      release()
    }
  }
}

/**
 * Run `worker` over `items` with at most `size` in flight, in list order.
 * `shouldStop` is consulted before each start; items after a stop are skipped.
 * Workers must not throw (a throw rejects the pool after the others finish).
 */
export async function runPool<T>(
  items: readonly T[],
  size: number,
  worker: (item: T, index: number) => Promise<void>,
  shouldStop: () => boolean = () => false,
): Promise<void> {
  let next = 0
  const lanes = Array.from({ length: Math.max(1, Math.min(size, items.length)) }, async () => {
    while (next < items.length && !shouldStop()) {
      const i = next++
      await worker(items[i] as T, i)
    }
  })
  const settled = await Promise.allSettled(lanes)
  const failed = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected')
  if (failed) throw failed.reason
}

/** Runs enqueued jobs strictly one after another, in enqueue order; a failing job does not block the next. */
export class WriterQueue {
  private tail: Promise<void> = Promise.resolve()

  enqueue(job: () => Promise<void> | void): Promise<void> {
    const run = this.tail.then(job)
    this.tail = run.catch(() => {})
    return run
  }

  /** Resolves once every job enqueued so far has settled. */
  drain(): Promise<void> {
    return this.tail
  }
}
