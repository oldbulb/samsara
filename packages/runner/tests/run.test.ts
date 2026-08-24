import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { AttemptSpec, FinishedEvent, LoopEvent, LoopProvider, LoopRun, HarnessFacts } from '@oldbulb/samsara-loops'
import { factsSha } from '@oldbulb/samsara-loops'
import { runSet, readSubmit, submitToolName, sanitizeId, newRunId, type Loops } from '../src/run.ts'
import { formatSummary, summarize } from '../src/summary.ts'
import { loadPack } from '@oldbulb/samsara-pack'
import { challengerId, attemptRowSchema, scoreRowSchema, type AttemptRow as LedgerAttemptRow, type ChallengerProposal, type ScoreRow } from '@oldbulb/samsara-ledger'
import type { LedgerSink } from '../src/run.ts'

const MINI = resolve(import.meta.dirname, '..', '..', 'pack', 'tests', 'fixtures', 'minipack')

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

/** A loop that writes `submit` into the workdir (or nothing) and emits a fixed event list. */
function fakeLoops(opts: { submit?: unknown; finish?: FinishedEvent; reject?: boolean; onSpec?: (s: AttemptSpec) => void } = {}): Loops & { disposed: number } {
  const provider: LoopProvider = {
    name: 'fake', harnessFacts: FACTS,
    capabilities: { perAttemptBaseUrl: false, perAttemptEnv: false, nativeSchema: 'none', toolFilter: false, nativeMaxTurns: false },
    async start(spec) {
      opts.onSpec?.(spec)
      if (opts.reject) throw new Error('provider exploded before publication')
      if (opts.submit !== undefined) writeFileSync(resolve(spec.workdir, `${spec.tools.submitTool.name}.json`), JSON.stringify(opts.submit))
      const fin = opts.finish ?? finished()
      const events: LoopEvent[] = [
        { t: 'started', at: 0, native: { kind: 'fake', id: spec.attemptId } },
        { t: 'tool_call', at: 0, callId: 'c1', name: 'x', argsSha256: 'a', argsBytes: 1 },
        fin,
      ]
      const run: LoopRun = {
        id: spec.attemptId,
        events: (async function* () { for (const e of events) yield e })(),
        result: Promise.resolve(fin),
        cancel() {},
        async dispose() { loops.disposed++ },
      }
      return run
    },
  }
  const loops = {
    disposed: 0,
    get: (n: string) => (n === 'fake' ? provider : undefined),
    start: (n: string, spec: AttemptSpec) => {
      if (n !== 'fake') throw new Error('unknown loop')
      return provider.start(spec)
    },
  }
  return loops
}

const ROUTE = { provider: 'p', model: 'm', credentialRef: 'cred' }

function req(out: string, over: Partial<Parameters<typeof runSet>[0]> = {}) {
  return { pack: MINI, loop: 'fake', set: 'smoke' as const, repeat: 1, out, maxTurns: 5, maxMinutes: 1, ...over }
}

