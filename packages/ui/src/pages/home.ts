// `/` — the overview: the status strip (champion served, experiments, open
// rounds, pending consents, latest noise floors) with onboarding hints when
// the ledger is empty, then champion, last settlement, challengers by tier,
// pending sign-offs. With `?challenger=<id>` the evidence page's body is
// rendered above them (the pre-route drill-down). Read-only; sign-off never
// goes through HTTP (E2): the page only shows the command to run.

import type { ExperimentRow, NoiseFloorRow, RoundRow, ServingRow } from '@oldbulb/samsara-ledger'
import type { PendingConsent } from '@oldbulb/samsara-lifecycle'
import { VIEWER, buildChallenger, buildSummary, compareSource, loadExperiments, loadNoiseFloors, loadRounds, loadServings, withSources, type ChallengerDetail, type ChallengerSummary, type Summary } from '../api.ts'
import { DASH, badge, callout, card, codeBlock, empty, esc, int, links, num, sha, stat, table, val, verdictBadge, type Links } from '../html.ts'
import { navOf, shell } from '../theme.ts'
import { detailSection, notFoundSection } from './challenger.ts'
import type { PageBase, PageDeps, PageParams } from './types.ts'

/** What is missing for a first round: the onboarding hints the strip shows. */
export type Hint = 'noise_floor' | 'aa' | 'experiment'

export interface StatusStrip {
  /** The serving without `to`, with the champion row's skill sha; absent before the first promotion. */
  champion?: { serving: ServingRow; skill_sha: string | null }
  servings: number
  /** The active experiments, and how many the ledger has in all. */
  experiments: ExperimentRow[]
  experimentsTotal: number
  /** Rounds not yet decided. */
  rounds: RoundRow[]
  /** From `lifecycle.status()`; empty when the service is not mounted. */
  pending: PendingConsent[]
  /** The latest noise floor per (eval config, champion, loop, metric). */
  noiseFloors: NoiseFloorRow[]
  hints: Hint[]
  lifecycle: boolean
}

export interface HomeModel extends PageBase {
  status: StatusStrip
  summary: Summary
  /** The `?challenger=<id>` drill-down: the detail, or the id when the ledger has no such row. */
  detail?: ChallengerDetail | { missing: string }
}

/** The latest noise floor per (eval config, champion, loop, metric), the way `lifecycle.status()` picks it. */
function latestFloors(rows: NoiseFloorRow[]): NoiseFloorRow[] {
  const latest = new Map<string, NoiseFloorRow>()
  for (const f of rows) {
    const key = [f.eval_config_sha, f.champion_id, f.loop, f.metric].join('\0')
    const cur = latest.get(key)
    if (!cur || f.measured_at > cur.measured_at) latest.set(key, f)
  }
  return [...latest.values()]
}

export function loadStatus(deps: PageDeps): StatusStrip {
  const { ledger, lifecycle } = deps
  const status = lifecycle?.status()
  const servings = loadServings(ledger)
  const serving = servings.find((s) => s.to === undefined)
  const floors = loadNoiseFloors(ledger)
  const experiments = loadExperiments(ledger)
  const hints: Hint[] = []
  if (floors.length === 0) hints.push('noise_floor')
  if (!ledger.read('challengers', VIEWER).some((r) => r.intent.startsWith('control:aa'))) hints.push('aa')
  if (experiments.length === 0) hints.push('experiment')
  return {
    ...(serving ? { champion: { serving, skill_sha: ledger.challenger(serving.champion_id)?.skill_sha ?? null } } : {}),
    servings: servings.length,
    experiments: experiments.filter((e) => e.status === 'active'),
    experimentsTotal: experiments.length,
    rounds: status?.rounds ?? loadRounds(ledger).filter((r) => r.status !== 'decided'),
    pending: status?.pending ?? [],
    noiseFloors: status?.noiseFloors ?? latestFloors(floors),
    hints,
    lifecycle: lifecycle !== undefined,
  }
}

export function load(deps: PageDeps, params: PageParams): HomeModel {
  const model: HomeModel = { base: deps.base, refreshMs: deps.refreshMs, status: loadStatus(deps), summary: buildSummary(deps) }
  const id = params.query.get('challenger')
  if (id) model.detail = buildChallenger(deps, id) ?? { missing: id }
  return model
}

export function render(model: HomeModel): string {
  const L = links(model.base)
  const s = model.summary
  const detail = model.detail === undefined ? '' : 'missing' in model.detail ? notFoundSection(model.detail.missing, L) : detailSection(model.detail, L)
  return shell({
    title: 'overview',
    nav: navOf(model.base, 'home'),
    base: model.base,
    body: detail + statusSection(model.status, L) + hintsSection(model.status.hints) + championSection(s.champion, L) + settlementSection(s.lastSettlement, L) + tiersSection(s.tiers, L) + signoffSection(s.pendingSignoffs, L),
    refreshMs: model.refreshMs,
  })
}

