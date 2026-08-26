// @oldbulb/samsara-ui — the JSON builders behind /samsara/api/*. Pure functions over
// structural slices of ctx.ledger / ctx.champion / ctx.signoff so fakes
// compose in tests. Every ledger read is the `operator` view (VIEWER): the
// route has no auth and a proposer on the same host can reach loopback, so
// held-out attempts and scores arrive as per-challenger aggregates and no
// compare row carries its per-task deltas (S7). The page has no way to ask
// for more.

import { stateSha, type ChampionState, type ReplayResult } from '@oldbulb/samsara-champion'
import { compareKey, type AttemptAggregate, type AttemptRow, type ChallengerRow, type CompareWithoutTasks, type ConsentRow, type ExperimentRow, type NoiseFloorRow, type NotebookRow, type RoundRow, type ServingRow, type SettlementRow, type Tier, type ViewRows, type View, type Viewer } from '@oldbulb/samsara-ledger'
// Type-only: installs the `ctx.lifecycle` augmentation without loading the service.
import type { Lifecycle } from '@oldbulb/samsara-lifecycle'
import type { PendingSignoff } from '@oldbulb/samsara-signoff'

/** The viewer every page reads as: what the workbench session may see, never a held-out per-task row. */
export const VIEWER: Viewer = 'operator'

export interface UiLedger {
  read<N extends View>(view: N, viewer: Viewer): ViewRows[N]
  challenger(id: string): ChallengerRow | undefined
  lineage(id: string): ChallengerRow[]
}
export interface UiChampion {
  current(): ChampionState
  replayCheck(): ReplayResult
}
export interface UiSignoff {
  pending(): PendingSignoff[]
  /** Only the socket path is surfaced; the key is the human's and never named here. */
  socketPath: string
}
/** The read-only slice of `ctx.lifecycle` a page may consult: status and next actions; absent when the row is not mounted. */
export type UiLifecycle = Pick<Lifecycle, 'status' | 'nextActions'>
export interface UiDeps {
  ledger: UiLedger
  champion: UiChampion
  signoff: UiSignoff
  lifecycle?: UiLifecycle | undefined
}

// ----------------------------------------------------------------- shapes

export interface ChallengerSummary {
  id: string
  short: string
  parent: string | null
  surface: string
  intent: string
  status: ChallengerRow['status']
  tier: Tier
  verdict: { value: string; rule: string; by: string } | null
  /** `name@version` of the gate behind `compare` (the promotion verdict's row, else the latest shadow). */
  gate_method: string | null
  /** `compare` is a shadow judgement: a gate other than the promotion gate, never a decision. */
  shadow: boolean
  /** `cost_ratio` is derived: mean attempt usd over the champion's on the compare's tier, from the attempts `cost_attempts` names. */
  compare: { mean: number; ci: [number, number]; n_eff: number; mde: number; cost_ratio: number | null; cost_attempts: string[] } | null
  /** The proposer's config sha (the row carries no proposer name). */
  proposer: string
  attempts: { n: number; by_status: Record<string, number> }
  facts_sha: string[]
}

export interface Summary {
  champion: {
    state_sha: string | null
    rows: string[]
    kept: { challenger_id: string; surface: string; ref: string; promoted_at: string }[]
    skill_ref: string | null
    promoted_at: string | null
    replay: ReplayResult
    route: { loop: string; model: string } | null
  }
  lastSettlement: (SettlementRow & { demoted: string[] }) | null
  tiers: Record<Tier, ChallengerSummary[]>
  pendingSignoffs: { rowId: string; action: string; expiresAt: string; command: string }[]
}

export interface ChallengerDetail {
  row: ChallengerRow
  lineage: { id: string; surface: string; status: string; verdict: string | null }[]
  attempts: ViewRows['attempts']
  scores: ViewRows['scores']
  compares: ViewRows['compares']
  consents: ConsentRow[]
  prediction_vs_observed: {
    predicted: ChallengerRow['prediction']
    observed: { tier: Tier; truth_snapshot_id: string; fixes_hit: number; at_risk_hit: number }[]
  }
}

export interface CertifyRow {
  loop: string
  adapter_version: string[]
  facts_sha: string[]
  /** Distinct tasks, the fraction with a valid output, and mean cost of the attempts the viewer shows whole (held-out attempts are aggregates and are left out). */
  tasks: number
  valid_rate: number | null
  utilization: number | 'inline'
  cost_mean: number | null
  verdict: string | null
  gate_method: string | null
  shadow: boolean
  revoked: string | null
  challengers: string[]
}

