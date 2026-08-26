// `/challengers/:id` — the evidence page of one row: coordinates, lineage,
// attempts with per-task scores, compares (shadow rows marked with their
// gate), consents, prediction vs observed. Read-only.

import { buildChallenger, compareSource, withSources, type ChallengerDetail } from '../api.ts'
import { DASH, badge, callout, card, esc, links, num, sha, stat, table, val, verdictBadge, type Links } from '../html.ts'
import { navOf, shell } from '../theme.ts'
import type { PageBase, PageDeps, PageParams } from './types.ts'

export interface ChallengerModel extends PageBase {
  detail: ChallengerDetail
}

export function load(deps: PageDeps, params: PageParams): ChallengerModel | undefined {
  const detail = buildChallenger(deps, params.id ?? '')
  return detail ? { base: deps.base, refreshMs: deps.refreshMs, detail } : undefined
}

export function render(model: ChallengerModel): string {
  return shell({
    title: `challenger ${model.detail.row.id.slice(0, 12)}`,
    nav: navOf(model.base),
    base: model.base,
    body: detailSection(model.detail, links(model.base)),
    refreshMs: model.refreshMs,
  })
}

export function json(model: ChallengerModel): object {
  const d = model.detail
  return withSources(d, [
    d.row.id,
    ...d.lineage.map((l) => l.id),
    ...d.attempts.map((a) => ('id' in a ? a.id : `${a.challenger_id}:${a.tier}`)),
    ...d.compares.map(compareSource),
    ...d.consents.map((c) => c.id),
  ])
}

/** The evidence page body; also the drill-down the home page shows for `?challenger=<id>`. */
export function detailSection(d: ChallengerDetail, L: Links): string {
  const r = d.row
  const coordKeys = ['id', 'patch_sha', 'harness_sha', 'env_sha', 'skill_sha', 'taskset_sha', 'optimizer_config_sha', 'truth_snapshot_id', 'scorer_version', 'report_rule_version'] as const
  const coords = stat([
    ...coordKeys.map((k): [string, string] => [k.replace(/_/g, ' '), sha(r[k])]),
    ['route', `${esc(r.route.loop)}@${esc(r.route.loop_adapter_version)} / ${esc(r.route.model_id)}`],
  ])
  const crumbs = `<div class="crumbs">${d.lineage.map((l) => `${L.challenger(l.id)} <span class="muted">${esc(l.surface)}</span> ${badge(l.status)}${l.verdict ? ` ${verdictBadge(l.verdict)}` : ''}`).join('<span class="muted"> → </span>')}</div>`
  const scoresByAttempt: Record<string, string[]> = {}
  for (const s of d.scores) {
    if ('redacted' in s) continue
    ;(scoresByAttempt[s.attempt_id] ||= []).push(`${esc(s.metric)}=${num(s.value)}`)
  }
  const attempts = table(['attempt', 'task', 'sample', 'tier', 'status', 'stop', 'cost usd', 'wall s', 'scores'], d.attempts.map((a) => 'redacted' in a
    ? [`<span class="muted">${esc(a.tier)} aggregate</span>`, DASH, DASH, badge(a.tier), Object.entries(a.by_status).map(([k, v]) => `${badge(k)}<span class="tnum muted">×${esc(v)}</span>`).join(' '), DASH, DASH, DASH, `<span class="tnum">${esc(a.n)}</span> attempts`]
    : [sha(a.id), val(a.task_id), val(a.sample), badge(a.tier), badge(a.status), val(a.stop_reason), num(a.cost.usd, 4), num(a.cost.wall_s, 1), (scoresByAttempt[a.id] ?? []).join(' ') || DASH]),
  'No attempts recorded.')
  const aggregates = d.scores.filter((s) => 'redacted' in s).map((s) => 'redacted' in s ? `${esc(s.metric)} mean ${num(s.mean)} over ${esc(s.n)}` : '')
  const compares = table(['vs', 'tier', 'truth', 'mean', 'ci', 'n_eff', 'mde', 'rule', 'verdict', 'gate', 'method', 'round', 'at'], d.compares.map((c) => 'redacted' in c
    ? [L.challenger(c.vs_id), badge(c.tier), DASH, DASH, DASH, DASH, DASH, val(c.rule_fired), verdictBadge(c.verdict.value, { rule: c.rule_fired }), val(c.verdict.by), val(c.method), DASH, DASH]
    : [L.challenger(c.vs_id), badge(c.tier), sha(c.truth_snapshot_id), num(c.mean), `[${num(c.ci[0])}, ${num(c.ci[1])}]`, val(c.n_eff), num(c.mde),
      val(c.rule_fired), verdictBadge(c.verdict.value, { rule: c.rule_fired, shadow: c.shadow ?? false, gate: c.gate ?? null }), val(c.gate ?? c.verdict.by), val(c.method), L.round(c.round_id), val(c.at)]),
  'No compare rows yet.')
  const consents = table(['id', 'action', 'who', 'channel', 'at'], d.consents.map((c) => [sha(c.id), badge(c.action), val(c.who), val(c.channel), val(c.at)]), 'No consents recorded.')
  const p = d.prediction_vs_observed
  const prediction = stat([
    ['predicted', `${esc(p.predicted.metric)} ${esc(p.predicted.direction)}${p.predicted.magnitude != null ? ` by ${num(p.predicted.magnitude)}` : ''}`],
    ['predicted fixes', val((p.predicted.predicted_fixes ?? []).join(', '))],
    ['at risk', val((p.predicted.at_risk ?? []).join(', '))],
    ['observed', p.observed.length === 0 ? '<span class="muted">no judged compare carries it</span>'
      : p.observed.map((o) => `${badge(o.tier)} fixes hit <span class="tnum">${esc(o.fixes_hit)}</span>, at-risk hit <span class="tnum">${esc(o.at_risk_hit)}</span>`).join('<br>')],
  ])
  const head = `<div class="card-row"><div class="crumbs"><a href="${L.home}">← overview</a> <span class="muted">/</span> <span class="tnum" title="${esc(r.id)}">${esc(r.id.slice(0, 12))}</span> ${badge(r.status)} ${verdictBadge(r.verdict?.value, r.verdict ? { rule: r.verdict.rule } : {})}${r.verdict ? ` <span class="muted">${esc(r.verdict.rule)} · ${esc(r.verdict.by)}</span>` : ''}</div></div>`
    + `<div class="card-body"><p class="muted">${val(r.intent)}</p></div>`
  return `<section><h2>Challenger</h2>${card(head)}</section>`
    + `<section><h3>Coordinates</h3>${card(coords)}</section>`
    + `<section><h3>Lineage</h3>${card(`<div class="card-body">${crumbs}</div>`)}</section>`
    + `<section><h3>Attempts</h3>${card(attempts)}${aggregates.length ? `<p class="muted">held-out aggregates: ${aggregates.join('; ')}</p>` : ''}</section>`
    + `<section><h3>Compares</h3>${card(compares)}</section>`
    + `<section><h3>Consents</h3>${card(consents)}</section>`
    + `<section><h3>Prediction vs observed</h3>${card(prediction)}</section>`
}

export function notFoundSection(id: string, L: Links): string {
  return `<section><h2>Challenger</h2>${card(`<div class="card-body">${callout('danger', `Unknown challenger <span class="tnum">${esc(id)}</span>. <a href="${L.home}">Back to the overview</a>.`)}</div>`)}</section>`
}
