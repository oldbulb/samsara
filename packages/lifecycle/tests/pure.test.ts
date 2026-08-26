import { describe, expect, it } from 'vitest'
import { gatePolicy } from '@oldbulb/samsara-gate'
import { evalConfigSha, type ChallengerRow, type CompareRow } from '@oldbulb/samsara-ledger'
import { comparable, gateRefOf, nextActionsOf, policySha, roundPolicy } from '../src/index.ts'
import { championProposal, sha } from './fakes.ts'

function row(over: Partial<ChallengerRow> = {}): ChallengerRow {
  const p = { ...championProposal(), pack: 'fixture', prediction: { metric: 'm', direction: 'up' as const }, ...over }
  return { ...p, id: over.id ?? sha('row'), eval_config_sha: evalConfigSha(p), status: 'proposed', proposed_at: 'now', ...over }
}

describe('comparable (rule 0)', () => {
  const champion = row({ id: sha('champion') })

  it('equal coordinates are comparable, and the allowed coordinates may differ', () => {
    expect(comparable(champion, champion)).toEqual({ ok: true })
    const challenger = row({ id: sha('c'), parent_ids: [champion.id], patch_sha: sha('p'), skill_sha: sha('p'), optimizer_config_sha: sha('o') })
    expect(comparable(challenger, champion)).toEqual({ ok: true })
  })

  it('reports the first strict coordinate that differs, in order', () => {
    expect(comparable(row({ harness_sha: sha('x') }), champion)).toEqual({ ok: false, coordinate: 'harness_sha' })
    expect(comparable(row({ env_sha: sha('x') }), champion)).toEqual({ ok: false, coordinate: 'env_sha' })
    expect(comparable(row({ taskset_sha: sha('x') }), champion)).toEqual({ ok: false, coordinate: 'taskset_sha' })
    expect(comparable(row({ route: { ...champion.route, model_id: 'other' } }), champion)).toEqual({ ok: false, coordinate: 'route' })
    expect(comparable(row({ surface: 'tools' }), champion)).toEqual({ ok: false, coordinate: 'surface' })
    expect(comparable(row({ runtime: { timeout_s: 1, step_cap: 5 } }), champion)).toEqual({ ok: false, coordinate: 'runtime' })
    // Two differences: the earlier coordinate is the one named.
    expect(comparable(row({ env_sha: sha('x'), route: { ...champion.route, model_id: 'other' } }), champion)).toEqual({ ok: false, coordinate: 'env_sha' })
  })

  it('environment_sha must be equal: absent on both is equal, absent on one or different is not', () => {
    expect(comparable(row({ environment_sha: sha('env') }), champion)).toEqual({ ok: false, coordinate: 'environment_sha' })
    expect(comparable(champion, row({ environment_sha: sha('env') }))).toEqual({ ok: false, coordinate: 'environment_sha' })
    const inEnv = row({ id: sha('in-env'), environment_sha: sha('env') })
    expect(comparable(row({ environment_sha: sha('env'), patch_sha: sha('p') }), inEnv)).toEqual({ ok: true })
    expect(comparable(row({ environment_sha: sha('other') }), inEnv)).toEqual({ ok: false, coordinate: 'environment_sha' })
    // Reported after env_sha, before taskset_sha.
    expect(comparable(row({ env_sha: sha('x'), environment_sha: sha('env') }), champion)).toEqual({ ok: false, coordinate: 'env_sha' })
    expect(comparable(row({ environment_sha: sha('env'), taskset_sha: sha('x') }), champion)).toEqual({ ok: false, coordinate: 'environment_sha' })
  })

  it('skill_sha may differ only on the skill surface', () => {
    const tools = row({ surface: 'tools' })
    expect(comparable(row({ surface: 'tools', skill_sha: sha('x') }), tools)).toEqual({ ok: false, coordinate: 'skill_sha' })
    expect(comparable(row({ surface: 'tools' }), tools)).toEqual({ ok: true })
  })

  it('the evaluation configuration must be equal; a row without the sha is recomputed from its fields', () => {
    expect(comparable(row({ pack: 'other' }), champion)).toEqual({ ok: false, coordinate: 'eval_config_sha' })
    expect(comparable(row({ scorer_version: '9' }), champion)).toEqual({ ok: false, coordinate: 'eval_config_sha' })
    // The metric is the round's, not the row's configuration.
    expect(comparable(row({ prediction: { metric: 'other', direction: 'up' } }), champion)).toEqual({ ok: true })
    const { eval_config_sha: _drop, ...legacy } = champion
    expect(comparable(legacy as ChallengerRow, champion)).toEqual({ ok: true })
  })
})