export interface Certification {
  skill_sha: string
  rows: CertifyRow[]
}

// ----------------------------------------------------------------- helpers

const short = (sha: string) => sha.slice(0, 12)
const TIER_RANK: Record<Tier, number> = { smoke: 0, holdin: 1, holdout: 2, live: 3 }

function isRow(a: ViewRows['attempts'][number]): a is AttemptRow {
  return !('redacted' in a)
}

function isCompare(c: ViewRows['compares'][number]): c is CompareWithoutTasks {
  return !('redacted' in c)
}

function mean(xs: number[]): number | null {
  return xs.length === 0 ? null : xs.reduce((s, x) => s + x, 0) / xs.length
}

/** The tier a challenger is shown under: what it reached, else the highest tier any of its attempts ran on. */
function tierOf(row: ChallengerRow, attempts: (AttemptRow | AttemptAggregate)[]): Tier {
  if (row.tier_reached) return row.tier_reached
  let best: Tier = 'smoke'
  for (const a of attempts) if (TIER_RANK[a.tier] > TIER_RANK[best]) best = a.tier
  return best
}

/** The latest compare row by `at` (the one whose verdict the row status reflects); a shadow row only when no other is there. */
function latestCompare(rows: CompareWithoutTasks[]): CompareWithoutTasks | undefined {
  const sorted = [...rows].sort((a, b) => a.at.localeCompare(b.at))
  return sorted.filter((r) => !r.shadow).at(-1) ?? sorted.at(-1)
}

/** Rows recorded before `gate` existed carry the gate as the verdict's `by`. */
function gateOf(c: CompareWithoutTasks): string {
  return c.gate ?? c.verdict.by
}

function usdOf(attempts: AttemptRow[]): number | null {
  return mean(attempts.map((a) => a.cost.usd).filter((x): x is number => typeof x === 'number'))
}

/** The runner records the loop's `skillUtilization` as `{ value }`: a number (the read fraction) or `'inline'`; anything else is opaque. */
function utilizationOf(a: AttemptRow): number | undefined {
  const v = a.skill_utilization?.['value']
  return typeof v === 'number' ? v : undefined
}

function byChallenger<T extends { challenger_id: string }>(rows: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>()
  for (const r of rows) {
    const list = m.get(r.challenger_id) ?? []
    list.push(r)
    m.set(r.challenger_id, list)
  }
  return m
}

/** Attempts per status; a held-out aggregate counts by its `n` and `by_status`. */
function statusCounts(attempts: (AttemptRow | AttemptAggregate)[]): { n: number; by_status: Record<string, number> } {
  const out: Record<string, number> = {}
  let n = 0
  for (const a of attempts) {
    if (isRow(a)) {
      n += 1
      out[a.status] = (out[a.status] ?? 0) + 1
    } else {
      n += a.n
      for (const [k, v] of Object.entries(a.by_status)) out[k] = (out[k] ?? 0) + v
    }
  }
  return { n, by_status: out }
}

// ---------------------------------------------------------------- builders

