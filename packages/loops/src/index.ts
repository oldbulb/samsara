// @oldbulb/samsara-loops — `ctx.loops`: the registry of loop providers.
//
// A provider plugin registers itself with `ctx.effect(() => ctx.loops.register(p))`,
// so the host's loop set equals its enabled plugins. `start` wraps the provider's
// run so the framework can rely on the seam contract regardless of the provider:
// events end with exactly one 'finished', and `result` never rejects after
// publication.

import { Context, Service } from '@oldbulb/samsara-kernel'
import type { AttemptSpec, FinishedEvent, LoopEvent, LoopProvider, LoopRun } from './types.ts'

export * from './types.ts'
export { NullLoopProvider, NULL_HARNESS_FACTS } from './null.ts'
export { toSpans, toResourceSpans, OTEL_SCOPE_NAME } from './otel.ts'
export type { AttemptMeta, OtlpSpan, OtlpAttribute, OtlpValue, OtlpResourceSpans } from './otel.ts'

declare module '@oldbulb/samsara-kernel' {
  interface Context {
    loops: LoopRegistry
  }
}

export class LoopRegistryError extends Error {
  constructor(message: string, readonly code: 'DUPLICATE_PROVIDER' | 'UNKNOWN_PROVIDER') {
    super(message)
    this.name = 'LoopRegistryError'
  }
}

export class LoopRegistry extends Service {
  private readonly providers = new Map<string, LoopProvider>()

  constructor(ctx: Context) {
    super(ctx, 'loops')
  }

  /** Register a provider; the returned disposer removes it. Throws on a duplicate name. */
  register(provider: LoopProvider): () => void {
    const name = provider.name
    return this.ctx.effect(() => {
      if (this.providers.has(name)) {
        throw new LoopRegistryError(`a loop provider named "${name}" is already registered`, 'DUPLICATE_PROVIDER')
      }
      this.providers.set(name, provider)
      return () => { this.providers.delete(name) }
    }, 'loops.register()')
  }

  get(name: string): LoopProvider | undefined {
    return this.providers.get(name)
  }

  list(): LoopProvider[] {
    return [...this.providers.values()]
  }

  /**
   * Start an attempt on the named provider. Rejects only if the provider
   * rejects before publication; afterwards every failure surfaces as a
   * synthesized `finished{status:'FAILED', stopReason:'error'}`.
   */
  async start(name: string, spec: AttemptSpec): Promise<LoopRun> {
    const provider = this.providers.get(name)
    if (!provider) throw new LoopRegistryError(`no loop provider named "${name}"`, 'UNKNOWN_PROVIDER')
    const inner = await provider.start(spec)
    return wrapRun(inner, spec.attemptId)
  }
}

// ---------------------------------------------------------------- run wrapping

function failedEvent(): FinishedEvent {
  return {
    t: 'finished',
    at: Date.now(),
    status: 'FAILED',
    stopReason: 'error',
    usage: { inputTokens: 0, outputTokens: 0 },
    cost: { source: 'unknown' },
    turns: 0,
    toolCalls: 0,
    artifacts: [],
  }
}

/** Single-consumer async queue: push now, iterate later; `close` ends iteration. */
class EventQueue implements AsyncIterable<LoopEvent> {
  private readonly buffer: LoopEvent[] = []
  private waiter: (() => void) | undefined
  private closed = false

  push(event: LoopEvent): void {
    this.buffer.push(event)
    this.wake()
  }

  close(): void {
    this.closed = true
    this.wake()
  }

  private wake(): void {
    const w = this.waiter
    this.waiter = undefined
    w?.()
  }

  async *[Symbol.asyncIterator](): AsyncIterator<LoopEvent> {
    for (;;) {
      const next = this.buffer.shift()
      if (next) { yield next; continue }
      if (this.closed) return
      await new Promise<void>(resolve => { this.waiter = resolve })
    }
  }
}

/**
 * Enforce the seam contract around a provider's run: forward its events
 * until the first 'finished' (drop anything after), and if the stream ends
 * or throws without one, synthesize FAILED/error. `result` settles from the
 * same stream so it agrees with `events` and never rejects.
 */
export function wrapRun(inner: LoopRun, id: string = inner.id): LoopRun {
  const queue = new EventQueue()
  let finished: FinishedEvent | undefined
  let resolveResult!: (e: FinishedEvent) => void
  const result = new Promise<FinishedEvent>(resolve => { resolveResult = resolve })

  const finish = (event: FinishedEvent) => {
    if (finished) return
    finished = event
    queue.push(event)
    queue.close()
    resolveResult(event)
  }

  void (async () => {
    try {
      for await (const event of inner.events) {
        if (finished) break
        if (event.t === 'finished') { finish(event); break }
        queue.push(event)
      }
    } catch {
      // fall through: a throwing stream is a provider error after publication
    }
    finish(failedEvent())
  })()
  // The provider's own result is not consulted; swallow it so a rejection is not unhandled.
  inner.result.catch(() => {})

  let disposed: Promise<void> | undefined
  return {
    id,
    events: queue,
    result,
    cancel(reason) {
      try { inner.cancel(reason) } catch { /* cancel is best-effort */ }
    },
    dispose() {
      disposed ??= inner.dispose().catch(() => {})
      return disposed
    },
  }
}

/** Drain a run's events into an array (ends after the single 'finished'). */
export async function collectEvents(run: LoopRun): Promise<LoopEvent[]> {
  const out: LoopEvent[] = []
  for await (const event of run.events) out.push(event)
  return out
}

// The loader mounts this module as the `loops` row: a Service class is a plugin.
export default LoopRegistry
