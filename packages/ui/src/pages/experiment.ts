// `/experiments/:id` — one experiment: the header with its budget, the rounds
// table with the promotion gate's verdict and one column per shadow gate, the
// lineage curve, predicted vs observed, and the consents pending on its
// rounds with the `/samsara approve <id>` line to copy (sign-off never goes
// through the page, E2). Every number is a ledger row's: the ledger records
// no per-round spend (attempts carry no round id), so the rounds table has no
// cost column; the experiment's `spent` is in the header. The ledger carries
// deltas, not levels, so the curve is drawn in delta space on one tier
// (holdin): the champion is the baseline at 0 and a promotion marks it.

import type { CompareWithoutTasks, ExperimentRow, GateRef, RoundRow, Tier } from '@oldbulb/samsara-ledger'
import type { PendingConsent } from '@oldbulb/samsara-lifecycle'
import { VIEWER, compareSource, loadExperiment, loadRounds, withSources } from '../api.ts'
import { lineageSvg, type LineageData, type LineageStep } from '../charts.ts'
import { DASH, badge, callout, card, codeBlock, empty, esc, int, links, num, sha, stat, table, val, verdictBadge, verdictLabel, type Links } from '../html.ts'
import { navOf, shell } from '../theme.ts'
import type { PageBase, PageDeps, PageParams } from './types.ts'

export interface SiblingCompares {
  /** The promotion gate's row on the highest tier judged in this round (the latest there); null until judged. */
  promotion: CompareWithoutTasks | null
  /** The shadow gates' rows likewise, by `name@version`. */
  shadows: Record<string, CompareWithoutTasks>
}

export interface RoundSibling extends SiblingCompares {
  id: string
  /** The `lineage` the row declares; the curve's baseline and promotion marks are per lineage. */
  lineage: string
  /** The same rows on the curve's tier only. */
  holdin: SiblingCompares
}

export interface ExperimentRound {
  row: RoundRow
  siblings: RoundSibling[]
}

export interface ExperimentModel extends PageBase {
  experiment: ExperimentRow
  rounds: ExperimentRound[]
  /** The shadow gates seen across the rounds, `name@version`, first seen first: one verdict column each. */
  shadowGates: string[]
  pending: PendingConsent[]
  curve: LineageData
}

const TIER_RANK: Record<Tier, number> = { smoke: 0, holdin: 1, holdout: 2, live: 3 }

export const gateLabel = (g: GateRef): string => `${g.name}@${g.version}`

/** The one tier the curve is drawn on, so every dot is a delta on the same task set. */
export const CURVE_TIER: Tier = 'holdin'

/** Rows recorded before `gate` existed carry the gate as the verdict's `by`. */
const gateOf = (c: CompareWithoutTasks): string => c.gate ?? c.verdict.by

const labelOf = (c: CompareWithoutTasks): string => verdictLabel(c.verdict.value, c.rule_fired)

export function predictionText(p: ExperimentRow['prediction']): string {
  return `${esc(p.metric)} ${esc(p.direction)}${p.magnitude !== undefined ? ` by ${num(p.magnitude)}` : ''}`
}

/** The row to show for one gate: the highest tier judged, the latest there. */
function pick(rows: CompareWithoutTasks[]): CompareWithoutTasks | null {
  return [...rows].sort((a, b) => TIER_RANK[b.tier] - TIER_RANK[a.tier] || b.at.localeCompare(a.at))[0] ?? null
}

/** One sibling's rows split by gate: the promotion gate's pick and one pick per shadow gate. */
function comparesOf(rows: CompareWithoutTasks[]): SiblingCompares {
  const byGate = new Map<string, CompareWithoutTasks[]>()
  for (const c of rows) if (c.shadow) byGate.set(gateOf(c), [...(byGate.get(gateOf(c)) ?? []), c])
  return { promotion: pick(rows.filter((c) => !c.shadow)), shadows: Object.fromEntries([...byGate].map(([g, list]) => [g, pick(list)!])) }
}

