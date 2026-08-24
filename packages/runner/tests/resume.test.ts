import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { AttemptSpec, FinishedEvent, LoopEvent, LoopProvider, LoopRun, HarnessFacts } from '@oldbulb/samsara-loops'
import { challengerId, attemptRowSchema, scoreRowSchema, type AttemptRow as LedgerAttemptRow, type ScoreRow } from '@oldbulb/samsara-ledger'
import { runSet, type AttemptRow, type Loops, type LedgerSink } from '../src/run.ts'
import { STEPS, completedSteps, isComplete, readRunRecord, readStep, stepPath, writeRunRecord } from '../src/steps.ts'
import { runProgram, type SamsaraRunValues } from '../src/startup.ts'
import { resolveResume } from '../src/index.ts'

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

/** A loop whose attempts take 5–30 ms, honour cancel() with an ABORTED finish and write a valid submit. */
function fakeLoops(): Loops & { started: string[] } {
  const started: string[] = []
  const provider: LoopProvider = {
    name: 'fake', harnessFacts: FACTS,
    capabilities: { perAttemptBaseUrl: false, perAttemptEnv: false, nativeSchema: 'none', toolFilter: false, nativeMaxTurns: false },
    async start(spec: AttemptSpec) {
      started.push(spec.attemptId)
      let settle!: (f: FinishedEvent) => void
      const result = new Promise<FinishedEvent>((r) => { settle = r })
      let done = false
      const finish = (f: FinishedEvent) => { if (!done) { done = true; settle(f) } }
      const timer = setTimeout(() => {
        writeFileSync(resolve(spec.workdir, `${spec.tools.submitTool.name}.json`), JSON.stringify({ summary: 'ok' }))
        finish(finished())
      }, 5 + Math.random() * 25)
      const run: LoopRun = {
        id: spec.attemptId,
        events: (async function* (): AsyncGenerator<LoopEvent> {
          yield { t: 'started', at: 0, native: { kind: 'fake', id: spec.attemptId } }
          yield await result
        })(),
        result,
        cancel() { clearTimeout(timer); finish(finished({ status: 'ABORTED', stopReason: 'aborted' })) },
        async dispose() {},
      }
      return run
    },
  }
  return { started, get: (n) => (n === 'fake' ? provider : undefined), start: (_n, spec) => provider.start(spec) }
}

/** A ledger keyed like the real one: attempts by id (put overwrites), scores by content key. */
function fakeLedger() {
  const attempts = new Map<string, LedgerAttemptRow>()
  const scores = new Map<string, ScoreRow>()
  const ledger: LedgerSink = {
    async propose(p) { return challengerId(p) },
    async recordAttempt(r) { const row = attemptRowSchema.parse(r); attempts.set(row.id, row); return row.id },
    async appendScores(rows) {
      const written: string[] = []
      for (const raw of rows) {
        const r = scoreRowSchema.parse(raw)
        const k = [r.attempt_id, r.scorer_version, r.truth_snapshot_id, r.metric].join(' ')
        if (!scores.has(k)) { scores.set(k, r); written.push(k) }
      }
      return written
    },
  }
  return { ledger, attempts, scores }
}

const ROUTE = { provider: 'p', model: 'm', credentialRef: 'cred' }

function req(out: string, over: Partial<Parameters<typeof runSet>[0]> = {}) {
  return { pack: PAR, loop: 'fake', set: 'holdin' as const, repeat: 1, out, maxTurns: 5, maxMinutes: 1, parallel: 4, limit: 12, ...over }
}

