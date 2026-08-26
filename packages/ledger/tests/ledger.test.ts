import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, DomainFacility, JsonStorageBackend, Storage, storageBackendServiceKey } from '@oldbulb/samsara-kernel'
import {
  Ledger,
  LedgerError,
  backupSqlite,
  challengerId,
  compareKey,
  evalConfigSha,
  experimentId,
  importAttemptsJsonl,
  noiseFloorId,
  roundId,
  scoreKey,
  type AttemptRow,
  type ChallengerProposal,
  type CompareRow,
  type ExperimentInput,
  type NoiseFloorInput,
  type NotebookRow,
  type RoundInput,
  type ScoreRow,
  type ServingRow,
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
    pack: 'pk',
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
    facts_sha: sha('f'), usage: { input_tokens: 1, output_tokens: 1 }, cost: { tokens: 2, wall_s: 1.5, compute_usd: 0.002 },
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

  it('environment_sha joins the tuple only when present: a row without it keeps the id it always had', () => {
    // Pinned before the coordinate existed; a change here would re-key every recorded row.
    expect(challengerId(proposal())).toBe('ced2f0310ca20b48f156b02d1edcb383511cfefe83129600d25947ab5228d7b1')
    expect(challengerId({ ...proposal(), environment_sha: undefined })).toBe(challengerId(proposal()))
    const withEnv = challengerId({ ...proposal(), environment_sha: sha('env') })
    expect(withEnv).toMatch(/^[0-9a-f]{64}$/)
    expect(withEnv).not.toBe(challengerId(proposal()))
    expect(withEnv).not.toBe(challengerId({ ...proposal(), environment_sha: sha('env2') }))
    expect(() => challengerId({ ...proposal(), environment_sha: 'not-a-sha' })).toThrow()
  })
})

const GATE = { name: 'gate-default', version: '1', policy_sha: sha('policy') }

function round(over: Partial<RoundInput> = {}): RoundInput {
  return { eval_config_sha: sha('ec'), champion_id: 'champion', gate: GATE, shadow_gates: [], opened_at: '2026-01-01T00:00:00Z', ...over }
}

function noiseFloor(over: Partial<NoiseFloorInput> = {}): NoiseFloorInput {
  return {
    eval_config_sha: sha('ec'), champion_id: 'champion', loop: 'l', metric: 'solve', unit: 'entity',
    sd_paired: 0.3, n_reruns: 3, n_tasks: 20, tier: 'holdin', measured_at: '2026-01-01T00:00:00Z', ...over,
  }
}

function serving(id: string, over: Partial<ServingRow> = {}): ServingRow {
  return { id, champion_id: 'champion', from: '2026-01-01T00:00:00Z', by: 'promote', profile_sha: sha('pf'), ...over }
}

function notebook(id: string, seq: number, over: Partial<NotebookRow> = {}): NotebookRow {
  return {
    id, session_id: 'sess-1', seq, at: `2026-01-01T00:00:0${seq}Z`, kind: 'tool/call', name: 'ledger_view', args_sha: sha(`args-${id}`),
    operator: { provider: 'p', model: 'm' }, ...over,
  }
}

function experiment(over: Partial<ExperimentInput> = {}): ExperimentInput {
  return {
    hypothesis: 'shorter instructions solve more', prediction: { metric: 'solve', direction: 'up', magnitude: 0.05 }, pack: 'pk', gate: GATE,
    budget: { usd: 10, rounds: 3 }, created_by: { who: 'me', channel: 'cli' }, created_at: '2026-01-01T00:00:00Z', ...over,
  }
}

