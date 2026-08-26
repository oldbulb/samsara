// A fake ledger / champion / signoff / lifecycle for the page and API
// builders: plain arrays behind the UiDeps slices, read the way the real
// ledger answers the `operator` viewer (held-out attempts and scores as
// aggregates, compares without per-task deltas) and whole for any other. One
// experiment of three rounds: round 1 promoted CHAMP over ROOT, round 2 held
// CHAL underpowered (with a shadow verdict by a second gate) and waits on a
// sign-off, the promotion gate changed by consent before round 3, which is
// open with CHAL2 running.
import { createHash } from 'node:crypto'
import type { ChampionState } from '@oldbulb/samsara-champion'
import type { AttemptAggregate, AttemptRow, ChallengerRow, CompareRow, ConsentRow, ExperimentRow, NoiseFloorRow, NotebookRow, RoundRow, ScoreAggregate, ScoreRow, ServingRow, SettlementRow, View, ViewRows, Viewer } from '@oldbulb/samsara-ledger'
import type { NextAction } from '@oldbulb/samsara-lifecycle'
import type { UiDeps } from '../src/api.ts'

export const sha = (s: string) => createHash('sha256').update(s).digest('hex')
export const ROOT = sha('root')
export const CHAMP = sha('champion')
export const CHAL = sha('challenger')
export const CHAL2 = sha('challenger-2')
export const SKILL = sha('skill')
export const EVAL = sha('eval')
export const EXP = sha('experiment')
export const ROUND1 = sha('round-1')
export const ROUND2 = sha('round-2')
export const ROUND3 = sha('round-3')
export const FLOOR1 = sha('floor-1')
export const FLOOR2 = sha('floor-2')
export const SESSION = 'sess-1'

const GATE1 = { name: 'gate-default', version: '1', policy_sha: sha('policy-1') }
const GATE2 = { name: 'gate-default', version: '2', policy_sha: sha('policy-2') }
const SHADOW = { name: 'keep-better', version: '0.1.0', policy_sha: sha('policy-kb') }

