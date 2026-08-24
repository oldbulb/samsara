import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { AttemptSpec, FinishedEvent, LoopEvent, LoopProvider, LoopRun, HarnessFacts } from '@oldbulb/samsara-loops'
import { challengerId, attemptRowSchema, scoreRowSchema, type AttemptRow as LedgerAttemptRow, type ScoreRow } from '@oldbulb/samsara-ledger'
import { runSet, type Loops, type LedgerSink } from '../src/run.ts'
import { formatSummary } from '../src/summary.ts'
import { Semaphore, WriterQueue, runPool } from '../src/pool.ts'

const PAR = resolve(import.meta.dirname, 'fixtures', 'parpack')

const FACTS: HarnessFacts = {
  systemPromptMode: 'none', skillDelivery: 'agents-skills-dir', schemaEnforcement: 'permissive-tool',
  permission: 'none', reasoning: {}, version: { loop: 'fake' },
}

function finished(over: Partial<FinishedEvent> = {}): FinishedEvent {
  return {
    t: 'finished', at: 1, status: 'COMPLETED', stopReason: 'completed',
    usage: { inputTokens: 10, outputTokens: 5 }, cost: { usd: 0.02, source: 'self-reported' },
    turns: 2, toolCalls: 3, artifacts: [], ...over,
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * A loop whose attempts take a random 5–50 ms, honour cancel() with an ABORTED
 * finish, write a valid submit, and reject before publication for `failTask`.
 */
function fakeLoops(opts: { failTask?: string } = {}): Loops & { state: { inFlight: Set<string>; peak: number; disposed: number; order: string[] } } {
  const state = { inFlight: new Set<string>(), peak: 0, disposed: 0, order: [] as string[] }
  const provider: LoopProvider = {
    name: 'fake', harnessFacts: FACTS,
    capabilities: { perAttemptBaseUrl: false, perAttemptEnv: false, nativeSchema: 'none', toolFilter: false, nativeMaxTurns: false },
    async start(spec: AttemptSpec) {
      if (spec.attemptId.includes(`-${opts.failTask}-`)) throw new Error('injected failure')
      state.inFlight.add(spec.attemptId)
      state.peak = Math.max(state.peak, state.inFlight.size)
      let settle!: (f: FinishedEvent) => void
      const result = new Promise<FinishedEvent>((r) => { settle = r })
      let done = false
      const finish = (f: FinishedEvent) => {
        if (done) return
        done = true
        state.inFlight.delete(spec.attemptId)
        state.order.push(spec.attemptId)
        settle(f)
      }
      const timer = setTimeout(() => {
        writeFileSync(resolve(spec.workdir, `${spec.tools.submitTool.name}.json`), JSON.stringify({ summary: 'ok' }))
        finish(finished())
      }, 5 + Math.random() * 45)
      const run: LoopRun = {
        id: spec.attemptId,
        events: (async function* (): AsyncGenerator<LoopEvent> {
          yield { t: 'started', at: 0, native: { kind: 'fake', id: spec.attemptId } }
          yield await result
        })(),
        result,
        cancel() { clearTimeout(timer); finish(finished({ status: 'ABORTED', stopReason: 'aborted' })) },
        async dispose() { state.disposed++ },
      }
      return run
    },
  }
  return {
    state,
    get: (n: string) => (n === 'fake' ? provider : undefined),
    start: (_n: string, spec: AttemptSpec) => provider.start(spec),
  }
}

const ROUTE = { provider: 'p', model: 'm', credentialRef: 'cred' }

function req(out: string, over: Partial<Parameters<typeof runSet>[0]> = {}) {
  return { pack: PAR, loop: 'fake', set: 'holdin' as const, repeat: 1, out, maxTurns: 5, maxMinutes: 1, parallel: 8, ...over }
}

function fakeLedger() {
  const calls: string[] = []
  const scores: ScoreRow[] = []
  let busy = false
  const ledger: LedgerSink = {
    async propose(p) { return challengerId(p) },
    async recordAttempt(r) {
      if (busy) throw new Error('ledger writes interleaved')
      busy = true
      await sleep(1)
      busy = false
      calls.push(attemptRowSchema.parse(r).id)
      return r.id
    },
    async appendScores(rows) { for (const r of rows) scores.push(scoreRowSchema.parse(r)); return rows.map((r) => r.metric) },
  }
  return { ledger, calls, scores }
}

describe('runSet --parallel', () => {
  it('runs 40 attempts 8 at a time: every row lands, in task order, one injected failure does not abort, ledger serialized', async () => {
    const out = mkdtempSync(resolve(tmpdir(), 'runner-par-'))
    const loops = fakeLoops({ failTask: 't07' })
    const { ledger, calls, scores } = fakeLedger()
    const lines: string[] = []
    const res = await runSet(req(out), { loops, route: ROUTE, runId: 'P', ledger, log: (l) => lines.push(l) })

    expect(res.rows).toHaveLength(40)
    expect(loops.state.peak).toBeGreaterThan(1)
    expect(loops.state.peak).toBeLessThanOrEqual(8)
    expect(loops.state.disposed).toBe(39)
    // result rows are in task × sample order regardless of completion order
    const ids = res.rows.map((r) => r.task_id)
    expect(ids).toEqual([...ids].sort())
    expect(loops.state.order).not.toEqual(res.rows.filter((r) => r.task_id !== 't07').map((r) => r.attemptId))
    // the injected failure is one FAILED row among 39 COMPLETED
    const failed = res.rows.filter((r) => r.status === 'FAILED')
    expect(failed.map((r) => r.task_id)).toEqual(['t07'])
    expect(failed[0]!.error).toMatch(/^loop: injected failure/)
    expect(res.rows.filter((r) => r.status === 'COMPLETED' && r.output.valid && r.truth.status === 'settled')).toHaveLength(39)
    // attempts.jsonl: 40 well-formed lines, one per attempt, no partial lines
    const jsonl = readFileSync(resolve(out, 'attempts.jsonl'), 'utf8')
    expect(jsonl.endsWith('\n')).toBe(true)
    const parsed = jsonl.trim().split('\n').map((l) => JSON.parse(l))
    expect(parsed).toHaveLength(40)
    expect(new Set(parsed.map((p) => p.attemptId)).size).toBe(40)
    // the jsonl is in completion order and the ledger saw the same order, 40 times, never overlapping
    expect(calls).toHaveLength(40)
    expect(calls).toEqual(parsed.map((p) => p.attemptId))
    expect(scores).toHaveLength(40 * 2) // truth and score still run for the FAILED row
    // summary table sorted by task
    const table = formatSummary(res).split('\n').filter((l) => /^t\d\d /.test(l)).map((l) => l.split(' ')[0])
    expect(table).toEqual([...table].sort())
    expect(table).toHaveLength(40)
    // one progress line per completion with a running counter
    const progress = lines.filter((l) => /\[\d+\/40 done/.test(l))
    expect(progress).toHaveLength(40)
    expect(progress.at(-1)).toMatch(/\[40\/40 done, 0 running, 1 failed\]/)
  }, 60_000)

  it('SIGINT-style abort mid-run cancels in-flight attempts and writes their rows as ABORTED', async () => {
    const out = mkdtempSync(resolve(tmpdir(), 'runner-par-'))
    const loops = fakeLoops()
    const ac = new AbortController()
    const { ledger, calls } = fakeLedger()
    const pending = runSet(req(out, { parallel: 4 }), { loops, route: ROUTE, runId: 'A', ledger, signal: ac.signal })
    await sleep(30)
    ac.abort('SIGINT')
    const res = await pending
    expect(res.rows.length).toBeGreaterThan(0)
    expect(res.rows.length).toBeLessThan(40)
    const aborted = res.rows.filter((r) => r.status === 'ABORTED')
    expect(aborted.length).toBeGreaterThan(0)
    for (const r of aborted) {
      expect(r.stopReason).toBe('aborted')
      expect(r.truth).toEqual({ status: 'error', error: 'aborted before truth' })
    }
    expect(res.rows.every((r) => r.status === 'ABORTED' || r.status === 'COMPLETED')).toBe(true)
    expect(loops.state.inFlight.size).toBe(0)
    expect(loops.state.disposed).toBe(res.rows.length)
    const parsed = readFileSync(resolve(out, 'attempts.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(parsed).toHaveLength(res.rows.length)
    expect(calls).toHaveLength(res.rows.length)
  }, 60_000)

  it('emits a heartbeat while attempts are in flight', async () => {
    const out = mkdtempSync(resolve(tmpdir(), 'runner-par-'))
    const lines: string[] = []
    await runSet(req(out, { limit: 6, parallel: 2 }), { loops: fakeLoops(), route: ROUTE, runId: 'H', heartbeatMs: 5, log: (l) => lines.push(l) })
    expect(lines.some((l) => /… \d+\/6 done, [12] running/.test(l))).toBe(true)
  })
})

describe('pool helpers', () => {
  it('Semaphore bounds concurrency and runPool keeps list order of starts', async () => {
    const sem = new Semaphore(2)
    let active = 0
    let peak = 0
    const starts: number[] = []
    await runPool([1, 2, 3, 4, 5, 6], 3, async (n) => {
      starts.push(n)
      await sem.run(async () => {
        active++
        peak = Math.max(peak, active)
        await sleep(3)
        active--
      })
    })
    expect(starts).toEqual([1, 2, 3, 4, 5, 6])
    expect(peak).toBe(2)
  })

  it('WriterQueue runs jobs one at a time in order and survives a failing job', async () => {
    const q = new WriterQueue()
    const seen: number[] = []
    void q.enqueue(async () => { await sleep(5); seen.push(1) })
    await expect(q.enqueue(() => { throw new Error('x') })).rejects.toThrow('x')
    void q.enqueue(() => { seen.push(2) })
    await q.drain()
    expect(seen).toEqual([1, 2])
  })
})
