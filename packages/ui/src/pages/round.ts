// `/rounds/:id` — one round: the gate it pinned (name@version, policy sha),
// the noise floor it judged under, the siblings with their promotion and
// shadow compares side by side, the outcome, the next actions per sibling
// (with costs, from the lifecycle service when it is mounted), and the
// attempt progress, kept live over `/rounds/:id/events` while the round is
// open. The page is complete without JS; the script only moves the status and
// attempt counters between two refreshes.

import type { ChallengerRow, CompareWithoutTasks, ConsentRow, NoiseFloorRow, RoundRow, Tier, ViewRows } from '@oldbulb/samsara-ledger'
import type { NextAction, PendingConsent } from '@oldbulb/samsara-lifecycle'
import { VIEWER, compareSource, loadConsents, loadNoiseFloors, loadRound, withSources } from '../api.ts'
import { DASH, badge, callout, card, codeBlock, empty, esc, int, links, num, sha, stat, table, val, verdictBadge, type Links } from '../html.ts'
import { REFRESHED_EVENT, navOf, shell } from '../theme.ts'
import type { PageBase, PageDeps, PageParams } from './types.ts'

const TIERS: Tier[] = ['smoke', 'holdin', 'holdout', 'live']

export interface TierProgress {
  tier: Tier
  n: number
  by_status: Record<string, number>
  /** The attempt rows counted (a held-out aggregate counts as `<challenger>:<tier>`). */
  ids: string[]
}

export interface RoundSibling {
  row: ChallengerRow
  /** The promotion-gate compare rows of this round, oldest first (one per tier judged). */
  promotion: CompareWithoutTasks[]
  /** The shadow rows of this round, oldest first. */
  shadows: CompareWithoutTasks[]
  attempts: TierProgress[]
  /** Absent when the lifecycle service is not mounted or could not answer for the row. */
  nextActions?: NextAction[]
}

export interface RoundModel extends PageBase {
  round: RoundRow
  noiseFloor?: NoiseFloorRow
  /** The consent the outcome names. */
  consent?: ConsentRow
  /** The consent the round waits on, from `lifecycle.status()`. */
  pending: PendingConsent[]
  siblings: RoundSibling[]
  lifecycle: boolean
}

/** The operator view carries every row minus its per-task deltas; the type also allows the proposer's aggregates. */
function isRow(c: ViewRows['compares'][number]): c is CompareWithoutTasks {
  return !('redacted' in c)
}

/** Attempt counts per tier of one row; a held-out aggregate counts by its `n`. */
function progressOf(attempts: ViewRows['attempts'], id: string): TierProgress[] {
  const out: TierProgress[] = []
  for (const tier of TIERS) {
    const p: TierProgress = { tier, n: 0, by_status: {}, ids: [] }
    for (const a of attempts) {
      if (a.challenger_id !== id || a.tier !== tier) continue
      if ('redacted' in a) {
        p.n += a.n
        for (const [k, v] of Object.entries(a.by_status)) p.by_status[k] = (p.by_status[k] ?? 0) + v
        p.ids.push(`${id}:${tier}`)
      } else {
        p.n += 1
        p.by_status[a.status] = (p.by_status[a.status] ?? 0) + 1
        p.ids.push(a.id)
      }
    }
    if (p.n > 0) out.push(p)
  }
  return out
}

export function load(deps: PageDeps, params: PageParams): RoundModel | undefined {
  const { ledger, lifecycle } = deps
  const round = loadRound(ledger, params.id ?? '')
  if (!round) return undefined
  const attempts = ledger.read('attempts', VIEWER)
  const compares = ledger.read('compares', VIEWER).filter(isRow).filter((c) => c.round_id === round.id).sort((a, b) => a.at.localeCompare(b.at))
  const siblings: RoundSibling[] = []
  for (const id of round.sibling_ids) {
    const row = ledger.challenger(id)
    if (!row) continue
    const own = compares.filter((c) => c.challenger_id === id)
    let nextActions: NextAction[] | undefined
    if (lifecycle) {
      try { nextActions = lifecycle.nextActions(id) } catch { nextActions = undefined }
    }
    siblings.push({ row, promotion: own.filter((c) => !c.shadow), shadows: own.filter((c) => c.shadow === true), attempts: progressOf(attempts, id), ...(nextActions ? { nextActions } : {}) })
  }
  const noiseFloor = round.noise_floor_id ? loadNoiseFloors(ledger).find((f) => f.id === round.noise_floor_id) : undefined
  const consent = round.outcome?.consent_id ? loadConsents(ledger).find((c) => c.id === round.outcome?.consent_id) : undefined
  const pending = lifecycle ? lifecycle.status().pending.filter((p) => p.roundId === round.id) : []
  return {
    base: deps.base, refreshMs: deps.refreshMs, round,
    ...(noiseFloor ? { noiseFloor } : {}), ...(consent ? { consent } : {}),
    pending, siblings, lifecycle: lifecycle !== undefined,
  }
}