export function json(model: HomeModel): object {
  const s = model.summary
  const st = model.status
  const ids = [
    st.champion?.serving.id, st.champion?.serving.champion_id,
    ...st.experiments.map((e) => e.id), ...st.rounds.map((r) => r.id), ...st.pending.map((p) => p.candidate), ...st.noiseFloors.map((f) => f.id),
    ...s.champion.kept.map((k) => k.challenger_id),
    s.lastSettlement?.id,
    ...Object.values(s.tiers).flat().flatMap((r) => [r.id, ...(r.compare?.cost_attempts ?? [])]),
    ...s.pendingSignoffs.map((p) => p.rowId),
  ]
  if (model.detail && !('missing' in model.detail)) {
    const d = model.detail
    ids.push(d.row.id, ...d.attempts.map((a) => ('id' in a ? a.id : `${a.challenger_id}:${a.tier}`)), ...d.compares.map(compareSource), ...d.consents.map((c) => c.id))
  }
  return withSources({ status: st, ...s, ...(model.detail ? { detail: model.detail } : {}) }, ids)
}

/** The strip: champion served, experiments, open rounds (the `#rounds` anchor), pending consents, latest noise floors. */
export function statusSection(st: StatusStrip, L: Links): string {
  const c = st.champion
  const champion = card(c ? stat([
    ['champion', L.challenger(c.serving.champion_id)],
    ['skill sha', sha(c.skill_sha)],
    ['served since', `${val(c.serving.from)} <span class="muted">by ${esc(c.serving.by)}</span>`],
    ['servings', `<a href="${L.home}servings"><span class="tnum">${esc(st.servings)}</span></a>`],
  ]) : `<div class="card-body">${empty('Nothing served yet.')}</div>`, 'Champion')
  const experiments = card(`<div class="card-body">${st.experiments.length === 0 ? empty(st.experimentsTotal === 0 ? 'No experiment yet.' : 'No active experiment.')
    : st.experiments.map((e) => `${L.experiment(e.id)} <span class="muted">${esc(e.hypothesis)}</span> ${badge(e.status)}`).join('<br>')}</div>`, `Active experiments · ${st.experiments.length} of ${st.experimentsTotal}`)
  const rounds = `<div id="rounds">${card(`<div class="card-body">${st.rounds.length === 0 ? empty('No open round.')
    : st.rounds.map((r) => `${L.round(r.id)} ${badge(r.status)} <span class="muted">vs</span> ${L.challenger(r.champion_id)} <span class="muted">· ${esc(r.gate.name)}@${esc(r.gate.version)} · opened ${esc(r.opened_at)}</span>`).join('<br>')}</div>`, `Open rounds · ${st.rounds.length}`)}</div>`
  const pending = card(`<div class="card-body">${st.pending.length === 0 ? empty(st.lifecycle ? 'No consent pending.' : 'Pending consents come from the lifecycle service, which is not mounted.')
    : st.pending.map((p) => `${badge(p.action)} ${L.challenger(p.candidate)} <span class="muted">in round</span> ${L.round(p.roundId)}${codeBlock('/samsara approve', `/samsara approve ${p.candidate}`)}`).join('')}</div>`, `Pending consents · ${st.pending.length}`)
  const floors = card(st.noiseFloors.length === 0 ? `<div class="card-body">${empty('No noise floor yet.')}</div>`
    : table(['eval config', 'champion', 'loop', 'metric', 'sd_paired', 'unit', 'reruns × tasks', 'tier', 'measured'], st.noiseFloors.map((f) => [
      sha(f.eval_config_sha), L.challenger(f.champion_id), val(f.loop), val(f.metric), num(f.sd_paired), val(f.unit), `${int(f.n_reruns)} × ${int(f.n_tasks)}`, badge(f.tier), val(f.measured_at),
    ])), `Latest noise floor per eval config · ${st.noiseFloors.length}`)
  return `<section id="status"><h2>Status</h2><div class="grid">${champion}${experiments}${rounds}${pending}</div></section><section>${floors}</section>`
}

const HINTS: Record<Hint, string> = {
  noise_floor: 'No noise floor yet: the gate has no sd to size an MDE against, so nothing can be judged. Calibrate the champion with same-config reruns first — <code>dsh --profile host calibrate --pack &lt;pack&gt; --loop &lt;loop&gt; --set holdin --reruns &lt;n&gt; --metric &lt;metric&gt;</code> (three reruns or more).',
  aa: 'No A/A control yet: run the champion\'s own skill as a challenger once, so a promote under the null shows up here before it costs anything — <code>dsh --profile host control aa --pack &lt;pack&gt; --loop &lt;loop&gt; --metric &lt;metric&gt;</code>.',
  experiment: 'No experiment yet: pre-register a hypothesis, a prediction and a budget before the first round — <code>dsh --profile host experiment new</code>.',
}