describe('runSet', () => {
  it('materializes, runs the loop, validates the submit, scores, and writes attempts.jsonl', async () => {
    const out = mkdtempSync(resolve(tmpdir(), 'runner-'))
    const specs: AttemptSpec[] = []
    const loops = fakeLoops({ submit: { summary: 'done' }, onSpec: (s) => specs.push(s) })
    const res = await runSet(req(out), { loops, route: ROUTE, runId: 'run-T' })
    expect(res.rows).toHaveLength(1)
    const row = res.rows[0]!
    expect(row.attemptId).toBe('run-T-s1-0')
    expect(row.status).toBe('COMPLETED')
    expect(row.output.valid).toBe(true)
    expect(row.truth.status).toBe('settled')
    expect(row.scores.map((s) => s.metric)).toEqual(['pass_rate', 'cost_usd'])
    expect(row.facts_sha).toBe(factsSha(FACTS))
    expect(row.usage).toEqual({ inputTokens: 10, outputTokens: 5 })
    expect(row.toolCalls).toBe(3)
    expect(loops.disposed).toBe(1)
    // attempts.jsonl has one line equal to the row
    const lines = readFileSync(resolve(out, 'attempts.jsonl'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!)).toEqual(row)
    // events drained next to the workdir; workdir kept
    const events = readFileSync(resolve(out, 'attempts', 'run-T-s1-0', 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(events.map((e) => e.t)).toEqual(['started', 'tool_call', 'finished'])
    expect(existsSync(resolve(out, 'attempts', 'run-T-s1-0', '.task', 'token.json'))).toBe(true)
    // the spec handed to the loop
    const spec = specs[0]!
    expect(spec.challengerId).toBe('champion')
    expect(spec.workdir).toBe(resolve(out, 'attempts', 'run-T-s1-0'))
    expect(spec.tools.submitTool.name).toBe('submit_mini')
    expect(spec.tools.deny).toEqual([])
    expect(spec.route).toEqual(ROUTE)
    expect(spec.limits).toEqual({ maxTurns: 5, maxDurationMs: 60_000 })
    expect(spec.tmpdir).toBe(resolve(spec.workdir, '.tmp'))
    expect(spec.skill.dir).toBe(resolve(spec.workdir, '.agents', 'skills', 'mini'))
    expect(existsSync(resolve(spec.workdir, '.claude', 'skills', 'mini', 'SKILL.md'))).toBe(true)
    expect(spec.prompt).toBe(readFileSync(resolve(MINI, 'skill', 'SKILL.md'), 'utf8'))
  })

  it('records the champion challenger once and every attempt + score in the ledger', async () => {
    const out = mkdtempSync(resolve(tmpdir(), 'runner-'))
    const proposals: ChallengerProposal[] = []
    const attempts: LedgerAttemptRow[] = []
    const scores: ScoreRow[] = []
    const ledger: LedgerSink = {
      async propose(p) { proposals.push(p); return challengerId(p) },
      async recordAttempt(r) { attempts.push(attemptRowSchema.parse(r)); return r.id },
      async appendScores(rows) { for (const r of rows) scores.push(scoreRowSchema.parse(r)); return rows.map((r) => r.metric) },
    }
    const res = await runSet(req(out, { set: 'holdin', repeat: 2 }), { loops: fakeLoops({ submit: { summary: 'done' } }), route: ROUTE, runId: 'rl', ledger })
    expect(proposals).toHaveLength(1)
    expect(res.challengerId).toBe(challengerId(proposals[0]!))
    expect(proposals[0]!.harness_sha).toBe(factsSha(FACTS))
    expect(proposals[0]!.taskset_sha).toBe(res.tasksetSha)
    expect(proposals[0]!.route.loop).toBe('fake')
    expect(attempts).toHaveLength(res.rows.length)
    expect(attempts.every((a) => a.challenger_id === res.challengerId && a.tier === 'holdin')).toBe(true)
    expect(scores).toHaveLength(res.rows.reduce((n, r) => n + r.scores.length, 0))
    expect(scores.every((s) => s.truth_snapshot_id === res.rows[0]!.truth.truth_sha)).toBe(true)
  })

  it('marks a missing or contract-violating submit as output.valid=false but still scores settled truth', async () => {
    const out = mkdtempSync(resolve(tmpdir(), 'runner-'))
    const none = await runSet(req(out), { loops: fakeLoops(), route: ROUTE, runId: 'r1' })
    expect(none.rows[0]!.output.valid).toBe(false)
    expect(none.rows[0]!.output.error).toMatch(/no submit file/)
    expect(none.rows[0]!.scores).toHaveLength(2)
    const bad = await runSet(req(out), { loops: fakeLoops({ submit: { summary: 1 } }), route: ROUTE, runId: 'r2' })
    expect(bad.rows[0]!.output.valid).toBe(false)
    expect(bad.rows[0]!.output.error).toMatch(/submit does not satisfy/)
  })

  it('records a provider rejection as FAILED/error with a host error and continues', async () => {
    const out = mkdtempSync(resolve(tmpdir(), 'runner-'))
    const res = await runSet(req(out, { set: 'holdin', repeat: 2 }), { loops: fakeLoops({ reject: true }), route: ROUTE, runId: 'r3' })
    const def = loadPack(MINI)
    expect(res.rows).toHaveLength(def.taskSets.holdin.tasks.length * 2)
    for (const row of res.rows) {
      expect(row.status).toBe('FAILED')
      expect(row.stopReason).toBe('error')
      expect(row.error).toMatch(/^loop: provider exploded/)
    }
    expect(res.rows.map((r) => r.attemptId.slice(-1))).toEqual(res.rows.map((_, i) => String(i % 2)))
  })

  it('honours --limit and records truth errors on the row', async () => {
    const out = mkdtempSync(resolve(tmpdir(), 'runner-'))
    const prev = process.env['MINIPACK_MODE']
    process.env['MINIPACK_MODE'] = 'crash'
    try {
      const res = await runSet(req(out, { set: 'holdin', limit: 1 }), { loops: fakeLoops(), route: ROUTE, runId: 'r4' })
      expect(res.rows).toHaveLength(1)
      expect(res.rows[0]!.truth.status).toBe('error')
      expect(res.rows[0]!.error).toMatch(/^truth: /)
      expect(res.rows[0]!.status).toBe('COMPLETED')
    } finally {
      if (prev === undefined) delete process.env['MINIPACK_MODE']
      else process.env['MINIPACK_MODE'] = prev
    }
  })

  it('stops issuing attempts once the signal is aborted', async () => {
    const out = mkdtempSync(resolve(tmpdir(), 'runner-'))
    const ac = new AbortController()
    ac.abort('test')
    const res = await runSet(req(out, { set: 'holdin' }), { loops: fakeLoops(), route: ROUTE, runId: 'r5', signal: ac.signal })
    expect(res.rows).toHaveLength(0)
  })
})

describe('helpers', () => {
  it('sanitizeId, newRunId, submitToolName, readSubmit', () => {
    expect(sanitizeId('a/b c')).toBe('a_b_c')
    expect(newRunId(new Date('2026-08-23T10:11:12.345Z'))).toBe('run-20260823T101112Z')
    const def = loadPack(MINI)
    expect(submitToolName(def)).toBe('submit_mini')
    const wd = mkdtempSync(resolve(tmpdir(), 'wd-'))
    expect(readSubmit(def, wd).valid).toBe(false)
    writeFileSync(resolve(wd, 'submit_mini.json'), '{not json')
    expect(readSubmit(def, wd).error).toMatch(/not JSON/)
    writeFileSync(resolve(wd, 'submit_mini.json'), '{"summary":"ok"}')
    expect(readSubmit(def, wd)).toMatchObject({ valid: true, submit: { summary: 'ok' } })
  })

  it('summarize / formatSummary aggregate pass_rate and cost', () => {
    const row = (over: object) => ({
      attemptId: 'a', task_id: 't', loop: 'l', facts_sha: 'f', status: 'COMPLETED', stopReason: 'completed',
      usage: { inputTokens: 0, outputTokens: 0 }, cost: { source: 'unknown' }, toolCalls: 1,
      output: { valid: true }, truth: { status: 'settled' }, scores: [], ...over,
    }) as Parameters<typeof summarize>[0][number]
    const rows = [
      row({ scores: [{ task_id: 't', metric: 'pass_rate', value: 1, kind: 'reality' }], cost: { usd: 0.5, source: 'self-reported' } }),
      row({ scores: [{ task_id: 't', metric: 'pass_rate', value: 0, kind: 'reality' }, { task_id: 't', metric: 'cost_usd', value: 0.25, kind: 'mechanical' }] }),
      row({ status: 'FAILED', stopReason: 'error' }),
    ]
    const s = summarize(rows)
    expect(s).toEqual({ attempts: 3, passRateMean: 0.5, costUsd: 0.75, byStatus: { COMPLETED: 2, FAILED: 1 } })
    const text = formatSummary({ runId: 'r', pack: 'p', set: 'smoke', tasksetSha: 'abcdef0123456789', rows, attemptsPath: '/x/attempts.jsonl' })
    expect(text).toContain('pass_rate mean 0.500')
    expect(text).toContain('cost_usd 0.7500')
    expect(text).toContain('COMPLETED=2 FAILED=1')
    expect(text.split('\n').filter((l) => l.startsWith('t ')).length).toBe(3)
  })
})