describe('evalConfigSha', () => {
  it('is a sha256 of the evaluation configuration, independent of key order and of coordinates', () => {
    const a = proposal()
    expect(evalConfigSha(a)).toMatch(/^[0-9a-f]{64}$/)
    expect(evalConfigSha({ ...a, tasksets: { holdout: sha('c'), holdin: sha('b'), smoke: sha('a') } })).toBe(evalConfigSha(a))
    expect(evalConfigSha({ ...a, patch_sha: sha('p2'), intent: 'other', route: { ...a.route, model_id: 'm2' } })).toBe(evalConfigSha(a))
    // The metric is the round's: a champion row first written without one and the round's recomputation agree.
    expect(evalConfigSha({ ...a, prediction: { metric: '', direction: 'up' } })).toBe(evalConfigSha(a))
    for (const over of [
      { pack: 'other' }, { scorer_version: '2' }, { task_version: 2 }, { truth_snapshot_id: sha('ts2') }, { report_rule_version: '2' },
      { judge_model_version: 'j1' }, { tasksets: { ...a.tasksets, holdout: sha('d') } },
    ]) expect(evalConfigSha({ ...a, ...over })).not.toBe(evalConfigSha(a))
    // A proposal without a pack hashes as pack ''.
    const { pack: _p, ...bare } = a
    expect(evalConfigSha(bare)).toBe(evalConfigSha({ ...a, pack: '' }))
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

  it('propose derives eval_config_sha from the row and the pack; the id does not depend on it', async () => {
    const h = await open(freshRoot())
    const id = await h.ledger.propose(proposal())
    expect(h.ledger.challenger(id)).toMatchObject({ pack: 'pk', eval_config_sha: evalConfigSha(proposal()) })
    // Same coordinates under another scorer: same id (dedupe), the first eval config stays.
    expect(await h.ledger.propose(proposal({ scorer_version: '2' }))).toBe(id)
    expect(h.ledger.challenger(id)?.eval_config_sha).toBe(evalConfigSha(proposal()))
    // Another patch under the same configuration: a different id, the same eval_config_sha (comparable).
    const sibling = await h.ledger.propose(proposal({ patch_sha: sha('p2') }))
    expect(sibling).not.toBe(id)
    expect(h.ledger.challenger(sibling)?.eval_config_sha).toBe(evalConfigSha(proposal()))
    // Without a pack the row lands with pack '' (the lifecycle service is what requires it).
    const { pack: _p, ...bare } = proposal({ patch_sha: sha('p3') })
    const legacy = await h.ledger.propose(bare)
    expect(h.ledger.challenger(legacy)).toMatchObject({ pack: '', eval_config_sha: evalConfigSha({ ...bare, pack: '' }) })
    await h.close()
  })

  it('setStatus: opened evidence, hold:superseded with a round id', async () => {
    const h = await open(freshRoot())
    const id = await h.ledger.propose(proposal())
    const opened = { harness_sha: sha('h2'), env_sha: sha('e2'), profile_sha: sha('pf'), at: '2026-01-01T00:00:01Z' }
    await h.ledger.setStatus(id, 'opened', { opened })
    expect(h.ledger.challenger(id)).toMatchObject({ status: 'opened', opened, harness_sha: sha('h') })
    await h.ledger.setStatus(id, 'judged', { verdict: { value: 'hold:superseded', by: 'gate-default@1', rule: 'round', round_id: 'r1' } })
    expect(h.ledger.challenger(id)?.verdict).toEqual({ value: 'hold:superseded', by: 'gate-default@1', rule: 'round', round_id: 'r1' })
    await expect(h.ledger.setStatus(id, 'reopened' as never)).rejects.toThrow()
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

  it('an attempt id belongs to one challenger: another challenger cannot take it over, the same one replaces its row', async () => {
    const h = await open(freshRoot())
    const a = await h.ledger.propose(proposal())
    const b = await h.ledger.propose(proposal({ patch_sha: sha('p2') }))
    await h.ledger.recordAttempt(attempt('a1', a, 'holdin'))
    await expect(h.ledger.recordAttempt(attempt('a1', b, 'holdin'))).rejects.toMatchObject({ name: 'LedgerError', code: 'ATTEMPT_EXISTS' })
    expect(h.ledger.attemptsOf(a)).toHaveLength(1)
    expect(h.ledger.attemptsOf(b)).toEqual([])
    await h.ledger.recordAttempt(attempt('a1', a, 'holdin', 'FAILED'))
    expect(h.ledger.attemptsOf(a)).toMatchObject([{ id: 'a1', status: 'FAILED' }])
    await h.close()
  })

  it('a row proposed with environment_sha keeps it, and an attempt records the environment it ran in', async () => {
    const h = await open(freshRoot())
    const plain = await h.ledger.propose(proposal())
    const c = await h.ledger.propose(proposal({ environment_sha: sha('env') }))
    expect(c).not.toBe(plain)
    expect(h.ledger.challenger(c)).toMatchObject({ environment_sha: sha('env') })
    expect(h.ledger.challenger(plain)?.environment_sha).toBeUndefined()
    const environment = {
      provider: 'docker', version: '1', image: { ref: 'img:1', digest: 'sha256:abc' },
      resources: { cpus: 2, memoryMb: 1024, timeoutS: 60 }, network: 'allowlist' as const, allowedHosts: ['example.test'],
    }
    await h.ledger.recordAttempt({ ...attempt('a1', c, 'holdin'), environment })
    expect(h.ledger.attemptsOf(c)).toMatchObject([{ id: 'a1', environment }])
    await h.ledger.recordAttempt(attempt('a2', c, 'holdin'))
    expect(h.ledger.attemptsOf(c).find((r) => r.id === 'a2')?.environment).toBeUndefined()
    await expect(h.ledger.recordAttempt({ ...attempt('a3', c, 'holdin'), environment: { ...environment, network: 'lan' } as never })).rejects.toThrow()
    await expect(h.ledger.recordAttempt({ ...attempt('a3', c, 'holdin'), environment: { ...environment, resources: {} } as never })).rejects.toThrow()
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
    // A different tier, truth snapshot or replicate count is a different verdict slot; a row without `replicates` counts as 1.
    await h.ledger.recordCompare(compare(c, { tier: 'holdout' }))
    await h.ledger.recordCompare(compare(c, { truth_snapshot_id: sha('ts2') }))
    await expect(h.ledger.recordCompare(compare(c, { replicates: 1 }))).rejects.toMatchObject({ code: 'VERDICT_EXISTS' })
    await h.ledger.recordCompare(compare(c, { replicates: 2, verdict: { value: 'drop', by: 'x', rule: 'y' } }))
    expect(h.ledger.comparesOf(c)).toHaveLength(4)
    expect(h.ledger.comparesOf(c).find((r) => r.replicates === 2)?.verdict.value).toBe('drop')
    await h.close()
  })

  it('recordCompare: a shadow verdict is keyed by its gate and sits beside the promotion verdict', async () => {
    const h = await open(freshRoot())
    const c = await h.ledger.propose(proposal())
    await h.ledger.recordCompare(compare(c))
    // The promotion gate's row keys the same with or without the fields (rows recorded before them read as the promotion gate's).
    expect(compareKey(compare(c, { gate: 'gate-default@1', shadow: false }))).toBe(compareKey(compare(c)))
    await expect(h.ledger.recordCompare(compare(c, { gate: 'gate-default@1', shadow: false }))).rejects.toMatchObject({ code: 'VERDICT_EXISTS' })
    const shadow = compare(c, { gate: 'keep-better@0.1.0', shadow: true, verdict: { value: 'promote', by: 'keep-better@0.1.0', rule: 'keep-better' } })
    expect(compareKey(shadow)).not.toBe(compareKey(compare(c)))
    await h.ledger.recordCompare(shadow)
    await h.ledger.recordCompare(compare(c, { gate: 'miller@0.1.0', shadow: true }))
    // One shadow slot per gate and replicate count.
    await expect(h.ledger.recordCompare(shadow)).rejects.toMatchObject({ code: 'VERDICT_EXISTS' })
    await h.ledger.recordCompare({ ...shadow, replicates: 2 })
    const rows = h.ledger.comparesOf(c)
    expect(rows).toHaveLength(4)
    expect(rows.filter((r) => r.shadow).map((r) => r.gate).sort()).toEqual(['keep-better@0.1.0', 'keep-better@0.1.0', 'miller@0.1.0'])
    expect(rows.find((r) => !r.shadow)?.verdict.value).toBe('hold')
    await h.close()
  })

  it('recordCompare keeps the round fields', async () => {
    const h = await open(freshRoot())
    const c = await h.ledger.propose(proposal())
    const row = compare(c, { round_id: 'r1', replicates: 2, min_effect: 0.05, sd_source: 'noise_floor', holm: { m: 3, rank: 2, alpha_adj: 0.025 } })
    await h.ledger.recordCompare(row)
    expect(h.ledger.comparesOf(c)).toEqual([row])
    await expect(h.ledger.recordCompare(compare(c, { tier: 'holdout', sd_source: 'champion' as never }))).rejects.toThrow()
    await h.close()
  })

  it('consents and settlements are immutable by id', async () => {
    const h = await open(freshRoot())
    const c = await h.ledger.propose(proposal())
    await h.ledger.recordConsent({ id: 'k1', challenger_id: c, action: 'promote', who: 'me', channel: 'socket', proof_sha: sha('pf'), at: 't' })
    await h.ledger.recordConsent({ id: 'k1', challenger_id: c, action: 'reject', who: 'me', channel: 'socket', proof_sha: sha('pf'), at: 't' })
    expect(h.ledger.consentsOf(c).map((r) => r.action)).toEqual(['promote'])
    for (const action of ['demote', 'eval_config_change', 'holdout_reveal'] as const) {
      await h.ledger.recordConsent({ id: `k-${action}`, challenger_id: c, action, who: 'me', channel: 'socket', proof_sha: sha('pf'), at: 't' })
    }
    expect(h.ledger.consentsOf(c).map((r) => r.action)).toEqual(['promote', 'demote', 'eval_config_change', 'holdout_reveal'])
    await expect(h.ledger.recordConsent({ id: 'k9', challenger_id: c, action: 'scorer_bump' as never, who: 'me', channel: 'socket', proof_sha: sha('pf'), at: 't' })).rejects.toThrow()
    // A gate_change consent's subject is the gate's name@version, not a challenger.
    await h.ledger.recordConsent({ id: 'k2', challenger_id: 'keep-better@0.1.0', action: 'gate_change', who: 'me', channel: 'socket', proof_sha: sha('pg'), at: 't' })
    expect(h.ledger.consentsOf('keep-better@0.1.0').map((r) => r.action)).toEqual(['gate_change'])
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
    // The held-out mean is rounded to two decimals, like the compare side of S7.
    for (const id of ['out3', 'out4', 'out5', 'out6', 'out7']) await h.ledger.recordAttempt(attempt(id, c, 'holdout'))
    await h.ledger.appendScores([score('out3', 1), score('out4', 0), score('out5', 0), score('out6', 0), score('out7', 0)])
    expect(h.ledger.read('scores', 'proposer').find((r) => 'redacted' in r && r.challenger_id === c)).toMatchObject({ n: 7, mean: 0.29 })
    await h.close()
  })

  it('proposer reads see held-out compares only as verdict + Ladder signal', async () => {
    const h = await open(freshRoot())
    const c = await h.ledger.propose(proposal())
    const holdin = compare(c)
    const holdout = compare(c, {
      tier: 'holdout', per_task: [{ task_id: 'ho1', delta: 0.1 }, { task_id: 'ho2', delta: 0.147 }], mean: 0.1235, ci: [0.01, 0.2],
      holm: { m: 3, rank: 1, alpha_adj: 0.0167 }, holdout_budget_remaining: 4, predicted_vs_observed: { fixes_hit: 1, at_risk_hit: 0 },
      ladder: { step: 0.031, beat_best: true, best_so_far: 0.0817 },
    })
    await h.ledger.recordCompare(holdin)
    await h.ledger.recordCompare(holdout)

    const compares = h.ledger.read('compares', 'proposer')
    expect(compares).toHaveLength(2)
    expect(compares.find((r) => !('redacted' in r))).toEqual(holdin)
    expect(compares.find((r) => 'redacted' in r)).toEqual({
      redacted: true, challenger_id: c, vs_id: 'champion', tier: 'holdout',
      method: 'paired', rule_fired: 'none', verdict: holdout.verdict, ladder: { beat_best: true, best_so_far: 0.08 },
    })
    const text = JSON.stringify(compares.filter((r) => 'redacted' in r))
    for (const leak of ['ho1', 'ho2', '0.1235', '0.12', '0.031', '0.0817', '"n"', 'mean', 'ci', 'mde', 'n_eff', 'holm', 'step', 'predicted_vs_observed', 'holdout_budget_remaining']) {
      expect(text).not.toContain(leak)
    }
    // A row without a Ladder output (recorded before the field, or by a gate without one) shows the verdict alone.
    const bare = compare(c, { tier: 'holdout', truth_snapshot_id: sha('ts2'), per_task: [{ task_id: 'ho3', delta: 1 }], mean: 1 })
    await h.ledger.recordCompare(bare)
    expect(h.ledger.read('compares', 'proposer').find((r) => 'redacted' in r && r.rule_fired === 'none' && !r.ladder)).toEqual({
      redacted: true, challenger_id: c, vs_id: 'champion', tier: 'holdout', method: 'paired', rule_fired: 'none', verdict: bare.verdict,
    })
    // gate and human see the row whole.
    expect(h.ledger.read('compares', 'gate')).toEqual(expect.arrayContaining([holdout]))
    expect(h.ledger.read('compares', 'human').find((r) => r.tier === 'holdout' && r.ladder)).toEqual(holdout)
    await h.close()
  })

  it('proposer reads cannot recover a sibling\'s held-out delta count from its aggregate', async () => {
    const h = await open(freshRoot())
    const champion = await h.ledger.propose(proposal())
    const siblings: [string, number][] = [[sha('s1'), 3], [sha('s2'), -2], [sha('s3'), 7], [sha('s4'), 0]]
    for (const [patch, wins] of siblings) {
      const id = await h.ledger.propose(proposal({ parent_ids: [champion], patch_sha: patch }))
      const per_task = Array.from({ length: 12 }, (_, i) => ({ task_id: `ho${i}`, delta: i < Math.abs(wins) ? Math.sign(wins) : 0 }))
      await h.ledger.recordCompare(compare(id, { vs_id: champion, tier: 'holdout', per_task, mean: wins / 12, ladder: { step: 0.1, beat_best: wins > 3, best_so_far: 0.25 } }))
    }
    const aggregates = h.ledger.read('compares', 'proposer').filter((r) => 'redacted' in r)
    expect(aggregates).toHaveLength(4)
    for (const a of aggregates) expect(Object.keys(a).sort()).toEqual(['challenger_id', 'ladder', 'method', 'redacted', 'rule_fired', 'tier', 'verdict', 'vs_id'])
    expect(aggregates.map((a) => a.ladder)).toEqual([
      { beat_best: false, best_so_far: 0.25 }, { beat_best: false, best_so_far: 0.25 }, { beat_best: true, best_so_far: 0.25 }, { beat_best: false, best_so_far: 0.25 },
    ])
    await h.close()
  })

  it('proposer reads never include a shadow compare row', async () => {
    const h = await open(freshRoot())
    const c = await h.ledger.propose(proposal())
    await h.ledger.recordCompare(compare(c, { tier: 'holdout', per_task: [{ task_id: 'ho1', delta: 1 }], mean: 1, gate: 'gate-default@1' }))
    await h.ledger.recordCompare(compare(c, { tier: 'holdout', per_task: [{ task_id: 'ho1', delta: 1 }], mean: 1, gate: 'keep-better@0.1.0', shadow: true, verdict: { value: 'promote', by: 'keep-better@0.1.0', rule: 'keep-better' } }))
    await h.ledger.recordCompare(compare(c, { gate: 'keep-better@0.1.0', shadow: true }))
    const compares = h.ledger.read('compares', 'proposer')
    expect(compares).toHaveLength(1)
    expect(compares[0]).toMatchObject({ redacted: true, tier: 'holdout', verdict: { value: 'hold' } })
    expect(JSON.stringify(compares)).not.toContain('keep-better')
    // gate and human still see the shadow rows.
    expect(h.ledger.read('compares', 'human').filter((r) => r.shadow)).toHaveLength(2)
    await h.close()
  })

  it('rounds: id from the coordinates, k follows the siblings, mutable fields only through updateRound', async () => {
    const h = await open(freshRoot())
    const r = await h.ledger.openRound(round())
    expect(r.id).toBe(roundId(round()))
    expect(r).toMatchObject({ status: 'open', k: 0, sibling_ids: [], champion_id: 'champion' })
    expect(roundId({ ...round(), experiment_id: 'x' })).not.toBe(r.id)
    expect(roundId({ ...round(), opened_at: '2026-01-02T00:00:00Z' })).not.toBe(r.id)
    // A duplicate open returns the stored row untouched.
    await h.ledger.updateRound(r.id, { sibling_ids: ['c1', 'c2'], best_so_far: 0.1 })
    expect(await h.ledger.openRound(round({ shadow_gates: [{ name: 'other', version: '0', policy_sha: sha('op') }] }))).toMatchObject({ id: r.id, k: 2, shadow_gates: [] })
    expect(h.ledger.round(r.id)).toMatchObject({ k: 2, sibling_ids: ['c1', 'c2'], best_so_far: 0.1 })
    const decided = await h.ledger.updateRound(r.id, { status: 'decided', closed_at: 't', outcome: { promoted: 'c1', superseded: ['c2'], consent_id: 'k1' } })
    expect(decided).toMatchObject({ status: 'decided', closed_at: 't', outcome: { promoted: 'c1', superseded: ['c2'], consent_id: 'k1' } })
    await expect(h.ledger.updateRound('missing', { status: 'judged' })).rejects.toMatchObject({ name: 'LedgerError', code: 'UNKNOWN_ROUND' })
    await expect(h.ledger.updateRound(r.id, { status: 'closed' as never })).rejects.toThrow()
    // roundsOf: this champion's rounds, oldest first; another champion's rounds are not in it.
    const later = await h.ledger.openRound(round({ opened_at: '2026-01-03T00:00:00Z', experiment_id: 'x', operator: { session_id: 's1' } }))
    const earlier = await h.ledger.openRound(round({ opened_at: '2025-12-31T00:00:00Z', noise_floor_id: 'nf' }))
    await h.ledger.openRound(round({ champion_id: 'other' }))
    expect(h.ledger.roundsOf('champion').map((x) => x.id)).toEqual([earlier.id, r.id, later.id])
    expect(h.ledger.round('missing')).toBeUndefined()
    await h.close()
  })

  it('noise floors: immutable by id, noiseFloorFor returns the latest for the tuple', async () => {
    const h = await open(freshRoot())
    const id = await h.ledger.recordNoiseFloor(noiseFloor())
    expect(id).toBe(noiseFloorId(noiseFloor()))
    expect(await h.ledger.recordNoiseFloor(noiseFloor({ sd_paired: 0.9 }))).toBe(id)
    expect(h.ledger.noiseFloorFor(sha('ec'), 'champion', 'l', 'solve')).toMatchObject({ id, sd_paired: 0.3, n_reruns: 3, n_tasks: 20, unit: 'entity', tier: 'holdin' })
    const newer = await h.ledger.recordNoiseFloor(noiseFloor({ measured_at: '2026-02-01T00:00:00Z', sd_paired: 0.2 }))
    await h.ledger.recordNoiseFloor(noiseFloor({ measured_at: '2026-01-15T00:00:00Z', sd_paired: 0.5 }))
    expect(newer).not.toBe(id)
    expect(h.ledger.noiseFloorFor(sha('ec'), 'champion', 'l', 'solve')?.id).toBe(newer)
    // Any other coordinate is another tuple.
    await h.ledger.recordNoiseFloor(noiseFloor({ measured_at: '2026-03-01T00:00:00Z', loop: 'l2' }))
    await h.ledger.recordNoiseFloor(noiseFloor({ measured_at: '2026-03-01T00:00:00Z', metric: 'cost' }))
    await h.ledger.recordNoiseFloor(noiseFloor({ measured_at: '2026-03-01T00:00:00Z', champion_id: 'other' }))
    await h.ledger.recordNoiseFloor(noiseFloor({ measured_at: '2026-03-01T00:00:00Z', eval_config_sha: sha('ec2') }))
    expect(h.ledger.noiseFloorFor(sha('ec'), 'champion', 'l', 'solve')?.id).toBe(newer)
    expect(h.ledger.noiseFloorFor(sha('ec'), 'champion', 'l', 'other')).toBeUndefined()
    await expect(h.ledger.recordNoiseFloor(noiseFloor({ sd_paired: -1 }))).rejects.toThrow()
    await h.close()
  })

  it('servings: immutable except closing `to`; servings() is oldest first', async () => {
    const h = await open(freshRoot())
    await h.ledger.recordServing(serving('s2', { from: '2026-02-01T00:00:00Z', champion_id: 'c2', consent_id: 'k1' }))
    await h.ledger.recordServing(serving('s1'))
    // Re-recording changes nothing but `to`; a closed serving stays closed.
    await h.ledger.recordServing(serving('s1', { champion_id: 'x', by: 'demote' }))
    expect(h.ledger.servings().map((r) => r.id)).toEqual(['s1', 's2'])
    expect(h.ledger.servings()[0]).toEqual(serving('s1'))
    await h.ledger.recordServing(serving('s1', { to: '2026-02-01T00:00:00Z' }))
    expect(h.ledger.servings()[0]).toEqual(serving('s1', { to: '2026-02-01T00:00:00Z' }))
    await h.ledger.recordServing(serving('s1', { to: '2026-03-01T00:00:00Z' }))
    await h.ledger.recordServing(serving('s1'))
    expect(h.ledger.servings()[0]?.to).toBe('2026-02-01T00:00:00Z')
    await h.ledger.recordServing(serving('s3', { from: '2026-03-01T00:00:00Z', by: 'reversed' }))
    expect(h.ledger.servings().map((r) => r.by)).toEqual(['promote', 'promote', 'reversed'])
    await expect(h.ledger.recordServing(serving('s4', { by: 'rollback' as never }))).rejects.toThrow()
    await h.close()
  })

  it('experiments: id from the pre-registered content, spent starts at zero, mutable fields only through updateExperiment', async () => {
    const h = await open(freshRoot())
    const e = await h.ledger.createExperiment(experiment())
    expect(e.id).toBe(experimentId(experiment()))
    expect(e).toMatchObject({ status: 'active', round_ids: [], spent: { usd: 0, attempts: 0, rounds: 0, holdout_reveals: 0 }, budget: { usd: 10, rounds: 3 } })
    expect(experimentId(experiment({ hypothesis: 'other' }))).not.toBe(e.id)
    expect(experimentId(experiment({ created_at: '2026-01-02T00:00:00Z' }))).not.toBe(e.id)
    expect(experimentId(experiment({ auto_reveal: true }))).not.toBe(e.id)
    // The budget is not in the id: the same pre-registration under another budget is the same experiment, and a raise keeps the id.
    expect(experimentId(experiment({ budget: { usd: 99 } }))).toBe(e.id)
    expect(await h.ledger.createExperiment(experiment({ budget: { usd: 99 } }))).toMatchObject({ id: e.id, budget: { usd: 10, rounds: 3 } })
    const raised = await h.ledger.updateExperiment(e.id, { budget: { usd: 20, rounds: 3 }, budget_changes: [{ at: 't1', session_id: 's', command_id: 'c', budget: { usd: 20, rounds: 3 } }] })
    expect(raised).toMatchObject({ id: e.id, budget: { usd: 20, rounds: 3 }, budget_changes: [{ at: 't1', session_id: 's', command_id: 'c', budget: { usd: 20, rounds: 3 } }] })
    // auto_reveal is pre-registered content: on the row, never through updateExperiment.
    const auto = await h.ledger.createExperiment(experiment({ auto_reveal: true, created_at: '2026-01-05T00:00:00Z' }))
    expect(auto).toMatchObject({ auto_reveal: true, budget: { usd: 10, rounds: 3 } })
    expect(h.ledger.experiment(auto.id)?.auto_reveal).toBe(true)
    expect(e.auto_reveal).toBeUndefined()
    await h.ledger.updateExperiment(e.id, { spent: { usd: 1.5, attempts: 20, rounds: 1, holdout_reveals: 0 }, round_ids: ['r1'] })
    // A duplicate create returns the stored row untouched.
    expect(await h.ledger.createExperiment(experiment())).toMatchObject({ id: e.id, round_ids: ['r1'], spent: { usd: 1.5 } })
    expect(h.ledger.experiment(e.id)?.spent.attempts).toBe(20)
    const closed = await h.ledger.updateExperiment(e.id, { status: 'closed', closed_at: 't' })
    expect(closed).toMatchObject({ status: 'closed', closed_at: 't', hypothesis: experiment().hypothesis })
    await expect(h.ledger.updateExperiment('missing', { status: 'closed' })).rejects.toMatchObject({ name: 'LedgerError', code: 'UNKNOWN_EXPERIMENT' })
    await expect(h.ledger.updateExperiment(e.id, { spent: { usd: 1 } as never })).rejects.toThrow()
    const earlier = await h.ledger.createExperiment(experiment({ created_at: '2025-12-01T00:00:00Z' }))
    expect(h.ledger.experiments().map((x) => x.id)).toEqual([earlier.id, e.id, auto.id])
    expect(h.ledger.experiment('missing')).toBeUndefined()
    await h.close()
  })

  it('proposer reads never receive rounds, noise floors or experiments', async () => {
    const h = await open(freshRoot())
    await h.ledger.openRound(round())
    await h.ledger.recordNoiseFloor(noiseFloor())
    await h.ledger.createExperiment(experiment())
    await h.ledger.recordServing(serving('s1'))
    for (const view of ['rounds', 'noise_floors', 'experiments'] as const) {
      expect(h.ledger.read(view, 'proposer')).toEqual([])
      expect(h.ledger.read(view, 'gate')).toHaveLength(1)
      expect(h.ledger.read(view, 'human')).toHaveLength(1)
    }
    expect(h.ledger.read('servings', 'proposer')).toEqual([serving('s1')])
    await h.close()
  })

  it('operator reads: attempts and scores as a proposer, compares whole minus per_task on every tier, operator objects whole', async () => {
    const h = await open(freshRoot())
    const c = await h.ledger.propose(proposal())
    await h.ledger.recordAttempt(attempt('a1', c, 'holdin'))
    await h.ledger.recordAttempt(attempt('a2', c, 'holdout'))
    await h.ledger.appendScores([score('a1', 1), score('a2', 0.5)])
    const holdin = compare(c)
    const holdout = compare(c, {
      tier: 'holdout', per_task: [{ task_id: 'ho1', delta: 0.1 }, { task_id: 'ho2', delta: 0.147 }], mean: 0.1235, ci: [0.01, 0.2],
      holm: { m: 3, rank: 1, alpha_adj: 0.0167 }, holdout_budget_remaining: 4, ladder: { step: 0.031, beat_best: true, best_so_far: 0.0817 },
    })
    const shadow = compare(c, { tier: 'holdout', per_task: [{ task_id: 'ho1', delta: 1 }], mean: 1, gate: 'keep-better@0.1.0', shadow: true })
    for (const row of [holdin, holdout, shadow]) await h.ledger.recordCompare(row)
    await h.ledger.openRound(round())
    await h.ledger.recordNoiseFloor(noiseFloor())
    await h.ledger.createExperiment(experiment())
    await h.ledger.recordServing(serving('s1'))
    await h.ledger.recordConsent({ id: 'k1', challenger_id: c, action: 'promote', who: 'me', channel: 'socket', proof_sha: sha('pf'), at: 't' })

    expect(h.ledger.read('attempts', 'operator')).toEqual(h.ledger.read('attempts', 'proposer'))
    expect(h.ledger.read('scores', 'operator')).toEqual(h.ledger.read('scores', 'proposer'))
    expect(h.ledger.read('attempts', 'operator').filter((a) => 'redacted' in a)).toHaveLength(1)

    const compares = h.ledger.read('compares', 'operator')
    expect(compares).toHaveLength(3)
    for (const row of [holdin, holdout, shadow]) {
      const { per_task, ...rest } = row
      expect(compares).toContainEqual(rest)
    }
    const text = JSON.stringify(compares)
    expect(text).not.toContain('per_task')
    for (const leak of ['ho1', 'ho2', 't1']) expect(text).not.toContain(leak)
    // The unrounded holdout figures and the shadow row stay: the operator is the human's side of the line.
    expect(text).toContain('0.1235')
    expect(text).toContain('keep-better')
    expect(h.ledger.read('compares', 'human').filter((r) => 'per_task' in r)).toHaveLength(3)

    for (const view of ['rounds', 'noise_floors', 'experiments', 'servings', 'consents', 'challengers'] as const) {
      expect(h.ledger.read(view, 'operator')).toEqual(h.ledger.read(view, 'human'))
      expect(h.ledger.read(view, 'operator')).toHaveLength(1)
    }
    await h.close()
  })

  it('notebook: append-only by id, notebookOf is one session in seq order, never rendered to a proposer', async () => {
    const h = await open(freshRoot())
    expect(await h.ledger.recordNotebook(notebook('n2', 2, { kind: 'tool/result', result_sha: sha('r'), round_id: 'r1' }))).toBe('n2')
    await h.ledger.recordNotebook(notebook('n1', 1))
    await h.ledger.recordNotebook(notebook('n3', 0, { session_id: 'sess-2', kind: 'command/run', name: 'samsara', experiment_id: 'e1', operator: {} }))
    // Re-recording an id is a no-op: the first row stands.
    await h.ledger.recordNotebook(notebook('n1', 9, { name: 'other' }))
    expect(h.ledger.notebookOf('sess-1')).toEqual([notebook('n1', 1), notebook('n2', 2, { kind: 'tool/result', result_sha: sha('r'), round_id: 'r1' })])
    expect(h.ledger.notebookOf('sess-2')).toMatchObject([{ id: 'n3', kind: 'command/run', experiment_id: 'e1', operator: {} }])
    expect(h.ledger.notebookOf('missing')).toEqual([])
    expect(h.ledger.read('notebook', 'proposer')).toEqual([])
    expect(h.ledger.read('notebook', 'operator')).toHaveLength(3)
    expect(h.ledger.read('notebook', 'human')).toHaveLength(3)
    // A row outside the schema never reaches the medium.
    await expect(h.ledger.recordNotebook({ ...notebook('n4', 4), kind: 'chat' } as unknown as NotebookRow)).rejects.toThrow()
    await expect(h.ledger.recordNotebook({ ...notebook('n5', -1) })).rejects.toThrow()
    expect(h.ledger.read('notebook', 'human')).toHaveLength(3)
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
    const r = await a.ledger.openRound(round({ champion_id: c }))
    await a.ledger.updateRound(r.id, { sibling_ids: [c] })
    await a.ledger.recordNoiseFloor(noiseFloor({ champion_id: c }))
    await a.ledger.recordServing(serving('s1', { champion_id: c }))
    const e = await a.ledger.createExperiment(experiment())
    await a.ledger.updateExperiment(e.id, { round_ids: [r.id] })
    const raise = { at: 't2', session_id: 'sess-1', command_id: 'cmd-1', budget: { usd: 20, rounds: 3 } }
    await a.ledger.updateExperiment(e.id, { budget: raise.budget, budget_changes: [raise] })
    await a.ledger.recordNotebook(notebook('n1', 1, { round_id: r.id }))
    const views = ['challengers', 'attempts', 'scores', 'compares', 'consents', 'settlements', 'rounds', 'noise_floors', 'servings', 'experiments', 'notebook'] as const
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
    expect((await b.ledger.openRound(round({ champion_id: c }))).k).toBe(1)
    expect(b.ledger.noiseFloorFor(sha('ec'), c, 'l', 'solve')?.id).toBe(noiseFloorId(noiseFloor({ champion_id: c })))
    expect(b.ledger.experiment(e.id)?.round_ids).toEqual([r.id])
    // A raised budget and who raised it when survive the reload; the id still names the pre-registered budget.
    expect(b.ledger.experiment(e.id)).toMatchObject({ id: experimentId(experiment()), budget: { usd: 20, rounds: 3 }, budget_changes: [raise] })
    expect(b.ledger.notebookOf('sess-1')).toMatchObject([{ id: 'n1', round_id: r.id }])
    await b.close()
  })

  it('E6: backupSqlite copies a live sqlite file with the online backup API', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ledger-backup-'))
    dirs.push(root)
    const source = join(root, 'ledger.sqlite')
    const live = new DatabaseSync(source)
    live.exec('create table rows (k text primary key, v text)')
    live.prepare('insert into rows values (?, ?)').run('a', '1')
    const pages = await backupSqlite(source, join(root, 'copy.sqlite'))
    expect(pages).toBeGreaterThan(0)
    live.prepare('insert into rows values (?, ?)').run('b', '2')
    live.close()
    const copy = new DatabaseSync(join(root, 'copy.sqlite'), { readOnly: true })
    expect(copy.prepare('select k from rows order by k').all()).toEqual([{ k: 'a' }])
    copy.close()
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