export function buildSummary(deps: UiDeps): Summary {
  const { ledger, champion, signoff } = deps
  const challengers = ledger.read('challengers', VIEWER)
  const attempts = ledger.read('attempts', VIEWER)
  const compares = ledger.read('compares', VIEWER).filter(isCompare)
  const attemptsBy = byChallenger(attempts)
  const comparesBy = byChallenger(compares)

  const state = champion.current()
  const lastKept = state.kept.at(-1)
  const lastRow = lastKept ? ledger.challenger(lastKept.challenger_id) : undefined
  const championOut: Summary['champion'] = {
    state_sha: state.kept.length === 0 ? null : stateSha(state),
    rows: state.rows,
    kept: state.kept.map((k) => ({ challenger_id: k.challenger_id, surface: k.surface, ref: k.ref, promoted_at: k.promoted_at })),
    skill_ref: state.skill_ref ?? null,
    promoted_at: lastKept?.promoted_at ?? null,
    replay: champion.replayCheck(),
    route: lastRow ? { loop: lastRow.route.loop, model: lastRow.route.model_id } : null,
  }

  const settlements = ledger.read('settlements', VIEWER)
  const last = [...settlements].sort((a, b) => a.as_of.localeCompare(b.as_of)).at(-1)
  const lastSettlement = last
    ? { ...last, demoted: last.triggered_rescoring.filter((id) => ledger.challenger(id)?.verdict?.value === 'reversed') }
    : null

  const tiers: Record<Tier, ChallengerSummary[]> = { smoke: [], holdin: [], holdout: [], live: [] }
  for (const row of [...challengers].sort((a, b) => b.proposed_at.localeCompare(a.proposed_at))) {
    const own = attemptsBy.get(row.id) ?? []
    const rows = own.filter(isRow)
    const tier = tierOf(row, own)
    const cmp = latestCompare(comparesBy.get(row.id) ?? [])
    let compare: ChallengerSummary['compare'] = null
    if (cmp) {
      const mine = rows.filter((a) => a.tier === cmp.tier)
      const theirs = (attemptsBy.get(cmp.vs_id) ?? []).filter(isRow).filter((a) => a.tier === cmp.tier)
      const [mineUsd, theirsUsd] = [usdOf(mine), usdOf(theirs)]
      const cost_ratio = mineUsd !== null && theirsUsd !== null && theirsUsd > 0 ? mineUsd / theirsUsd : null
      compare = { mean: cmp.mean, ci: cmp.ci, n_eff: cmp.n_eff, mde: cmp.mde, cost_ratio, cost_attempts: cost_ratio === null ? [] : [...mine, ...theirs].map((a) => a.id) }
    }
    tiers[tier].push({
      id: row.id,
      short: short(row.id),
      parent: row.parent_ids[0] ? short(row.parent_ids[0]) : null,
      surface: row.surface,
      intent: row.intent.split('\n')[0] ?? '',
      status: row.status,
      tier,
      verdict: row.verdict ? { value: row.verdict.value, rule: row.verdict.rule, by: row.verdict.by } : null,
      gate_method: cmp ? gateOf(cmp) : null,
      shadow: cmp?.shadow ?? false,
      compare,
      proposer: short(row.optimizer_config_sha),
      attempts: statusCounts(own),
      facts_sha: [...new Set(rows.map((a) => a.facts_sha))],
    })
  }

  const pendingSignoffs = signoff.pending().map((p) => ({
    rowId: p.rowId,
    action: p.action,
    expiresAt: p.expiresAt,
    command: `samsara-signoff confirm --socket ${signoff.socketPath} --row ${p.rowId} --action ${p.action} --key <your-private-key.pem> --who <you>`,
  }))

  return { champion: championOut, lastSettlement, tiers, pendingSignoffs }
}

export function buildChallenger(deps: UiDeps, id: string): ChallengerDetail | undefined {
  const { ledger } = deps
  const row = ledger.challenger(id)
  if (!row) return undefined
  const attempts = ledger.read('attempts', VIEWER).filter((a) => a.challenger_id === id)
  const attemptIds = new Set(attempts.filter(isRow).map((a) => a.id))
  const scores = ledger.read('scores', VIEWER).filter((s) => ('redacted' in s ? s.challenger_id === id : attemptIds.has(s.attempt_id)))
  const compares = ledger.read('compares', VIEWER).filter((c) => c.challenger_id === id)
  const consents = ledger.read('consents', VIEWER).filter((c) => c.challenger_id === id)
  return {
    row,
    lineage: ledger.lineage(id).map((r) => ({ id: r.id, surface: r.surface, status: r.status, verdict: r.verdict?.value ?? null })),
    attempts,
    scores,
    compares,
    consents,
    prediction_vs_observed: {
      predicted: row.prediction,
      observed: compares
        .filter(isCompare)
        .filter((c) => c.predicted_vs_observed)
        .map((c) => ({ tier: c.tier, truth_snapshot_id: c.truth_snapshot_id, ...c.predicted_vs_observed! })),
    },
  }
}