export function render(model: RoundModel): string {
  const L = links(model.base)
  const r = model.round
  return shell({
    title: `round ${r.id.slice(0, 12)}`,
    nav: navOf(model.base, 'rounds'),
    base: model.base,
    body: headSection(model, L) + gateSection(model) + siblingsSection(model, L) + outcomeSection(model, L) + actionsSection(model, L) + progressSection(model, L)
      + (r.status === 'open' ? liveScript(model) : ''),
    refreshMs: model.refreshMs,
  })
}

export function json(model: RoundModel): object {
  const { base: _base, refreshMs: _refresh, ...rest } = model
  const r = model.round
  return withSources(rest, [
    r.id, r.champion_id, r.experiment_id, r.noise_floor_id, r.outcome?.consent_id, r.outcome?.promoted, ...(r.outcome?.superseded ?? []),
    ...model.pending.map((p) => p.candidate),
    ...model.siblings.flatMap((s) => [s.row.id, ...s.promotion.map(compareSource), ...s.shadows.map(compareSource), ...s.attempts.flatMap((p) => p.ids)]),
  ])
}

const gateRef = (g: RoundRow['gate']) => `<span class="tnum">${esc(g.name)}@${esc(g.version)}</span> <span class="muted">policy ${sha(g.policy_sha)}</span>`

function headSection(m: RoundModel, L: Links): string {
  const r = m.round
  const head = `<div class="card-row"><div class="crumbs"><a href="${L.home}">← overview</a> <span class="muted">/</span> `
    + `<span class="tnum" title="${esc(r.id)}">${esc(r.id.slice(0, 12))}</span> ${badge(r.status)} <span class="muted">opened ${esc(r.opened_at)}${r.closed_at ? ` · closed ${esc(r.closed_at)}` : ''}</span></div></div>`
  const body = stat([
    ['champion', L.challenger(r.champion_id)],
    ['experiment', L.experiment(r.experiment_id)],
    ['siblings', `<span class="tnum">${esc(r.k)}</span> <span class="muted">(Holm over k)</span>`],
    ['best so far', num(r.best_so_far)],
    ['eval config', sha(r.eval_config_sha)],
    ['profile sha', sha(r.profile_sha)],
    ['operator', r.operator ? `${L.notebook(r.operator.session_id)}${r.operator.provider || r.operator.model ? ` <span class="muted">${esc(r.operator.provider ?? '')} / ${esc(r.operator.model ?? '')}</span>` : ''}` : DASH],
  ])
  return `<section><h2>Round</h2>${card(head + body)}</section>`
}

function gateSection(m: RoundModel): string {
  const r = m.round
  const f = m.noiseFloor
  const floor = f
    ? `${sha(f.id)} <span class="muted">·</span> sd_paired ${num(f.sd_paired)} <span class="muted">per ${esc(f.unit)}</span> · ${int(f.n_reruns)} reruns × ${int(f.n_tasks)} tasks · ${badge(f.tier)} · ${esc(f.metric)} / ${esc(f.loop)} <span class="muted">· measured ${esc(f.measured_at)}</span>`
    : r.noise_floor_id ? `${sha(r.noise_floor_id)} <span class="muted">not in the ledger</span>` : '<span class="muted">none pinned</span>'
  return `<section><h3>Gate</h3>${card(stat([
    ['promotion gate', gateRef(r.gate)],
    ['shadow gates', r.shadow_gates.length === 0 ? '<span class="muted">none</span>' : r.shadow_gates.map(gateRef).join('<br>')],
    ['noise floor', floor],
  ]))}</section>`
}

