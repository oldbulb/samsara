// Settlement bookkeeping, pure. When the book settles (truth arrives or is
// revised), every `hold`/`promote` row in the champion's ancestry whose
// attempts touch an affected task must be re-scored. Planning the re-score is
// data in / data out; the runner re-runs `score`, the gate re-judges, and the
// result comes back through `rescored` as a new append-only compare row.

import type { GateVerdictRow } from '@oldbulb/samsara-gate'
import type { AttemptRow, ChallengerRow, CompareRow, SettlementRow, Tier } from '@oldbulb/samsara-ledger'

/** The book's `book/settled` payload (structural; matches @oldbulb/samsara-book Settlement). */
export interface SettledEvent {
  id: string
  kind: SettlementRow['kind']
  taskset_sha: string
  as_of: string
  truth_snapshot_id: string
  n_settled: number
  n_pending: number
  task_ids: string[]
}

/** One `samsara/rescore` request: re-score these attempts of this challenger on the new truth. */
export interface RescoreEvent {
  settlement_id: string
  challenger_id: string
  attempt_ids: string[]
  truth_snapshot_id: string
}

/** The slice of the ledger the planner reads. */
export interface LineageReader {
  challenger(id: string): ChallengerRow | undefined
  lineage(id: string): ChallengerRow[]
  attemptsOf(challengerId: string): AttemptRow[]
}

export const RESCORABLE = new Set<string>(['hold', 'promote'])

/**
 * Walk the ancestry of every kept challenger (first-parent chain) and collect
 * the rows whose verdict is still `hold` or `promote` and whose attempts touch
 * an affected task. Deterministic: challengers by id, attempts by id.
 */
export function planRescore(ledger: LineageReader, keptIds: string[], event: SettledEvent): RescoreEvent[] {
  const affected = new Set(event.task_ids)
  const seen = new Map<string, ChallengerRow>()
  for (const id of keptIds) {
    for (const row of ledger.lineage(id)) seen.set(row.id, row)
  }
  const out: RescoreEvent[] = []
  for (const row of [...seen.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (!row.verdict || !RESCORABLE.has(row.verdict.value)) continue
    const attempt_ids = ledger.attemptsOf(row.id)
      .filter((a) => affected.has(a.task_id))
      .map((a) => a.id)
      .sort()
    if (attempt_ids.length === 0) continue
    out.push({ settlement_id: event.id, challenger_id: row.id, attempt_ids, truth_snapshot_id: event.truth_snapshot_id })
  }
  return out
}

export interface CompareCoords {
  vs_id: string
  tier: Tier
  truth_snapshot_id: string
  /** The Ladder's best-so-far the gate was asked to beat (`CompareRequest.bestSoFar`); absent when none yet. */
  best_so_far?: number
  at?: string
}

function round2(x: number): number {
  return Math.round(x * 100) / 100
}

/**
 * Turn a gate judgement on re-scored attempts into the ledger's compare row.
 * For a kept (promoted) challenger the verdict is lifted to the settlement
 * vocabulary: `promote` again means `confirmed`, anything else `reversed`.
 * An unkept row keeps the gate's own value (`hold` stays open, `drop` closes).
 * `shadow` marks a judgement by a gate that is not the promotion gate and has
 * no `gate_change` consent: recorded beside the promotion verdict, never a decision.
 * `ladder` copies the gate's Ladder output with the best-so-far it was judged
 * against, rounded to two decimals as the proposer view rounds it.
 */
export function compareRowOf(
  challengerId: string,
  judgement: GateVerdictRow,
  coords: CompareCoords,
  kept: boolean,
  shadow = false,
): CompareRow {
  const c = judgement.compare
  const gateValue = judgement.verdict === 'hold:underpowered' ? 'hold' : judgement.verdict
  const value: CompareRow['verdict']['value'] = kept ? (gateValue === 'promote' ? 'confirmed' : 'reversed') : gateValue
  return {
    challenger_id: challengerId,
    vs_id: coords.vs_id,
    tier: coords.tier,
    truth_snapshot_id: coords.truth_snapshot_id,
    per_task: c.perTask.map((d) => ({ task_id: d.taskId, delta: d.delta })),
    mean: c.mean,
    ci: c.ci,
    method: c.method,
    cluster_key: c.clusterKey,
    holm: { m: 0, rank: 0, alpha_adj: c.holm.adjustedAlpha },
    n_eff: c.nEff,
    mde: c.mde,
    rule_fired: c.ruleFired,
    verdict: { value, by: judgement.gateMethod, rule: c.ruleFired },
    gate: judgement.gateMethod,
    shadow,
    ladder: { step: c.ladder.step, beat_best: c.ladder.beatBest, ...(coords.best_so_far !== undefined ? { best_so_far: round2(coords.best_so_far) } : {}) },
    at: coords.at ?? new Date().toISOString(),
  }
}