/** Onboarding: one callout per missing prerequisite; nothing when none is missing. */
export function hintsSection(hints: Hint[]): string {
  if (hints.length === 0) return ''
  return `<section><h2>Getting started</h2>${card(`<div class="card-body">${hints.map((h) => callout('warn', HINTS[h])).join('')}</div>`)}</section>`
}

export function championSection(c: Summary['champion'], L: Links): string {
  if (!c.state_sha) return `<section><h2>Champion</h2>${card(`<div class="card-body">${callout('', 'No champion yet — nothing has been promoted.')}</div>`)}</section>`
  const replay = c.replay.equal ? badge('replay ok', 'ok')
    : `${badge('replay mismatch', 'danger')} <span class="muted">missing in file: ${val(c.replay.missingInFile.join(', '))}; extra in file: ${val(c.replay.extraInFile.join(', '))}</span>`
  return `<section><h2>Champion</h2>${card(stat([
    ['state sha', `<span class="tnum">${esc(c.state_sha)}</span>`],
    ['kept rows', c.kept.length === 0 ? DASH : c.kept.map((k) => `${esc(k.surface)} <span class="tnum">${esc(k.ref)}</span> (${L.challenger(k.challenger_id)})`).join('<br>')],
    ['skill ref', c.skill_ref ? `<span class="tnum">${esc(c.skill_ref)}</span>` : DASH],
    ['promoted at', val(c.promoted_at)],
    ['replay check', replay],
    ['route', c.route ? `${esc(c.route.loop)} / ${esc(c.route.model)}` : DASH],
  ]))}</section>`
}

export function settlementSection(s: Summary['lastSettlement'], L: Links): string {
  const body = !s ? `<div class="card-body">${empty('No settlement yet.')}</div>` : stat([
    ['kind', val(s.kind)], ['as of', val(s.as_of)],
    ['settled / pending', `<span class="tnum">${esc(s.n_settled)} / ${esc(s.n_pending)}</span>`],
    ['truth snapshot', sha(s.truth_snapshot_id)],
    ['rows re-scored', s.triggered_rescoring.length === 0 ? DASH : s.triggered_rescoring.map((id) => L.challenger(id)).join(' ')],
    ['demoted', s.demoted.length === 0 ? '<span class="muted">none</span>' : s.demoted.map((id) => L.challenger(id)).join(' ')],
  ])
  return `<section><h2>Last settlement</h2>${card(body)}</section>`
}

export function tierTable(rows: ChallengerSummary[], L: Links): string {
  const cols = ['id', 'parent', 'surface', 'intent', 'status', 'verdict', 'compare', 'proposer', 'attempts', 'facts sha']
  return table(cols, rows.map((r) => [
    L.challenger(r.id), sha(r.parent), val(r.surface), val(r.intent), badge(r.status),
    r.verdict ? `${verdictBadge(r.verdict.value, { rule: r.verdict.rule })} <span class="muted">${esc(r.verdict.rule)} · ${esc(r.gate_method ?? r.verdict.by)}</span>` : DASH,
    r.compare ? `${r.shadow ? `${badge('shadow', 'neutral')} <span class="muted">${esc(r.gate_method)}</span> ` : ''}mean ${num(r.compare.mean)} ci [${num(r.compare.ci[0])}, ${num(r.compare.ci[1])}] n_eff ${val(r.compare.n_eff)} mde ${num(r.compare.mde)} <span title="derived: mean usd per attempt over the champion's, from ${esc(r.compare.cost_attempts.length)} attempts">cost ${num(r.compare.cost_ratio, 2)}</span>` : DASH,
    sha(r.proposer),
    `<span class="tnum">${esc(r.attempts.n)}</span> ${Object.entries(r.attempts.by_status).map(([k, v]) => `${badge(k)}<span class="tnum muted">×${esc(v)}</span>`).join(' ')}`,
    r.facts_sha.length === 0 ? DASH : r.facts_sha.map(sha).join(' '),
  ]), 'No challengers on this tier.')
}

export function tiersSection(tiers: Partial<Summary['tiers']>, L: Links): string {
  return (['smoke', 'holdin', 'holdout', 'live'] as const).map((tier) => {
    const rows = tiers[tier] ?? []
    return `<section><h2>Challengers · ${tier}<span class="count">${rows.length}</span></h2>${card(rows.length ? tierTable(rows, L) : `<div class="card-body">${tierTable(rows, L)}</div>`)}</section>`
  }).join('')
}

export function signoffSection(list: Summary['pendingSignoffs'], L: Links): string {
  const body = list.length === 0 ? empty('No sign-off pending.') : list.map((p) =>
    callout('warn', `Sign-off pending: ${badge(p.action)} on ${L.challenger(p.rowId)} <span class="muted">· nonce expires ${val(p.expiresAt)} · run this from your shell (never through the page)</span>`)
    + codeBlock('samsara-signoff confirm', p.command)).join('')
  return `<section><h2>Pending sign-offs<span class="count">${list.length}</span></h2>${card(`<div class="card-body">${body}</div>`)}</section>`
}