function challenger(id: string, patch: Partial<ChallengerRow>): ChallengerRow {
  return {
    id, parent_ids: [], patch_sha: sha(`patch-${id}`), harness_sha: sha('h'), env_sha: sha('e'), skill_sha: SKILL, taskset_sha: sha('t'),
    route: { loop: 'dsh', loop_adapter_version: '1', model_id: 'm1', model_pool_sha: sha('pool'), base_url_kind: 'external' },
    optimizer_config_sha: sha('opt'), lineage: 'main', surface: 'skill', patch: { skill_ref: '/skills/x' }, pack: 'pack-x', eval_config_sha: EVAL,
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
  // The first champion: another skill, so the certification of SKILL does not count it.
  challenger(ROOT, { status: 'decided', tier_reached: 'holdout', skill_sha: sha('skill-0'), patch: { skill_ref: '/skills/root' }, verdict: { value: 'promote', by: 'gate-default@1', rule: 'ci>0' }, proposed_at: '2025-11-01T00:00:00Z' }),
  challenger(CHAMP, { parent_ids: [ROOT], status: 'decided', tier_reached: 'holdin', verdict: { value: 'promote', by: 'gate-default@1', rule: 'ci>0', consent_id: 'consent-1', round_id: ROUND1 }, proposed_at: '2025-12-01T00:00:00Z' }),
  challenger(CHAL, { parent_ids: [CHAMP], status: 'judged', verdict: { value: 'hold', by: 'gate-default@1', rule: 'power:nEff', round_id: ROUND2 } }),
  // Round 3, open: running on holdin under the changed gate, another skill.
  challenger(CHAL2, { parent_ids: [CHAMP], status: 'running', tier_reached: 'holdin', skill_sha: sha('skill-2'), patch: { skill_ref: '/skills/y' }, intent: 'third try', proposed_at: '2026-01-05T00:00:00Z' }),
]
export const attempts: AttemptRow[] = [
  attempt('a1', CHAMP, 't1', 'holdin', 1.0),
  attempt('a2', CHAL, 't1', 'holdin', 1.5, { skill_utilization: { value: 0.5 } }),
  attempt('a3', CHAL, 't2', 'holdout', 2.0, { status: 'TRUNCATED' }),
  attempt('a4', CHAL2, 't1', 'holdin', 1.2),
]
export const scores: ScoreRow[] = [
  { attempt_id: 'a1', scorer_version: 's1', truth_snapshot_id: 'truth-1', metric: 'acc', value: 0.5, kind: 'reality' },
  { attempt_id: 'a2', scorer_version: 's1', truth_snapshot_id: 'truth-1', metric: 'acc', value: 0.7, kind: 'reality' },
  { attempt_id: 'a3', scorer_version: 's1', truth_snapshot_id: 'truth-1', metric: 'acc', value: 0.9, kind: 'reality' },
  { attempt_id: 'a4', scorer_version: 's1', truth_snapshot_id: 'truth-1', metric: 'acc', value: 0.6, kind: 'reality' },
]
export const compares: CompareRow[] = [{
  challenger_id: CHAL, vs_id: CHAMP, tier: 'holdin', truth_snapshot_id: 'truth-1', per_task: [{ task_id: 't1', delta: 0.2 }],
  mean: 0.2, ci: [-0.1, 0.5], method: 'bca', cluster_key: 'entity', n_eff: 1, mde: 0.3, rule_fired: 'power:nEff', round_id: ROUND2, replicates: 1, min_effect: 0.05, sd_source: 'noise_floor',
  verdict: { value: 'hold', by: 'gate-default@1', rule: 'power:nEff' }, predicted_vs_observed: { fixes_hit: 1, at_risk_hit: 0 }, at: '2026-01-02T00:00:00Z',
}, {
  // A shadow judgement by another gate, recorded later: listed beside the verdict, never the verdict.
  challenger_id: CHAL, vs_id: CHAMP, tier: 'holdin', truth_snapshot_id: 'truth-1', per_task: [{ task_id: 't1', delta: 0.2 }],
  mean: 0.2, ci: [0.05, 0.35], method: 'paired', cluster_key: 'entity', n_eff: 1, mde: 0.3, rule_fired: 'keep-better', round_id: ROUND2, replicates: 1, min_effect: 0.05, sd_source: 'noise_floor',
  verdict: { value: 'promote', by: 'keep-better@0.1.0', rule: 'keep-better' }, gate: 'keep-better@0.1.0', shadow: true, at: '2026-01-03T00:00:00Z',
}, {
  // Round 1: CHAMP over ROOT at holdin first (the curve's tier), then the promotion at holdout.
  challenger_id: CHAMP, vs_id: ROOT, tier: 'holdin', truth_snapshot_id: 'truth-1', per_task: [{ task_id: 't1', delta: 0.18 }],
  mean: 0.18, ci: [0.08, 0.28], method: 'bca', cluster_key: 'entity', n_eff: 2, mde: 0.1, rule_fired: 'ci>0', round_id: ROUND1, replicates: 1, min_effect: 0.05, sd_source: 'noise_floor',
  verdict: { value: 'promote', by: 'gate-default@1', rule: 'ci>0' }, gate: 'gate-default@1', at: '2025-12-01T12:00:00Z',
}, {
  // Round 1: the promotion of CHAMP over ROOT at holdout.
  challenger_id: CHAMP, vs_id: ROOT, tier: 'holdout', truth_snapshot_id: 'truth-1', per_task: [{ task_id: 't1', delta: 0.15 }, { task_id: 't2', delta: 0.15 }],
  mean: 0.15, ci: [0.05, 0.25], method: 'bca', cluster_key: 'entity', n_eff: 2, mde: 0.1, rule_fired: 'ci>0', round_id: ROUND1, replicates: 1, min_effect: 0.05, sd_source: 'noise_floor',
  verdict: { value: 'promote', by: 'gate-default@1', rule: 'ci>0' }, gate: 'gate-default@1', ladder: { step: 0.05, beat_best: true }, at: '2025-12-02T00:00:00Z',
}]
export const consents: ConsentRow[] = [
  { id: 'consent-1', challenger_id: CHAMP, action: 'promote', who: 'me', channel: 'unix-socket', proof_sha: sha('p'), at: '2025-12-02T12:00:00Z' },
  // The gate change before round 3: the subject is the gate's name@version.
  { id: 'consent-2', challenger_id: 'gate-default@2', action: 'gate_change', who: 'me', channel: 'unix-socket', proof_sha: sha('p2'), at: '2026-01-04T00:00:00Z' },
]
export const settlements: SettlementRow[] = [
  { id: 'settle-1', kind: 'truth', taskset_sha: sha('t'), as_of: '2026-01-01T00:00:00Z', truth_snapshot_id: 'truth-1', n_settled: 3, n_pending: 1, triggered_rescoring: [CHAMP] },
]
export const noiseFloors: NoiseFloorRow[] = [
  { id: FLOOR1, eval_config_sha: EVAL, champion_id: ROOT, loop: 'dsh', metric: 'acc', measured_at: '2025-11-25T00:00:00Z', unit: 'entity', sd_paired: 0.12, n_reruns: 3, n_tasks: 2, tier: 'holdin' },
  { id: FLOOR2, eval_config_sha: EVAL, champion_id: CHAMP, loop: 'dsh', metric: 'acc', measured_at: '2025-12-20T00:00:00Z', unit: 'entity', sd_paired: 0.1, n_reruns: 3, n_tasks: 2, tier: 'holdin' },
]
export const rounds: RoundRow[] = [
  { id: ROUND1, eval_config_sha: EVAL, champion_id: ROOT, gate: GATE1, shadow_gates: [], noise_floor_id: FLOOR1, k: 1, sibling_ids: [CHAMP], best_so_far: 0.15, profile_sha: sha('profile-0'), experiment_id: EXP,
    operator: { session_id: SESSION, provider: 'p', model: 'op-1' }, status: 'decided', opened_at: '2025-12-01T00:00:00Z', closed_at: '2025-12-03T00:00:00Z', outcome: { promoted: CHAMP, superseded: [], consent_id: 'consent-1' } },
  { id: ROUND2, eval_config_sha: EVAL, champion_id: CHAMP, gate: GATE1, shadow_gates: [SHADOW], noise_floor_id: FLOOR2, k: 1, sibling_ids: [CHAL], profile_sha: sha('profile-1'), experiment_id: EXP,
    operator: { session_id: SESSION, provider: 'p', model: 'op-1' }, status: 'judged', opened_at: '2026-01-01T00:00:00Z' },
  { id: ROUND3, eval_config_sha: EVAL, champion_id: CHAMP, gate: GATE2, shadow_gates: [SHADOW], noise_floor_id: FLOOR2, k: 1, sibling_ids: [CHAL2], profile_sha: sha('profile-1'), experiment_id: EXP,
    operator: { session_id: SESSION, provider: 'p', model: 'op-1' }, status: 'open', opened_at: '2026-01-05T00:00:00Z' },
]
export const servings: ServingRow[] = [
  { id: 'serving-1', champion_id: ROOT, from: '2025-11-01T00:00:00Z', to: '2025-12-03T00:00:00Z', by: 'promote', profile_sha: sha('profile-0') },
  { id: 'serving-2', champion_id: CHAMP, from: '2025-12-03T00:00:00Z', by: 'promote', consent_id: 'consent-1', profile_sha: sha('profile-1') },
]
export const experiments: ExperimentRow[] = [{
  id: EXP, hypothesis: 'a shorter skill reads better', prediction: { metric: 'acc', direction: 'up', magnitude: 0.1 }, pack: 'pack-x', gate: GATE1,
  budget: { usd: 10, rounds: 5 }, spent: { usd: 4.5, attempts: 4, rounds: 3, holdout_reveals: 1 },
  created_by: { who: 'me', session_id: SESSION, command_id: 'cmd-1', channel: 'workbench' }, created_at: '2025-11-30T00:00:00Z', status: 'active', round_ids: [ROUND1, ROUND2, ROUND3],
}]
const operator = { provider: 'p', model: 'op-1' }
export const notebook: NotebookRow[] = [
  { id: 'nb-0', session_id: SESSION, seq: 0, at: '2025-11-30T00:00:00Z', kind: 'command/run', name: 'experiment new', args_sha: sha('args-0'), experiment_id: EXP, operator },
  { id: 'nb-1', session_id: SESSION, seq: 1, at: '2025-12-01T00:00:00Z', kind: 'tool/call', name: 'round_open', args_sha: sha('args-1'), round_id: ROUND1, experiment_id: EXP, operator },
  { id: 'nb-2', session_id: SESSION, seq: 2, at: '2025-12-02T00:00:00Z', kind: 'approval/asked', name: 'holdout', args_sha: sha('args-2'), round_id: ROUND1, experiment_id: EXP, operator },
  { id: 'nb-3', session_id: SESSION, seq: 3, at: '2025-12-02T00:01:00Z', kind: 'approval/decided', name: 'holdout', args_sha: sha('args-3'), result_sha: sha('yes'), round_id: ROUND1, experiment_id: EXP, operator },
  { id: 'nb-4', session_id: SESSION, seq: 4, at: '2026-01-05T00:00:00Z', kind: 'tool/result', name: 'round_open', args_sha: sha('args-4'), error: 'ERROR', round_id: ROUND3, experiment_id: EXP, operator },
]

export const championState: ChampionState = {
  rows: [`skill:${SKILL}`], skill_ref: '/store/skill', profilePatchRows: [],
  kept: [{ challenger_id: CHAMP, surface: 'skill', ref: `skill:${SKILL}`, rows: [], skill_ref: '/store/skill', consent_id: 'consent-1', promoted_at: '2025-12-03T00:00:00Z' }],
}

/** What `lifecycle.nextActions` answers for the held row: the numbers its verdict rule used. */
export const nextActions: Record<string, NextAction[]> = {
  [CHAL]: [
    { kind: 'replicate', tier: 'holdin', estimate: { attempts: 2, usd: 2 }, numbers: { rule: 'power:nEff', mde: 0.3, n_eff: 1, replicates: 1, min_effect: 0.05, sd: 0.1 } },
    { kind: 'holdout', tier: 'holdout', estimate: { attempts: 2, usd: 2 }, budget: { remaining: 4, spent: 1 } },
    { kind: 'drop' },
  ],
}

/** The ledger's `operator` redaction over plain arrays: held-out attempts and scores as per-challenger aggregates, every compare without `per_task`. */
export function operatorView<N extends View>(view: N, rows: ViewRows[N], attemptRows: AttemptRow[]): ViewRows[N] {
  if (view === 'attempts') {
    const agg = new Map<string, AttemptAggregate>()
    const out: (AttemptRow | AttemptAggregate)[] = []
    for (const a of rows as AttemptRow[]) {
      if (a.tier !== 'holdout') { out.push(a); continue }
      const cur = agg.get(a.challenger_id) ?? { redacted: true as const, challenger_id: a.challenger_id, tier: 'holdout' as const, n: 0, by_status: {} }
      cur.n += 1
      cur.by_status[a.status] = (cur.by_status[a.status] ?? 0) + 1
      agg.set(a.challenger_id, cur)
    }
    return [...out, ...agg.values()] as ViewRows[N]
  }
  if (view === 'scores') {
    const agg = new Map<string, ScoreAggregate & { sum: number }>()
    const out: (ScoreRow | ScoreAggregate)[] = []
    for (const s of rows as ScoreRow[]) {
      const a = attemptRows.find((x) => x.id === s.attempt_id)
      if (a && a.tier !== 'holdout') { out.push(s); continue }
      const challenger_id = a?.challenger_id ?? ''
      const k = [challenger_id, s.metric, s.scorer_version, s.truth_snapshot_id].join('\0')
      const cur = agg.get(k) ?? { redacted: true as const, challenger_id, tier: 'holdout' as const, metric: s.metric, scorer_version: s.scorer_version, truth_snapshot_id: s.truth_snapshot_id, n: 0, mean: 0, sum: 0 }
      cur.n += 1
      cur.sum += s.value
      agg.set(k, cur)
    }
    return [...out, ...[...agg.values()].map(({ sum, ...rest }) => ({ ...rest, mean: Math.round((sum / rest.n) * 100) / 100 }))] as ViewRows[N]
  }
  if (view === 'compares') return (rows as CompareRow[]).map(({ per_task: _tasks, ...rest }) => rest) as ViewRows[N]
  return rows
}

export function fakeDeps(): UiDeps {
  const tables = { challengers, attempts, scores, compares, consents, settlements, rounds, noise_floors: noiseFloors, servings, experiments, notebook }
  const byId = new Map(challengers.map((c) => [c.id, c]))
  return {
    ledger: {
      read<N extends View>(view: N, viewer: Viewer) { return viewer === 'operator' ? operatorView(view, [...tables[view]] as ViewRows[N], attempts) : [...tables[view]] as ViewRows[N] },
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
    lifecycle: {
      status: () => ({
        champion: championState,
        rounds: rounds.filter((r) => r.status !== 'decided'),
        pending: [{ roundId: ROUND2, candidate: CHAL, action: 'promote' }],
        noiseFloors: [...noiseFloors],
        experiments: [...experiments],
      }),
      nextActions: (id) => nextActions[id] ?? [],
    },
  }
}

/** A number standing alone in text: not a digit run inside a word, a sha or a dashed id. */
const NUMBER = /(?<![\w.-])-?\d+(?:\.\d+)?(?![\w.])/g

/** Every number written on a page, as text (tags stripped): the traceability check matches these against the JSON twin. */
export function numbersInHtml(html: string): string[] {
  const main = /<main[^>]*>([\s\S]*)<\/main>/.exec(html)?.[1] ?? html
  const text = main.replace(/<[^>]+>/g, ' ')
  return [...new Set(text.match(NUMBER) ?? [])]
}

/**
 * Every number in a JSON value a page may show: numeric leaves as is and to
 * 1–4 decimals, the numbers standing alone inside a string exactly as the
 * page would extract them (a date's year, a gate's `@1`; never a digit run
 * inside a sha or an id), and the length of a listing (an array of rows or
 * names, never of numbers) for the counts in headings.
 */
export function numbersInJson(value: unknown): Set<string> {
  const out = new Set<string>()
  const walk = (v: unknown) => {
    if (typeof v === 'number') {
      out.add(String(v))
      for (const d of [1, 2, 3, 4]) out.add(v.toFixed(d))
    } else if (typeof v === 'string') {
      for (const n of v.match(NUMBER) ?? []) out.add(n)
    } else if (Array.isArray(v)) {
      if (v.every((x) => typeof x !== 'number')) out.add(String(v.length))
      v.forEach(walk)
    } else if (v && typeof v === 'object') {
      Object.values(v).forEach(walk)
    }
  }
  walk(value)
  return out
}

/** The numbers on the page the JSON twin does not carry: empty when every numeric cell traces to a row. */
export function untraceable(html: string, json: unknown): string[] {
  const known = numbersInJson(json)
  return numbersInHtml(html).filter((n) => !known.has(n))
}