export function load(deps: PageDeps, params: PageParams): ExperimentModel | undefined {
  const experiment = loadExperiment(deps.ledger, params.id ?? '')
  if (!experiment) return undefined
  const compares = deps.ledger.read('compares', VIEWER).filter((c): c is CompareWithoutTasks => !('redacted' in c))
  const rounds = loadRounds(deps.ledger).filter((r) => r.experiment_id === experiment.id).map((row): ExperimentRound => {
    const own = compares.filter((c) => c.round_id === row.id)
    const siblings = row.sibling_ids.map((id): RoundSibling => {
      const mine = own.filter((c) => c.challenger_id === id)
      return { id, lineage: deps.ledger.challenger(id)?.lineage ?? 'main', ...comparesOf(mine), holdin: comparesOf(mine.filter((c) => c.tier === CURVE_TIER)) }
    })
    return { row, siblings }
  })
  const roundIds = new Set(rounds.map((r) => r.row.id))
  return {
    base: deps.base,
    refreshMs: deps.refreshMs,
    experiment,
    rounds,
    shadowGates: [...new Set(rounds.flatMap((r) => r.row.shadow_gates.map(gateLabel)))],
    pending: (deps.lifecycle?.status().pending ?? []).filter((p) => roundIds.has(p.roundId)),
    curve: curveOf(experiment, rounds),
  }
}

/**
 * The curve's data, on `CURVE_TIER` only: y is the observed delta of the
 * promotion gate's row against the round's champion; the champion is the
 * baseline at 0 (every row is measured against it) and a promotion marks it
 * with the margin the promoted row won there. Shadow squares are one per
 * (sibling, gate).
 */
export function curveOf(experiment: ExperimentRow, rounds: ExperimentRound[]): LineageData {
  const siblings: LineageData['siblings'] = []
  const steps = new Map<string, LineageStep[]>()
  const shadows: NonNullable<LineageData['shadows']> = []
  const gateChanges: NonNullable<LineageData['gateChanges']> = []
  rounds.forEach(({ row, siblings: own }, i) => {
    for (const s of own) {
      const c = s.holdin.promotion
      if (c) {
        const promoted = row.outcome?.promoted === s.id
        siblings.push({ id: s.id, round: i, value: c.mean, ci: c.ci, verdict: `${labelOf(c)} on ${c.tier}`, promoted })
        if (promoted) steps.set(s.lineage, [...(steps.get(s.lineage) ?? []), { round: i, value: c.mean }])
      }
      for (const [gate, shadow] of Object.entries(s.holdin.shadows)) shadows.push({ round: i, gate, verdict: labelOf(shadow), id: s.id })
    }
    const label = gateLabel(row.gate)
    if (i > 0 && label !== gateLabel(rounds[i - 1]!.row.gate)) gateChanges.push({ round: i, label })
  })
  const p = experiment.prediction
  const m = p.magnitude
  return {
    metric: `Δ ${p.metric} vs champion · ${CURVE_TIER}`,
    siblings,
    lineages: [...steps].map(([name, list]) => ({ name, steps: list })),
    shadows,
    gateChanges,
    rounds: rounds.length,
    baseline: 0,
    ...(m === undefined ? {} : { prediction: { low: p.direction === 'up' ? 0 : -m, high: p.direction === 'up' ? m : 0, label: `predicted ${p.metric} ${p.direction} by ${m}` } }),
  }
}

export function render(model: ExperimentModel): string {
  const L = links(model.base)
  return shell({
    title: `experiment ${model.experiment.id.slice(0, 12)}`,
    nav: navOf(model.base, 'experiments'),
    base: model.base,
    body: headerSection(model.experiment, `${model.base}/experiments`, L) + roundsSection(model, L) + curveSection(model.curve) + predictionSection(model, L) + pendingSection(model.pending, L),
    refreshMs: model.refreshMs,
  })
}

export function json(model: ExperimentModel): object {
  const { experiment, rounds, shadowGates, pending, curve } = model
  return withSources({ page: 'experiment', experiment, rounds, shadowGates, pending, curve }, [
    experiment.id,
    ...rounds.flatMap((r) => [r.row.id, r.row.champion_id, r.row.noise_floor_id, ...r.siblings.flatMap((s) => [s.id, ...[s, s.holdin].flatMap((c) => [...(c.promotion ? [compareSource(c.promotion)] : []), ...Object.values(c.shadows).map(compareSource)])])]),
    ...pending.map((p) => p.candidate),
  ])
}

const DIMS = ['usd', 'attempts', 'rounds', 'holdout_reveals'] as const

function bar(spent: number, total: number | undefined): string {
  if (total === undefined || total <= 0) return DASH
  return `<div class="bar"><i style="width:${Math.min(100, Math.round((spent / total) * 100))}%"></i></div>`
}