describe('policy sha', () => {
  it('is a function of the policy values, not of key order, and the ref carries name and version', () => {
    const a = gatePolicy({ nEffFloor: 3, mde: 0.1 })
    const b = { mde: 0.1, ...gatePolicy({ nEffFloor: 3 }) }
    expect(policySha(a)).toMatch(/^[0-9a-f]{64}$/)
    expect(policySha(a)).toBe(policySha(b))
    expect(policySha(a)).not.toBe(policySha(gatePolicy({ nEffFloor: 4, mde: 0.1 })))
    expect(policySha(roundPolicy(3, 0.1))).toBe(policySha(a))
    expect(policySha(roundPolicy(3, undefined))).toBe(policySha(gatePolicy({ nEffFloor: 3 })))
    expect(gateRefOf({ name: 'g', version: '1' }, a)).toEqual({ name: 'g', version: '1', policy_sha: policySha(a) })
  })
})

describe('nextActionsOf', () => {
  const compare = { rule_fired: 'screen', mde: 0.05, n_eff: 4, replicates: 1, min_effect: 0.1 } as CompareRow
  const taskCounts = { smoke: 2, holdin: 4, holdout: 4 }

  it('names the next transition for a row that is not judged', () => {
    expect(nextActionsOf({ row: row(), taskCounts })).toEqual([{ kind: 'open' }])
    expect(nextActionsOf({ row: row({ status: 'opened' }), taskCounts })).toEqual([{ kind: 'run', tier: 'smoke' }])
    expect(nextActionsOf({ row: row({ status: 'running', tier_reached: 'holdin' }), taskCounts })).toEqual([{ kind: 'judge', tier: 'holdin' }])
    expect(nextActionsOf({ row: row({ status: 'decided' }), taskCounts })).toEqual([])
  })

  it('a held row can replicate, go to holdout (with the budget) or drop, with the numbers the rule used and a cost estimate', () => {
    const held = row({ status: 'judged', tier_reached: 'holdin', verdict: { value: 'hold', by: 'g', rule: 'screen' } })
    const actions = nextActionsOf({ row: held, compare, sd: 0.2, taskCounts, meanUsd: 0.01, budget: { remaining: 2, spent: 0 } })
    const numbers = { rule: 'screen', mde: 0.05, n_eff: 4, replicates: 1, min_effect: 0.1, sd: 0.2 }
    expect(actions).toEqual([
      { kind: 'replicate', tier: 'holdin', estimate: { attempts: 4, usd: 0.04 }, numbers },
      { kind: 'holdout', tier: 'holdout', estimate: { attempts: 4, usd: 0.04 }, numbers, budget: { remaining: 2, spent: 0 } },
      { kind: 'drop' },
    ])
    // Without a known cost the estimate is attempts only; at holdout there is no further tier.
    const atHoldout = row({ status: 'judged', tier_reached: 'holdout', verdict: { value: 'hold', by: 'g', rule: 'holdout' } })
    expect(nextActionsOf({ row: atHoldout, taskCounts })).toEqual([{ kind: 'replicate', tier: 'holdout', estimate: { attempts: 4 } }, { kind: 'drop' }])
  })

  it('a promote verdict waits for the decision; drop and invalid are done', () => {
    expect(nextActionsOf({ row: row({ status: 'judged', tier_reached: 'holdout', verdict: { value: 'promote', by: 'g', rule: 'holdout' } }), taskCounts })).toEqual([{ kind: 'decide' }])
    expect(nextActionsOf({ row: row({ status: 'judged', tier_reached: 'holdin', verdict: { value: 'drop', by: 'g', rule: 'futility' } }), taskCounts })).toEqual([])
    expect(nextActionsOf({ row: row({ status: 'judged', tier_reached: 'smoke', verdict: { value: 'invalid', by: 'g', rule: 'type:no-data' } }), taskCounts })).toEqual([])
  })
})
