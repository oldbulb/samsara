// @samsara/ui — the JSON builders behind /samsara/api/*. Pure functions over
// structural slices of ctx.ledger / ctx.champion / ctx.signoff so fakes
// compose in tests. Every ledger read is the `human` view: the page has no way
// to ask for more (held-out per-task rows are whatever that view returns).

import { stateSha, type ChampionState, type ReplayResult } from '@samsara/champion'
import type { AttemptRow, ChallengerRow, CompareRow, ConsentRow, SettlementRow, Tier, ViewRows, View, Viewer } from '@samsara/ledger'
import type { PendingSignoff } from '@samsara/signoff'

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
export interface UiDeps {
  ledger: UiLedger
  champion: UiChampion
  signoff: UiSignoff
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
  gate_method: string | null
  compare: { mean: number; ci: [number, number]; n_eff: number; mde: number; cost_ratio: number | null } | null
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
  compares: CompareRow[]
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
  tasks: number
  pass_rate: number | null
  utilization: number | 'inline'
  cost_mean: number | null
  verdict: string | null
  gate_method: string | null
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

function mean(xs: number[]): number | null {
  return xs.length === 0 ? null : xs.reduce((s, x) => s + x, 0) / xs.length
}

/** The tier a challenger is shown under: what it reached, else the highest tier any of its attempts ran on. */
function tierOf(row: ChallengerRow, attempts: AttemptRow[]): Tier {
  if (row.tier_reached) return row.tier_reached
  let best: Tier = 'smoke'
  for (const a of attempts) if (TIER_RANK[a.tier] > TIER_RANK[best]) best = a.tier
  return best
}

/** The latest compare row by `at` (the one whose verdict the row status reflects). */
function latestCompare(rows: CompareRow[]): CompareRow | undefined {
  return [...rows].sort((a, b) => a.at.localeCompare(b.at)).at(-1)
}

function usdOf(attempts: AttemptRow[]): number | null {
  return mean(attempts.map((a) => a.cost.usd).filter((x): x is number => typeof x === 'number'))
}

/** A loop may report skill delivery as a number under `utilization` or a boolean `read`; anything else is opaque. */
function utilizationOf(a: AttemptRow): number | undefined {
  const u = a.skill_utilization
  if (!u) return undefined
  if (typeof u['utilization'] === 'number') return u['utilization']
  if (typeof u['read'] === 'boolean') return u['read'] ? 1 : 0
  return undefined
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

function statusCounts(attempts: AttemptRow[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const a of attempts) out[a.status] = (out[a.status] ?? 0) + 1
  return out
}

// ---------------------------------------------------------------- builders

export function buildSummary(deps: UiDeps): Summary {
  const { ledger, champion, signoff } = deps
  const challengers = ledger.read('challengers', 'human')
  const attempts = ledger.read('attempts', 'human').filter(isRow)
  const compares = ledger.read('compares', 'human')
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

  const settlements = ledger.read('settlements', 'human')
  const last = [...settlements].sort((a, b) => a.as_of.localeCompare(b.as_of)).at(-1)
  const lastSettlement = last
    ? { ...last, demoted: last.triggered_rescoring.filter((id) => ledger.challenger(id)?.verdict?.value === 'reversed') }
    : null

  const tiers: Record<Tier, ChallengerSummary[]> = { smoke: [], holdin: [], holdout: [], live: [] }
  for (const row of [...challengers].sort((a, b) => b.proposed_at.localeCompare(a.proposed_at))) {
    const own = attemptsBy.get(row.id) ?? []
    const tier = tierOf(row, own)
    const cmp = latestCompare(comparesBy.get(row.id) ?? [])
    let compare: ChallengerSummary['compare'] = null
    if (cmp) {
      const mine = usdOf(own.filter((a) => a.tier === cmp.tier))
      const theirs = usdOf((attemptsBy.get(cmp.vs_id) ?? []).filter((a) => a.tier === cmp.tier))
      const cost_ratio = mine !== null && theirs !== null && theirs > 0 ? mine / theirs : null
      compare = { mean: cmp.mean, ci: cmp.ci, n_eff: cmp.n_eff, mde: cmp.mde, cost_ratio }
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
      gate_method: cmp?.method ?? null,
      compare,
      proposer: short(row.optimizer_config_sha),
      attempts: { n: own.length, by_status: statusCounts(own) },
      facts_sha: [...new Set(own.map((a) => a.facts_sha))],
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
  const attempts = ledger.read('attempts', 'human').filter((a) => a.challenger_id === id)
  const attemptIds = new Set(attempts.filter(isRow).map((a) => a.id))
  const scores = ledger.read('scores', 'human').filter((s) => ('redacted' in s ? s.challenger_id === id : attemptIds.has(s.attempt_id)))
  const compares = ledger.read('compares', 'human').filter((c) => c.challenger_id === id)
  const consents = ledger.read('consents', 'human').filter((c) => c.challenger_id === id)
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
        .filter((c) => c.predicted_vs_observed)
        .map((c) => ({ tier: c.tier, truth_snapshot_id: c.truth_snapshot_id, ...c.predicted_vs_observed! })),
    },
  }
}

export function buildCertification(deps: UiDeps, skillSha: string): Certification {
  const { ledger } = deps
  const rows = ledger.read('challengers', 'human').filter((r) => r.skill_sha === skillSha)
  const attemptsBy = byChallenger(ledger.read('attempts', 'human').filter(isRow))
  const comparesBy = byChallenger(ledger.read('compares', 'human'))
  const settlements = ledger.read('settlements', 'human')

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
      pass_rate: attempts.length === 0 ? null : attempts.filter((a) => a.status === 'COMPLETED' && a.output.valid).length / attempts.length,
      utilization: utils.length === 0 ? 'inline' : (mean(utils) as number),
      cost_mean: usdOf(attempts),
      verdict: cmp?.verdict.value ?? null,
      gate_method: cmp?.method ?? null,
      revoked: revokedBy,
      challengers: group.map((r) => r.id),
    })
  }
  return { skill_sha: skillSha, rows: out }
}