export function buildCertification(deps: UiDeps, skillSha: string): Certification {
  const { ledger } = deps
  const rows = ledger.read('challengers', VIEWER).filter((r) => r.skill_sha === skillSha)
  // Held-out attempts are aggregates under VIEWER: tasks, valid rate and cost mean count the rows shown whole.
  const attemptsBy = byChallenger(ledger.read('attempts', VIEWER).filter(isRow))
  const comparesBy = byChallenger(ledger.read('compares', VIEWER).filter(isCompare))
  const settlements = ledger.read('settlements', VIEWER)

  const byLoop = new Map<string, ChallengerRow[]>()
  for (const r of rows) byLoop.set(r.route.loop, [...(byLoop.get(r.route.loop) ?? []), r])

  const out: CertifyRow[] = []
  for (const [loop, group] of [...byLoop.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const attempts = group.flatMap((r) => attemptsBy.get(r.id) ?? [])
    const compares = group.flatMap((r) => comparesBy.get(r.id) ?? [])
    const cmp = latestCompare(compares)
    const utils = attempts.map(utilizationOf).filter((u): u is number => u !== undefined)
    const revokedRow = group.find((r) => r.verdict?.value === 'reversed')
    const revokedBy = revokedRow
      ? settlements.find((s) => s.triggered_rescoring.includes(revokedRow.id))?.id ?? revokedRow.verdict?.rule ?? 'reversed'
      : null
    out.push({
      loop,
      adapter_version: [...new Set(group.map((r) => r.route.loop_adapter_version))],
      facts_sha: [...new Set(attempts.map((a) => a.facts_sha))],
      tasks: new Set(attempts.map((a) => a.task_id)).size,
      valid_rate: attempts.length === 0 ? null : attempts.filter((a) => a.status === 'COMPLETED' && a.output.valid).length / attempts.length,
      utilization: utils.length === 0 ? 'inline' : (mean(utils) as number),
      cost_mean: usdOf(attempts),
      verdict: cmp?.verdict.value ?? null,
      gate_method: cmp ? gateOf(cmp) : null,
      shadow: cmp?.shadow ?? false,
      revoked: revokedBy,
      challengers: group.map((r) => r.id),
    })
  }
  return { skill_sha: skillSha, rows: out }
}

// ------------------------------------------------------------ ledger views

/** Every JSON twin ends in the ids of the rows its numbers came from. */
export interface Sources {
  sources: string[]
}

export function withSources<T extends object>(value: T, ids: Iterable<string | null | undefined>): T & Sources {
  return { ...value, sources: [...new Set([...ids].filter((x): x is string => typeof x === 'string' && x !== ''))] }
}

/** A compare row has no id: its source is the ledger key. */
export function compareSource(c: ViewRows['compares'][number]): string {
  return 'redacted' in c ? `${c.challenger_id}:${c.vs_id}:${c.tier}` : compareKey(c)
}

const byString = <T>(key: (r: T) => string) => (a: T, b: T) => key(a).localeCompare(key(b))

/** Rounds oldest first. */
export function loadRounds(ledger: UiLedger): RoundRow[] {
  return [...ledger.read('rounds', VIEWER)].sort(byString((r) => r.opened_at))
}

export function loadRound(ledger: UiLedger, id: string): RoundRow | undefined {
  return ledger.read('rounds', VIEWER).find((r) => r.id === id)
}

/** Experiments oldest first. */
export function loadExperiments(ledger: UiLedger): ExperimentRow[] {
  return [...ledger.read('experiments', VIEWER)].sort(byString((r) => r.created_at))
}

export function loadExperiment(ledger: UiLedger, id: string): ExperimentRow | undefined {
  return ledger.read('experiments', VIEWER).find((r) => r.id === id)
}

/** The champion history oldest first; the one without `to` is served now. */
export function loadServings(ledger: UiLedger): ServingRow[] {
  return [...ledger.read('servings', VIEWER)].sort(byString((r) => r.from))
}

/** Every noise floor oldest first; the latest per (eval_config_sha, champion_id, loop, metric) is what `lifecycle.status()` reports. */
export function loadNoiseFloors(ledger: UiLedger): NoiseFloorRow[] {
  return [...ledger.read('noise_floors', VIEWER)].sort(byString((r) => r.measured_at))
}

/** One session's notebook in event order. */
export function loadNotebook(ledger: UiLedger, session: string): NotebookRow[] {
  return ledger.read('notebook', VIEWER).filter((r) => r.session_id === session).sort((a, b) => a.seq - b.seq)
}

/** Consents oldest first, for one subject (a challenger id, or a gate's `name@version`) when given. */
export function loadConsents(ledger: UiLedger, subject?: string): ConsentRow[] {
  return ledger.read('consents', VIEWER).filter((c) => subject === undefined || c.challenger_id === subject).sort(byString((c) => c.at))
}