function jsonl(out: string): AttemptRow[] {
  return readFileSync(resolve(out, 'attempts.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

function attemptDir(out: string, id: string): string {
  return resolve(out, 'attempts', id)
}

describe('durable steps + --resume', () => {
  it('writes run.json and all six markers for a completed attempt', async () => {
    const out = mkdtempSync(resolve(tmpdir(), 'runner-steps-'))
    const { ledger } = fakeLedger()
    const res = await runSet(req(out, { limit: 2 }), { loops: fakeLoops(), route: ROUTE, runId: 'S', ledger })
    const rec = readRunRecord(out)
    expect(rec.runId).toBe('S')
    expect(rec.tasks).toEqual(res.rows.map((r) => r.task_id))
    expect(rec.request).toMatchObject({ pack: PAR, loop: 'fake', set: 'holdin', limit: 2, repeat: 1, parallel: 4 })
    expect(rec.request).not.toHaveProperty('out')
    for (const row of res.rows) {
      const dir = attemptDir(out, row.attemptId)
      expect(completedSteps(dir)).toEqual([...STEPS])
      expect(readStep(dir, 'loop')?.finished.status).toBe('COMPLETED')
      expect(readStep(dir, 'submit')?.valid).toBe(true)
      expect(readStep(dir, 'truth')?.truth).toEqual(row.truth)
      expect(readStep(dir, 'score')?.scores).toEqual(row.scores)
      expect(readStep(dir, 'record')?.ledger).toBe(true)
      expect(readStep(dir, 'materialize')).toMatchObject({ attemptId: row.attemptId, tmpdir: '.tmp' })
    }
  })

  it('abort mid-run, then resume: every attempt ends with six markers and exactly one row in jsonl and ledger; finished loops are not re-run', async () => {
    const out = mkdtempSync(resolve(tmpdir(), 'runner-resume-'))
    const first = fakeLoops()
    const { ledger, attempts, scores } = fakeLedger()
    const ac = new AbortController()
    const pending = runSet(req(out), { loops: first, route: ROUTE, runId: 'R', ledger, signal: ac.signal })
    await sleep(25)
    ac.abort('SIGINT')
    const partial = await pending
    expect(partial.rows.length).toBeGreaterThan(0)
    expect(partial.rows.length).toBeLessThan(12)
    const completed = partial.rows.filter((r) => r.status === 'COMPLETED').map((r) => r.attemptId)
    const aborted = partial.rows.filter((r) => r.status === 'ABORTED').map((r) => r.attemptId)
    expect(aborted.length).toBeGreaterThan(0)
    // a cancelled loop leaves no loop marker (it was not finished); a completed one is fully journaled
    for (const id of aborted) expect(existsSync(stepPath(attemptDir(out, id), 'loop'))).toBe(false)
    for (const id of completed) expect(isComplete(attemptDir(out, id))).toBe(true)

    const second = fakeLoops()
    const lines: string[] = []
    const res = await runSet({ ...req(out), resume: true }, { loops: second, route: ROUTE, runId: 'ignored', ledger, log: (l) => lines.push(l) })
    expect(res.runId).toBe('R')
    expect(res.rows).toHaveLength(12)
    expect(res.rows.every((r) => r.status === 'COMPLETED' && r.truth.status === 'settled' && r.scores.length === 2)).toBe(true)
    // only the attempts without a finished loop were started again
    expect(new Set(second.started)).toEqual(new Set(res.rows.map((r) => r.attemptId).filter((id) => !completed.includes(id))))
    expect(second.started.some((id) => completed.includes(id))).toBe(false)
    for (const id of aborted) expect(second.started).toContain(id)
    for (const row of res.rows) expect(completedSteps(attemptDir(out, row.attemptId))).toEqual([...STEPS])
    // exactly one row per attempt in jsonl and in the ledger
    const rows = jsonl(out)
    expect(rows).toHaveLength(12)
    expect(new Set(rows.map((r) => r.attemptId)).size).toBe(12)
    expect(rows.every((r) => r.status === 'COMPLETED')).toBe(true)
    expect(attempts.size).toBe(12)
    expect([...attempts.values()].every((a) => a.status === 'COMPLETED')).toBe(true)
    expect(scores.size).toBe(24)
    expect(lines.some((l) => /resume: \d+\/12 attempts complete/.test(l))).toBe(true)
  }, 30_000)

  it('resumes an attempt whose loop finished but whose truth/score/record were lost, without starting the loop again', async () => {
    const out = mkdtempSync(resolve(tmpdir(), 'runner-resume-'))
    const { ledger, attempts } = fakeLedger()
    const res = await runSet(req(out, { limit: 3 }), { loops: fakeLoops(), route: ROUTE, runId: 'L', ledger })
    const victim = res.rows[1]!
    const dir = attemptDir(out, victim.attemptId)
    for (const s of ['truth', 'score', 'record'] as const) rmSync(stepPath(dir, s))
    // simulate a SIGINT that lost the row after the loop: drop it from jsonl and from the ledger
    writeFileSync(resolve(out, 'attempts.jsonl'), jsonl(out).filter((r) => r.attemptId !== victim.attemptId).map((r) => JSON.stringify(r) + '\n').join(''))
    attempts.delete(victim.attemptId)

    const loops = fakeLoops()
    const again = await runSet({ ...req(out), resume: true }, { loops, route: ROUTE, ledger })
    expect(loops.started).toEqual([])
    expect(again.rows).toHaveLength(3)
    const restored = again.rows.find((r) => r.attemptId === victim.attemptId)!
    expect(restored).toEqual(victim)
    expect(isComplete(dir)).toBe(true)
    expect(jsonl(out).map((r) => r.attemptId).sort()).toEqual(res.rows.map((r) => r.attemptId).sort())
    expect(attempts.has(victim.attemptId)).toBe(true)
  })

  it('resuming a completed run is a no-op', async () => {
    const out = mkdtempSync(resolve(tmpdir(), 'runner-resume-'))
    const { ledger, attempts } = fakeLedger()
    const res = await runSet(req(out, { limit: 3 }), { loops: fakeLoops(), route: ROUTE, runId: 'N', ledger })
    const before = readFileSync(resolve(out, 'attempts.jsonl'), 'utf8')
    const markers = res.rows.map((r) => STEPS.map((s) => readFileSync(stepPath(attemptDir(out, r.attemptId), s), 'utf8')))
    const loops = fakeLoops()
    const lines: string[] = []
    const again = await runSet({ ...req(out), resume: true }, { loops, route: ROUTE, ledger, log: (l) => lines.push(l) })
    expect(loops.started).toEqual([])
    expect(again.rows).toEqual(res.rows)
    expect(again.runId).toBe('N')
    expect(readFileSync(resolve(out, 'attempts.jsonl'), 'utf8')).toBe(before)
    expect(res.rows.map((r) => STEPS.map((s) => readFileSync(stepPath(attemptDir(out, r.attemptId), s), 'utf8')))).toEqual(markers)
    expect(attempts.size).toBe(3)
    expect(lines.some((l) => l.includes('resume: 3/3 attempts complete, 0 to finish'))).toBe(true)
  })

  it('refuses to resume a directory without run.json or whose tasks changed', async () => {
    const out = mkdtempSync(resolve(tmpdir(), 'runner-resume-'))
    await expect(runSet({ ...req(out), resume: true }, { loops: fakeLoops(), route: ROUTE })).rejects.toThrow(/no run\.json/)
    const rec = readRunRecord((await (async () => { await runSet(req(out, { limit: 2 }), { loops: fakeLoops(), route: ROUTE, runId: 'T' }); return out })()))
    writeRunRecord(out, { ...rec, tasks: ['nope'] })
    await expect(runSet({ ...req(out), resume: true }, { loops: fakeLoops(), route: ROUTE })).rejects.toThrow(/no longer match/)
  })

  it('run --resume <dir> parses alone and resolves to the recorded request', async () => {
    let values: SamsaraRunValues | undefined
    const program = runProgram((v) => { values = v })
    const quiet = (c: typeof program) => { c.exitOverride().configureOutput({ writeErr: () => {}, writeOut: () => {} }); c.commands.forEach(quiet) }
    quiet(program)
    program.parse(['run', '--resume', '/r'], { from: 'user' })
    expect(values).toEqual({ command: 'run', resumeDir: '/r' })
    expect(() => program.parse(['run', '--loop', 'l', '--set', 'smoke'], { from: 'user' })).toThrow(/--pack/)

    const out = mkdtempSync(resolve(tmpdir(), 'runner-resume-'))
    await runSet(req(out, { limit: 1 }), { loops: fakeLoops(), route: ROUTE, runId: 'C' })
    expect(resolveResume({ command: 'run', resumeDir: out })).toEqual({ command: 'run', ...readRunRecord(out).request, out, resume: true })
  })
})