function headerSection(e: ExperimentRow, list: string, L: Links): string {
  const by = e.created_by
  const head = `<div class="card-row"><div class="crumbs"><a href="${list}">← experiments</a> <span class="muted">/</span> <span class="tnum" title="${esc(e.id)}">${esc(e.id.slice(0, 12))}</span> ${badge(e.status)}</div></div>`
    + `<div class="card-body"><p>${val(e.hypothesis)}</p></div>`
    + stat([
      ['prediction', predictionText(e.prediction)],
      ['gate', `${esc(gateLabel(e.gate))} <span class="muted">policy ${sha(e.gate.policy_sha)}</span>`],
      ['created by', `${val(by.who)} <span class="muted">·</span> ${L.notebook(by.session_id)} <span class="muted">·</span> ${val(by.command_id)} <span class="muted">· ${esc(by.channel)}</span>`],
      ['created at', val(e.created_at)],
      ['closed at', val(e.closed_at)],
      ['rounds', int(e.round_ids.length)],
    ])
  const budget = table(['budget', 'spent', 'total', ''], DIMS.filter((d) => e.budget[d] !== undefined || e.spent[d] > 0).map((d) => {
    const fmt = d === 'usd' ? (x: number | undefined) => num(x, 2) : int
    return [esc(d.replace('_', ' ')), fmt(e.spent[d]), fmt(e.budget[d]), bar(e.spent[d], e.budget[d])]
  }), 'No budget declared and nothing spent.')
  return `<section><h2>Experiment</h2>${card(head)}</section><section><h3>Budget</h3>${card(budget)}</section>`
}

function roundsSection(model: ExperimentModel, L: Links): string {
  const cols = ['round', 'champion', 'k', 'verdict', ...model.shadowGates, 'n_eff', 'mde', 'replicates', 'status']
  const lines = (r: ExperimentRound, cell: (s: RoundSibling) => string) => r.siblings.map(cell).join('<br>') || DASH
  const rows = model.rounds.map((r) => [
    L.round(r.row.id), L.challenger(r.row.champion_id), int(r.row.k),
    lines(r, (s) => `${L.challenger(s.id)} ${s.promotion ? `${verdictBadge(s.promotion.verdict.value, { rule: s.promotion.rule_fired })} <span class="muted">${esc(gateLabel(r.row.gate))} · ${esc(s.promotion.tier)}</span>` : DASH}`),
    ...model.shadowGates.map((g) => lines(r, (s) => s.shadows[g] ? verdictBadge(s.shadows[g]!.verdict.value, { rule: s.shadows[g]!.rule_fired, shadow: true, gate: g }) : DASH)),
    lines(r, (s) => val(s.promotion?.n_eff)),
    lines(r, (s) => num(s.promotion?.mde)),
    lines(r, (s) => int(s.promotion?.replicates)),
    badge(r.row.status),
  ])
  return `<section><h2>Rounds<span class="count">${model.rounds.length}</span></h2>${card(table(cols, rows, 'No round opened yet.'))}</section>`
}

function curveSection(curve: LineageData): string {
  const body = curve.siblings.length === 0 ? `<div class="card-body">${empty(`No sibling judged on ${CURVE_TIER} yet.`)}</div>` : `<div class="chart">${lineageSvg(curve)}</div>`
  return `<section><h2>Lineage</h2>${card(body)}</section>`
}

function predictionSection(model: ExperimentModel, L: Links): string {
  const p = model.experiment.prediction
  const rows: string[][] = []
  for (const r of model.rounds) {
    for (const s of r.siblings) {
      const c = s.promotion
      if (!c || (c.verdict.value !== 'promote' && !c.verdict.value.startsWith('hold'))) continue
      rows.push([L.challenger(s.id), L.round(r.row.id), badge(c.tier), verdictBadge(c.verdict.value, { rule: c.rule_fired }), num(c.mean), `[${num(c.ci[0])}, ${num(c.ci[1])}]`, val(c.n_eff)])
    }
  }
  return `<section><h2>Predicted vs observed</h2>${card(stat([['predicted', predictionText(p)]]) + table(['challenger', 'round', 'tier', 'verdict', `observed Δ ${esc(p.metric)}`, 'ci', 'n_eff'], rows, 'No promoted or held row yet.'))}</section>`
}

function pendingSection(list: PendingConsent[], L: Links): string {
  const body = list.length === 0 ? empty('No consent pending.') : list.map((p) =>
    callout('warn', `Consent pending: ${badge(p.action)} on ${L.challenger(p.candidate)} <span class="muted">· round ${L.round(p.roundId)} · ask the person to run this in the workbench (never through the page)</span>`)
    + codeBlock('/samsara approve', `/samsara approve ${p.candidate}`)).join('')
  return `<section><h2>Pending consents<span class="count">${list.length}</span></h2>${card(`<div class="card-body">${body}</div>`)}</section>`
}
