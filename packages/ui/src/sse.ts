// `/rounds/:id/events` — the live progress of one round as a
// `text/event-stream`: every lifecycle event that names the round, a
// heartbeat comment every `refreshMs`, closed when the client goes away. The
// round page is complete without it; its few lines of JS only move the
// sibling status and attempt counters between two refreshes.

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Lifecycle, LifecycleEvent } from '@oldbulb/samsara-lifecycle'

/** The slice of `ctx.lifecycle` the stream subscribes to. */
export type SseLifecycle = Pick<Lifecycle, 'on'>

export interface SseOptions {
  roundId: string
  /** Heartbeat period. */
  refreshMs: number
}

/** The lifecycle service when it is mounted and can be subscribed to; `UiLifecycle` alone does not promise `on`. */
export function sseLifecycleOf(lifecycle: unknown): SseLifecycle | undefined {
  return lifecycle && typeof (lifecycle as SseLifecycle).on === 'function' ? (lifecycle as SseLifecycle) : undefined
}

/** The round an event belongs to; absent for events that name none (a noise floor, a consent). */
export function roundOf(event: LifecycleEvent): string | undefined {
  return 'roundId' in event ? event.roundId : undefined
}

/** What goes on the wire: the event minus what the loop must never see — a judged compare's per-task deltas (S7). */
export function wireEvent(event: LifecycleEvent): object {
  if (event.kind === 'campaign' && event.event.kind === 'judged') {
    const { per_task: _tasks, ...compare } = event.event.compare
    return { ...event, event: { ...event.event, compare } }
  }
  return event
}

/** One SSE frame: the event kind as the event name, the wire event as JSON data. */
export function formatEvent(event: LifecycleEvent): string {
  return `event: ${event.kind}\ndata: ${JSON.stringify(wireEvent(event))}\n\n`
}

export function streamRoundEvents(lifecycle: SseLifecycle | undefined, req: IncomingMessage, res: ServerResponse, opts: SseOptions): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  res.write(`retry: ${String(opts.refreshMs)}\n\n`)
  if (!lifecycle) res.write(': no lifecycle service mounted; heartbeats only\n\n')
  const off = lifecycle?.on('lifecycle/event', (event) => {
    if (roundOf(event) === opts.roundId) res.write(formatEvent(event))
  })
  const timer = setInterval(() => { res.write(`: ${new Date().toISOString()}\n\n`) }, opts.refreshMs)
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    clearInterval(timer)
    off?.()
    if (!res.writableEnded) res.end()
  }
  req.on('close', close)
  res.on('close', close)
}
