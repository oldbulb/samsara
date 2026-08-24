import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, DomainFacility, JsonStorageBackend, Storage, storageBackendServiceKey } from '@oldbulb/samsara-kernel'
import {
  Ledger,
  LedgerError,
  challengerId,
  compareKey,
  importAttemptsJsonl,
  scoreKey,
  type AttemptRow,
  type ChallengerProposal,
  type CompareRow,
  type ScoreRow,
} from '../src/index.ts'

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

/** Bare context: storage hub + json backend in `root` + domain facility, then the ledger service. */
async function open(root: string) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new JsonStorageBackend(root)
  ctx.storage.backend.register('json', backend)
  ctx.provide(storageBackendServiceKey('json'), backend)
  const facility = new DomainFacility(ctx, { backend: 'json', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const fiber = ctx.plugin(Ledger)
  await fiber
  return {
    ctx,
    ledger: ctx.ledger,
    async close() {
      await fiber.dispose()
      await backend.close()
    },
  }
}

function freshRoot(): string {
  const d = mkdtempSync(join(tmpdir(), 'samsara-ledger-'))
  dirs.push(d)
  return d
}

function proposal(over: Partial<ChallengerProposal> = {}): ChallengerProposal {
  return {
    parent_ids: [],
    patch_sha: sha('p1'),
    harness_sha: sha('h'),
    env_sha: sha('e'),
    skill_sha: sha('s'),
    taskset_sha: sha('t'),
    route: { loop: 'l', loop_adapter_version: '1', model_id: 'm', model_pool_sha: sha('mp'), base_url_kind: 'direct' },
    optimizer_config_sha: sha('o'),
    lineage: 'main',
    surface: 'skill',
    patch: { skill_ref: 'skill:' + sha('s') },
    intent: 'try',
    prediction: { metric: 'solve', direction: 'up' },
    scorer_version: '1',
    task_version: 1,
    truth_snapshot_id: sha('ts'),
    report_rule_version: '1',
    runtime: { timeout_s: 60, step_cap: 10 },
    tasksets: { smoke: sha('a'), holdin: sha('b'), holdout: sha('c') },
    budget: 1,
    proposed_at: '2026-01-01T00:00:00Z',
    ...over,
  }
}

function attempt(id: string, challenger_id: string, tier: AttemptRow['tier'], status: AttemptRow['status'] = 'COMPLETED'): AttemptRow {
  return {
    id, challenger_id, task_id: `task-${id}`, sample: 0, loop: 'l', tier, status, stop_reason: 'submitted',
    facts_sha: sha('f'), usage: { input_tokens: 1, output_tokens: 1 }, cost: { tokens: 2 },
    output: { source: 'submit', valid: true }, artifacts: [],
  }
}

function score(attempt_id: string, value: number, truth = sha('ts')): ScoreRow {
  return { attempt_id, scorer_version: '1', truth_snapshot_id: truth, metric: 'solve', value, kind: 'mechanical' }
}

function compare(challenger_id: string, over: Partial<CompareRow> = {}): CompareRow {
  return {
    challenger_id, vs_id: 'champion', tier: 'holdin', truth_snapshot_id: sha('ts'),
    per_task: [{ task_id: 't1', delta: 0.1 }], mean: 0.1, ci: [0, 0.2], method: 'paired', cluster_key: 'entity',
    n_eff: 10, mde: 0.05, rule_fired: 'none', verdict: { value: 'hold', by: 'gate-default@1', rule: 'r' },
    at: '2026-01-01T00:00:00Z',
    ...over,
  }
}

describe('challengerId', () => {
  it('is a sha256 of the coordinate tuple, independent of key order', () => {
    const a = proposal()
    const b = { ...proposal(), route: { base_url_kind: 'direct', model_pool_sha: sha('mp'), model_id: 'm', loop_adapter_version: '1', loop: 'l' } }
    expect(challengerId(a)).toMatch(/^[0-9a-f]{64}$/)
    expect(challengerId(a)).toBe(challengerId(b))
    expect(challengerId({ ...a, patch_sha: sha('p2') })).not.toBe(challengerId(a))
  })
})

describe('Ledger', () => {
  it('propose dedupes by id and ignores non-coordinate differences', async () => {
    const h = await open(freshRoot())
    const id = await h.ledger.propose(proposal())
    const again = await h.ledger.propose(proposal({ intent: 'different intent' }))
    expect(again).toBe(id)
    expect(h.ledger.challenger(id)?.intent).toBe('try')
    expect(h.ledger.read('challengers', 'human')).toHaveLength(1)
    expect(h.ledger.challenger(id)?.status).toBe('proposed')
    await h.ledger.setStatus(id, 'running', { tier_reached: 'smoke' })
    expect(h.ledger.challenger(id)).toMatchObject({ status: 'running', tier_reached: 'smoke' })
    await h.close()
  })

  it('lineage walks the first-parent chain', async () => {
    const h = await open(freshRoot())
    const root = await h.ledger.propose(proposal())
    const child = await h.ledger.propose(proposal({ parent_ids: [root], patch_sha: sha('p2') }))
    const grand = await h.ledger.propose(proposal({ parent_ids: [child, root], patch_sha: sha('p3') }))
    expect(h.ledger.lineage(grand).map((r) => r.id)).toEqual([grand, child, root])
    expect(h.ledger.lineage('missing')).toEqual([])
    await h.close()
  })

  it('scores are append-only: same key is skipped, a new truth snapshot is a new row', async () => {
    const h = await open(freshRoot())
    const c = await h.ledger.propose(proposal())
    await h.ledger.recordAttempt(attempt('a1', c, 'holdin'))
    const first = await h.ledger.appendScores([score('a1', 1)])
    expect(first).toEqual([scoreKey(score('a1', 1))])
    const dup = await h.ledger.appendScores([score('a1', 0)])
    expect(dup).toEqual([])
    expect(h.ledger.scoresOf('a1')).toEqual([score('a1', 1)])
    const rescored = await h.ledger.appendScores([score('a1', 0, sha('ts2'))])
    expect(rescored).toHaveLength(1)
    expect(h.ledger.scoresOf('a1').map((s) => s.value).sort()).toEqual([0, 1])
    await h.close()
  })

  it('recordCompare: first verdict wins', async () => {
    const h = await open(freshRoot())
    const c = await h.ledger.propose(proposal())
    const key = await h.ledger.recordCompare(compare(c))
    expect(key).toBe(compareKey(compare(c)))
    await expect(h.ledger.recordCompare(compare(c, { verdict: { value: 'promote', by: 'x', rule: 'y' } })))
      .rejects.toMatchObject({ name: 'LedgerError', code: 'VERDICT_EXISTS' })
    expect(h.ledger.comparesOf(c)[0]?.verdict.value).toBe('hold')
    // A different tier or truth snapshot is a different verdict slot.
    await h.ledger.recordCompare(compare(c, { tier: 'holdout' }))
    await h.ledger.recordCompare(compare(c, { truth_snapshot_id: sha('ts2') }))
    expect(h.ledger.comparesOf(c)).toHaveLength(3)
    await h.close()
  })

  it('consents and settlements are immutable by id', async () => {
    const h = await open(freshRoot())
    const c = await h.ledger.propose(proposal())
    await h.ledger.recordConsent({ id: 'k1', challenger_id: c, action: 'promote', who: 'me', channel: 'socket', proof_sha: sha('pf'), at: 't' })
    await h.ledger.recordConsent({ id: 'k1', challenger_id: c, action: 'reject', who: 'me', channel: 'socket', proof_sha: sha('pf'), at: 't' })
    expect(h.ledger.consentsOf(c).map((r) => r.action)).toEqual(['promote'])
    await h.ledger.recordSettlement({ id: 's1', kind: 'truth', taskset_sha: sha('t'), as_of: 't', truth_snapshot_id: sha('ts'), n_settled: 1, n_pending: 0, triggered_rescoring: [] })
    await h.ledger.recordSettlement({ id: 's1', kind: 'scorer', taskset_sha: sha('t'), as_of: 't', truth_snapshot_id: sha('ts'), n_settled: 9, n_pending: 0, triggered_rescoring: [] })
    expect(h.ledger.read('settlements', 'gate')).toMatchObject([{ kind: 'truth' }])
    await h.close()
  })

  it('rejects rows that fail their schema before any write', async () => {
    const h = await open(freshRoot())
    await expect(h.ledger.recordAttempt({ ...attempt('x', 'c', 'smoke'), status: 'DONE' as never })).rejects.toThrow()
    expect(h.ledger.read('attempts', 'human')).toEqual([])
    await h.close()
  })

  it('proposer reads see held-out attempts and scores only as aggregates', async () => {
    const h = await open(freshRoot())
    const c = await h.ledger.propose(proposal())
    await h.ledger.recordAttempt(attempt('in1', c, 'holdin'))
    await h.ledger.recordAttempt(attempt('out1', c, 'holdout'))
    await h.ledger.recordAttempt(attempt('out2', c, 'holdout', 'FAILED'))
    await h.ledger.appendScores([score('in1', 1), score('out1', 1), score('out2', 0)])

    const attempts = h.ledger.read('attempts', 'proposer')
    expect(attempts).toHaveLength(2)
    expect(attempts.find((r) => 'id' in r)).toMatchObject({ id: 'in1' })
    expect(attempts.find((r) => 'redacted' in r)).toEqual({
      redacted: true, challenger_id: c, tier: 'holdout', n: 2, by_status: { COMPLETED: 1, FAILED: 1 },
    })
    expect(JSON.stringify(attempts)).not.toContain('task-out1')

    const scores = h.ledger.read('scores', 'proposer')
    expect(scores).toHaveLength(2)
    expect(scores.find((r) => 'attempt_id' in r)).toMatchObject({ attempt_id: 'in1' })
    expect(scores.find((r) => 'redacted' in r)).toMatchObject({ redacted: true, challenger_id: c, metric: 'solve', n: 2, mean: 0.5 })
    expect(JSON.stringify(scores)).not.toContain('out1')

    // gate and human see every row.
    expect(h.ledger.read('attempts', 'gate')).toHaveLength(3)
    expect(h.ledger.read('scores', 'human')).toHaveLength(3)
    // A score with no attempt row is redacted too (it cannot prove it is not held out).
    await h.ledger.appendScores([score('orphan', 1)])
    expect(h.ledger.read('scores', 'proposer').filter((r) => 'attempt_id' in r)).toHaveLength(1)
    await h.close()
  })

  it('restart: close, reopen on the same root, identical contents', async () => {
    const root = freshRoot()
    const a = await open(root)
    const c = await a.ledger.propose(proposal())
    await a.ledger.setStatus(c, 'judged', { verdict: { value: 'hold', by: 'g', rule: 'r' } })
    await a.ledger.recordAttempt(attempt('a1', c, 'holdout'))
    await a.ledger.appendScores([score('a1', 1)])
    await a.ledger.recordCompare(compare(c))
    await a.ledger.recordConsent({ id: 'k1', challenger_id: c, action: 'promote', who: 'me', channel: 'socket', proof_sha: sha('pf'), at: 't' })
    await a.ledger.recordSettlement({ id: 's1', kind: 'truth', taskset_sha: sha('t'), as_of: 't', truth_snapshot_id: sha('ts'), n_settled: 1, n_pending: 0, triggered_rescoring: [c] })
    const views = ['challengers', 'attempts', 'scores', 'compares', 'consents', 'settlements'] as const
    const before = Object.fromEntries(views.map((v) => [v, a.ledger.read(v, 'human')]))
    await a.close()
    expect(() => a.ledger.read('challengers', 'human')).toThrow(LedgerError)

    const b = await open(root)
    const after = Object.fromEntries(views.map((v) => [v, b.ledger.read(v, 'human')]))
    expect(after).toEqual(before)
    expect(b.ledger.challenger(c)?.verdict?.value).toBe('hold')
    // Invariants survive the restart: dedupe and first-verdict-wins still hold.
    expect(await b.ledger.propose(proposal())).toBe(c)
    await expect(b.ledger.recordCompare(compare(c))).rejects.toMatchObject({ code: 'VERDICT_EXISTS' })
    await b.close()
  })

  it('importAttemptsJsonl ingests the runner line shape into attempts + scores', async () => {
    const h = await open(freshRoot())
    const c = await h.ledger.propose(proposal())
    const root = freshRoot()
    const path = join(root, 'attempts.jsonl')
    const line = (attemptId: string, task_id: string, value: number) => JSON.stringify({
      attemptId, task_id, loop: 'dsh', facts_sha: sha('f'), status: 'COMPLETED', stopReason: 'submitted',
      usage: { inputTokens: 10, outputTokens: 5 }, cost: { source: 'usage', usd: 0.01 }, toolCalls: 3,
      output: { valid: true, file: '/w/submit.json' }, truth: { status: 'settled', truth_sha: sha('tr') },
      scores: [{ task_id, metric: 'solve', value, kind: 'mechanical' }, { task_id, metric: 'cost_usd', value: 0.01, kind: 'mechanical' }],
    })
    writeFileSync(path, [line('run-1-t1-0', 't1', 1), line('run-1-t1-1', 't1', 0), 'not json', ''].join('\n'))
    const res = await importAttemptsJsonl(h.ledger, path, { challengerId: c, loop: 'dsh', tier: 'smoke', scorerVersion: '1' })
    expect(res).toEqual({ attempts: ['run-1-t1-0', 'run-1-t1-1'], scores: expect.any(Array), skipped: 1 })
    expect(res.scores).toHaveLength(4)
    expect(h.ledger.attemptsOf(c).map((a) => [a.id, a.sample, a.tier, a.cost.usd, a.usage.input_tokens])).toEqual([
      ['run-1-t1-0', 0, 'smoke', 0.01, 10], ['run-1-t1-1', 1, 'smoke', 0.01, 10],
    ])
    expect(h.ledger.scoresOf('run-1-t1-1')).toMatchObject([{ metric: 'solve', value: 0, truth_snapshot_id: sha('tr') }, { metric: 'cost_usd' }])
    // Re-import is idempotent for scores (append-only keys).
    const again = await importAttemptsJsonl(h.ledger, path, { challengerId: c, loop: 'dsh', tier: 'smoke', scorerVersion: '1' })
    expect(again.scores).toEqual([])
    expect(h.ledger.read('scores', 'human')).toHaveLength(4)
    await h.close()
  })
})
