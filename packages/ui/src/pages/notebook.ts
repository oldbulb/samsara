// `/notebook/:session` — the mirrored operator events of one session in
// order: tool calls and results, the spend approvals asked and answered,
// commands; each linking to the round and experiment it touched. Approvals
// and errors are marked. A session the ledger has no row for is not found.

import type { NotebookRow } from '@oldbulb/samsara-ledger'
import { loadNotebook, withSources } from '../api.ts'
import { DASH, badge, card, esc, int, links, sha, stat, table, val, type Tone } from '../html.ts'
import { navOf, shell } from '../theme.ts'
import type { PageBase, PageDeps, PageParams } from './types.ts'

export interface NotebookModel extends PageBase {
  session: string
  rows: NotebookRow[]
}

export function load(deps: PageDeps, params: PageParams): NotebookModel | undefined {
  const session = params.session ?? ''
  const rows = loadNotebook(deps.ledger, session)
  return rows.length === 0 ? undefined : { base: deps.base, refreshMs: deps.refreshMs, session, rows }
}

/** Approvals stand out; a result that failed reads as danger. */
function kindTone(r: NotebookRow): Tone {
  if (r.error) return 'danger'
  if (r.kind === 'approval/asked') return 'warn'
  if (r.kind === 'approval/decided') return 'ok'
  return 'neutral'
}

export function render(model: NotebookModel): string {
  const L = links(model.base)
  const first = model.rows[0]!
  const head = stat([
    ['session', `<span class="tnum">${esc(model.session)}</span>`],
    ['operator', `${val(first.operator.provider)} <span class="muted">/</span> ${val(first.operator.model)}`],
    ['events', int(model.rows.length)],
    ['from', val(first.at)],
    ['to', val(model.rows.at(-1)!.at)],
  ])
  const rows = model.rows.map((r) => [
    int(r.seq), val(r.at), badge(r.kind, kindTone(r)), val(r.name), r.error ? badge(r.error, 'danger') : DASH,
    L.round(r.round_id), L.experiment(r.experiment_id), sha(r.args_sha), sha(r.result_sha),
  ])
  return shell({
    title: `notebook ${model.session.slice(0, 12)}`,
    nav: navOf(model.base),
    base: model.base,
    body: `<section><h2>Notebook</h2>${card(head)}</section>`
      + `<section><h3>Events</h3>${card(table(['seq', 'at', 'kind', 'name', 'error', 'round', 'experiment', 'args sha', 'result sha'], rows))}</section>`,
    refreshMs: model.refreshMs,
  })
}

export function json(model: NotebookModel): object {
  return withSources({ page: 'notebook', session: model.session, rows: model.rows }, model.rows.flatMap((r) => [r.id, r.round_id, r.experiment_id]))
}
