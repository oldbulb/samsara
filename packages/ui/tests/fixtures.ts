// A fake ledger / champion / signoff for the API builders: plain arrays behind
// the UiDeps slices, with one promoted champion, one judged challenger and a
// held-out attempt so the human view is exercised end to end.
import { createHash } from 'node:crypto'
import type { ChampionState } from '@oldbulb/samsara-champion'
import type { AttemptRow, ChallengerRow, CompareRow, ConsentRow, ScoreRow, SettlementRow, View, ViewRows, Viewer } from '@oldbulb/samsara-ledger'
import type { UiDeps } from '../src/api.ts'

export const sha = (s: string) => createHash('sha256').update(s).digest('hex')
export const CHAMP = sha('champion')
export const CHAL = sha('challenger')
export const SKILL = sha('skill')

function challenger(id: string, patch: Partial<ChallengerRow>): ChallengerRow {
  return {
    id, parent_ids: [], patch_sha: sha(`patch-${id}`), harness_sha: sha('h'), env_sha: sha('e'), skill_sha: SKILL, taskset_sha: sha('t'),
    route: { loop: 'dsh', loop_adapter_version: '1', model_id: 'm1', model_pool_sha: sha('pool'), base_url_kind: 'external' },
    optimizer_config_sha: sha('opt'), lineage: 'main', surface: 'skill', patch: { skill_ref: '/skills/x' },
    intent: 'first line\nsecond line', prediction: { metric: 'acc', direction: 'up', predicted_fixes: ['t1'], at_risk: ['t2'] },
    scorer_version: 's1', task_version: 1, truth_snapshot_id: 'truth-1', report_rule_version: 'r1', runtime: { timeout_s: 10, step_cap: 5 },
    tasksets: { smoke: sha('ts'), holdin: sha('ti'), holdout: sha('to') }, budget: 1, status: 'proposed', proposed_at: '2026-01-01T00:00:00Z',
    ...patch,
  }
}

function attempt(id: string, challenger_id: string, task_id: string, tier: AttemptRow['tier'], usd: number, extra: Partial<AttemptRow> = {}): AttemptRow {
  return {
    id, challenger_id, task_id, sample: 0, loop: 'dsh', tier, status: 'COMPLETED', stop_reason: 'submit', facts_sha: 'facts-a',
    usage: { input_tokens: 1, output_tokens: 1 }, cost: { usd }, output: { source: 'submit', valid: true }, artifacts: [], ...extra,
  }
}

export const challengers: ChallengerRow[] = [
  challenger(CHAMP, { status: 'decided', tier_reached: 'holdin', verdict: { value: 'promote', by: 'gate-default@1', rule: 'ci>0', consent_id: 'consent-1' }, proposed_at: '2025-12-01T00:00:00Z' }),
  challenger(CHAL, { parent_ids: [CHAMP], status: 'judged', verdict: { value: 'hold', by: 'gate-default@1', rule: 'underpowered' } }),
]
export const attempts: AttemptRow[] = [
  attempt('a1', CHAMP, 't1', 'holdin', 1.0),
  attempt('a2', CHAL, 't1', 'holdin', 1.5, { skill_utilization: { utilization: 0.5 } }),
  attempt('a3', CHAL, 't2', 'holdout', 2.0, { status: 'TRUNCATED' }),
]
export const scores: ScoreRow[] = [
  { attempt_id: 'a1', scorer_version: 's1', truth_snapshot_id: 'truth-1', metric: 'acc', value: 0.5, kind: 'reality' },
  { attempt_id: 'a2', scorer_version: 's1', truth_snapshot_id: 'truth-1', metric: 'acc', value: 0.7, kind: 'reality' },
  { attempt_id: 'a3', scorer_version: 's1', truth_snapshot_id: 'truth-1', metric: 'acc', value: 0.9, kind: 'reality' },
]
export const compares: CompareRow[] = [{
  challenger_id: CHAL, vs_id: CHAMP, tier: 'holdin', truth_snapshot_id: 'truth-1', per_task: [{ task_id: 't1', delta: 0.2 }],
  mean: 0.2, ci: [-0.1, 0.5], method: 'bca', cluster_key: 'entity', n_eff: 1, mde: 0.3, rule_fired: 'underpowered',
  verdict: { value: 'hold', by: 'gate-default@1', rule: 'underpowered' }, predicted_vs_observed: { fixes_hit: 1, at_risk_hit: 0 }, at: '2026-01-02T00:00:00Z',
}]
export const consents: ConsentRow[] = [{ id: 'consent-1', challenger_id: CHAMP, action: 'promote', who: 'me', channel: 'unix-socket', proof_sha: sha('p'), at: '2025-12-02T00:00:00Z' }]
export const settlements: SettlementRow[] = [
  { id: 'settle-1', kind: 'truth', taskset_sha: sha('t'), as_of: '2026-01-01T00:00:00Z', truth_snapshot_id: 'truth-1', n_settled: 3, n_pending: 1, triggered_rescoring: [CHAMP] },
]

export const championState: ChampionState = {
  rows: [`skill:${SKILL}`], skill_ref: '/store/skill', profilePatchRows: [],
  kept: [{ challenger_id: CHAMP, surface: 'skill', ref: `skill:${SKILL}`, rows: [], skill_ref: '/store/skill', consent_id: 'consent-1', promoted_at: '2025-12-03T00:00:00Z' }],
}

export function fakeDeps(): UiDeps {
  const tables = { challengers, attempts, scores, compares, consents, settlements }
  const byId = new Map(challengers.map((c) => [c.id, c]))
  return {
    ledger: {
      read<N extends View>(view: N, _viewer: Viewer) { return [...tables[view]] as ViewRows[N] },
      challenger: (id) => byId.get(id),
      lineage(id) {
        const out: ChallengerRow[] = []
        for (let cur = byId.get(id); cur; cur = cur.parent_ids[0] ? byId.get(cur.parent_ids[0]) : undefined) out.push(cur)
        return out
      },
    },
    champion: { current: () => championState, replayCheck: () => ({ equal: true, missingInFile: [], extraInFile: [] }) },
    signoff: {
      pending: () => [{ nonce: 'n', rowId: CHAL, action: 'promote', expiresAt: '2026-01-03T00:00:00Z' }],
      socketPath: '/tmp/signoff.sock',
    },
  }
}