/** One compare row as a line: tier, verdict, the numbers, the rule. */
function compareLine(c: CompareWithoutTasks, shadow: boolean): string {
  return `${badge(c.tier)} ${verdictBadge(c.verdict.value, { rule: c.rule_fired, ...(shadow ? { shadow: true, gate: c.gate ?? null } : {}) })} mean ${num(c.mean)} ci [${num(c.ci[0])}, ${num(c.ci[1])}] n_eff ${val(c.n_eff)} mde ${num(c.mde)} <span class="muted">${esc(c.rule_fired)}</span>`
}

function siblingsSection(m: RoundModel, L: Links): string {
  const r = m.round
  const shadowNames = r.shadow_gates.map((g) => `${g.name}@${g.version}`)
  const cols = ['sibling', 'surface', 'status', 'tier', 'verdict', `${r.gate.name}@${r.gate.version}`, ...shadowNames.map((n) => `shadow ${n}`)]
  const rows = m.siblings.map((s) => [
    L.challenger(s.row.id), val(s.row.surface), badge(s.row.status), badge(s.row.tier_reached),
    s.row.verdict ? `${verdictBadge(s.row.verdict.value, { rule: s.row.verdict.rule })} <span class="muted">${esc(s.row.verdict.rule)} · ${esc(s.row.verdict.by)}</span>` : DASH,
    s.promotion.length === 0 ? DASH : s.promotion.map((c) => compareLine(c, false)).join('<br>'),
    ...shadowNames.map((n) => {
      const own = s.shadows.filter((c) => c.gate === n)
      return own.length === 0 ? DASH : own.map((c) => compareLine(c, true)).join('<br>')
    }),
  ])
  return `<section><h3>Siblings<span class="count">${m.siblings.length}</span></h3>${card(rows.length ? table(cols, rows) : `<div class="card-body">${empty('No sibling rows in the ledger.')}</div>`)}</section>`
}

function outcomeSection(m: RoundModel, L: Links): string {
  const r = m.round
  const o = r.outcome
  let body: string
  if (o?.aborted) body = callout('danger', `${badge('aborted', 'danger')} closed by reconciliation: its running siblings were judged invalid, nothing was decided.`)
  else if (o) {
    body = stat([
      ['promoted', o.promoted ? L.challenger(o.promoted) : '<span class="muted">none</span>'],
      ['superseded', o.superseded.length === 0 ? '<span class="muted">none</span>' : o.superseded.map((id) => L.challenger(id)).join(' ')],
      ['consent', m.consent ? `${sha(m.consent.id)} ${badge(m.consent.action)} <span class="muted">${esc(m.consent.who)} · ${esc(m.consent.channel)} · ${esc(m.consent.at)}</span>` : o.consent_id ? sha(o.consent_id) : DASH],
    ])
  } else {
    const waits = m.pending.map((p) =>
      callout('warn', `Waiting on a ${badge(p.action)} consent for ${L.challenger(p.candidate)} <span class="muted">· the decision needs a sign-off, never this page</span>`)
      + codeBlock('/samsara approve', `/samsara approve ${p.candidate}`)).join('')
    body = `<div class="card-body">${empty(r.status === 'open' ? 'Open: nothing decided yet.' : 'Judged: awaiting the decision.')}${waits}</div>`
  }
  return `<section><h3>Outcome</h3>${card(body)}</section>`
}

function actionsSection(m: RoundModel, L: Links): string {
  if (!m.lifecycle) return `<section><h3>Next actions</h3>${card(`<div class="card-body">${callout('', 'Next actions and their costs come from the lifecycle service, which is not mounted.')}</div>`)}</section>`
  const cols = ['sibling', 'action', 'tier', 'attempts', 'usd', 'rule', 'mde', 'n_eff', 'replicates', 'min effect', 'sd', 'budget']
  const rows = m.siblings.flatMap((s) => {
    if (!s.nextActions) return [[L.challenger(s.row.id), '<span class="muted">unavailable</span>', DASH, DASH, DASH, DASH, DASH, DASH, DASH, DASH, DASH, DASH]]
    return s.nextActions.map((a) => [
      L.challenger(s.row.id), badge(a.kind), badge(a.tier), int(a.estimate?.attempts), num(a.estimate?.usd, 2),
      val(a.numbers?.rule), num(a.numbers?.mde), int(a.numbers?.n_eff), int(a.numbers?.replicates), num(a.numbers?.min_effect), num(a.numbers?.sd),
      a.budget ? `${int(a.budget.remaining)} <span class="muted">remaining</span> · ${int(a.budget.spent)} <span class="muted">spent</span>` : DASH,
    ])
  })
  return `<section><h3>Next actions</h3>${card(rows.length ? table(cols, rows) : `<div class="card-body">${empty('Nothing to do: no sibling in this round.')}</div>`)}</section>`
}

