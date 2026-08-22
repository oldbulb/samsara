import { describe, expect, it } from 'vitest'
import type { AttemptRow, ChallengerProposal, ScoreRow } from '@samsara/ledger'
import { sha256 } from '@samsara/ledger'
import { challengerProposalOf, scoredAttemptsOf, GATE_PERMISSIVE } from '../src/challenge.ts'
import { resolve } from 'node:path'

const MINI_SKILL = resolve(import.meta.dirname, '..', '..', 'pack', 'tests', 'fixtures', 'minipack', 'skill')
const Z = sha256('')

function attempt(id: string, task: string, sample: number, over: Partial<AttemptRow> = {}): AttemptRow {
  return {
    id, challenger_id: 'c', task_id: task, sample, loop: 'null', tier: 'smoke', status: 'COMPLETED', stop_reason: 'completed',
    facts_sha: '', usage: { input_tokens: 3, output_tokens: 4 }, cost: {}, output: { source: 'file', valid: false }, artifacts: [], ...over,
  }
}

describe('scoredAttemptsOf', () => {
  const tasks = new Map([['t1', 'e1'], ['t2', 'e2']])
  const scores = (id: string): ScoreRow[] => id === 'none' ? [] : [
    { attempt_id: id, scorer_version: '1', truth_snapshot_id: 's', metric: 'm', value: id.startsWith('r2') ? 1 : 0, kind: 'reality', stratum: 'x' },
    { attempt_id: id, scorer_version: '1', truth_snapshot_id: 's', metric: 'other', value: 9, kind: 'mechanical' },
  ]
  it('keeps the latest (run ids sort by time) attempt per (task, sample), joins the primary metric, skips unknown tasks and unscored attempts', () => {
    const rows = scoredAttemptsOf([
      attempt('r1-t1-0', 't1', 0),
      attempt('r2-t1-0', 't1', 0, { cost: { usd: 0.5, tokens: 100 } }),
      attempt('r1-t2-0', 't2', 0),
      attempt('none', 't2', 1),
      attempt('x', 't9', 0),
    ], scores, tasks, 'm')
    expect(rows.map((r) => r.attemptId).sort()).toEqual(['r1-t2-0', 'r2-t1-0'])
    const t1 = rows.find((r) => r.taskId === 't1')!
    expect(t1).toMatchObject({ entityKey: 'e1', stratum: 'x', metric: 'm', value: 1, kind: 'reality', cost: { usd: 0.5, tokens: 100 }, valid: false })
    expect(rows.find((r) => r.taskId === 't2')!.cost).toEqual({ tokens: 7 })
  })
})

describe('challengerProposalOf', () => {
  const champion: ChallengerProposal = {
    parent_ids: [], patch_sha: Z, harness_sha: Z, env_sha: Z, skill_sha: Z, taskset_sha: Z,
    route: { loop: 'null', loop_adapter_version: 'null@0', model_id: 'm', model_pool_sha: Z, base_url_kind: 'direct' },
    optimizer_config_sha: Z, lineage: 'main', surface: 'skill', patch: { skill_ref: `skill:${Z}` }, intent: 'champion',
    prediction: { metric: '', direction: 'up' }, scorer_version: '1', task_version: 1, truth_snapshot_id: Z, report_rule_version: '0',
    runtime: { timeout_s: 1, step_cap: 1 }, tasksets: { smoke: Z, holdin: Z, holdout: Z }, budget: 0,
  }
  const req = {
    pack: 'p', loop: 'null', set: 'smoke' as const, repeat: 1, out: 'o', maxTurns: 1, maxMinutes: 1,
    surface: 'skill' as const, skillDir: MINI_SKILL, intent: 'i', metric: 'm', nEffFloor: 3, withChampion: false, gatePolicy: 'default' as const,
  }
  it('is the champion with the snapshot as patch, the champion as parent and the metric as prediction', () => {
    const p = challengerProposalOf(champion, 'parent', req)
    expect(p.parent_ids).toEqual(['parent'])
    expect(p.skill_sha).toMatch(/^[0-9a-f]{64}$/)
    expect(p.patch_sha).toBe(p.skill_sha)
    expect(p.skill_sha).not.toBe(Z)
    expect(p.patch).toEqual({ skill_ref: MINI_SKILL, before: `skill:${Z}` })
    expect(p.intent).toBe('i')
    expect(p.prediction).toEqual({ metric: 'm', direction: 'up' })
    expect(p.harness_sha).toBe(champion.harness_sha)
  })
})

describe('GATE_PERMISSIVE', () => {
  it('is labelled as a test policy and never the default name', () => {
    expect(`${GATE_PERMISSIVE.name}@${GATE_PERMISSIVE.version}`).toBe('gate-permissive@test')
  })
})