function progressCells(p: TierProgress[], id: string): string[] {
  return TIERS.map((tier) => {
    const t = p.find((x) => x.tier === tier)
    if (!t) return `<span data-field="attempts-${tier}" class="muted">—</span>`
    return `<span class="tnum" data-field="attempts-${tier}">${esc(t.n)}</span> ${Object.entries(t.by_status).map(([k, v]) => `${badge(k)}<span class="tnum muted">×${esc(v)}</span>`).join(' ')}`
  }).map((cell) => `<span data-sibling="${esc(id)}">${cell}</span>`)
}

function progressSection(m: RoundModel, L: Links): string {
  const r = m.round
  const cols = ['row', 'status', ...TIERS]
  // An attempt row carries no round, and the champion runs in many: its counters of this round come only
  // from the live stream, so its row is there (empty) only while the round is open. A sibling belongs to one round.
  const rows = [
    ...(r.status === 'open' ? [[`${L.challenger(r.champion_id)} <span class="muted">champion · live only</span>`, DASH, ...progressCells([], r.champion_id)]] : []),
    ...m.siblings.map((s) => [L.challenger(s.row.id), `<span data-sibling="${esc(s.row.id)}"><span data-field="status">${badge(s.row.status)}</span></span>`, ...progressCells(s.attempts, s.row.id)]),
  ]
  const live = r.status === 'open' ? `<p class="caption" id="progress-live">live while the round is open · sibling attempts as recorded, the champion's as streamed</p>` : ''
  return `<section id="progress"><h3>Progress</h3>${card(table(cols, rows))}${live}</section>`
}

/**
 * Subscribes to the round's events and moves the status and attempt
 * counters; the page is complete without it. The refresh script replaces
 * `<main>` wholesale, so nothing is held on to: every write looks its node
 * up, and the streamed values are kept and written again after each swap
 * (they are newer than the ledger's until the round closes).
 */
function liveScript(m: RoundModel): string {
  const url = `${m.base}/rounds/${encodeURIComponent(m.round.id)}/events`
  return `<script>
(() => {
  if (!window.EventSource) return;
  const src = new EventSource(${JSON.stringify(url)});
  const cell = (id, field) => document.querySelector('[data-sibling="' + id + '"] [data-field="' + field + '"]');
  const say = (text) => { const live = document.getElementById('progress-live'); if (live) live.textContent = text; };
  const seen = new Map();
  let caption = '';
  const show = (id, field, text) => {
    const el = cell(id, field);
    if (!el) return;
    if (field === 'status') (el.querySelector('.badge') || el).textContent = text;
    else el.textContent = text;
  };
  const put = (id, field, text, line) => { seen.set(id + ':' + field, [id, field, text]); show(id, field, text); caption = line; say(line); };
  document.addEventListener(${JSON.stringify(REFRESHED_EVENT)}, () => {
    for (const [id, field, text] of seen.values()) show(id, field, text);
    if (caption) say(caption);
  });
  src.addEventListener('challenger/transition', (ev) => {
    const e = JSON.parse(ev.data);
    put(e.challengerId, 'status', e.status, e.status + ' at ' + e.at);
  });
  src.addEventListener('attempt/progress', (ev) => {
    const e = JSON.parse(ev.data);
    put(e.challengerId, 'attempts-' + e.tier, e.done + ' / ' + e.total, e.tier + ' ' + e.done + ' / ' + e.total + ' at ' + e.at);
  });
  const done = () => { src.close(); seen.clear(); caption = ''; say('round closed; refreshing'); };
  src.addEventListener('round/closed', done);
  src.addEventListener('round/decided', done);
  src.onerror = () => say('live stream offline');
})();
</script>
`
}
