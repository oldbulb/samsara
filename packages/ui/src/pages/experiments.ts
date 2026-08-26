// `/experiments` — the experiments table: id, hypothesis, prediction, gate,
// rounds, promotions, spent against budget, status. Read-only.

import type { ExperimentRow } from '@oldbulb/samsara-ledger'
import { loadExperiments, loadRounds, withSources } from '../api.ts'
import { DASH, badge, card, esc, int, links, num, table } from '../html.ts'
import { navOf, shell } from '../theme.ts'
import { gateLabel, predictionText } from './experiment.ts'
import type { PageBase, PageDeps, PageParams } from './types.ts'

export interface ExperimentsModel extends PageBase {
  rows: { experiment: ExperimentRow; /** The rows its rounds promoted, oldest first. */ promoted: string[] }[]
}

export function load(deps: PageDeps, _params: PageParams): ExperimentsModel {
  const rounds = loadRounds(deps.ledger)
  const rows = loadExperiments(deps.ledger).map((experiment) => ({
    experiment,
    promoted: rounds.filter((r) => r.experiment_id === experiment.id && r.outcome?.promoted).map((r) => r.outcome!.promoted!),
  }))
  return { base: deps.base, refreshMs: deps.refreshMs, rows }
}

const truncate = (s: string, n = 80) => s.length > n ? `${s.slice(0, n - 1)}…` : s

export function render(model: ExperimentsModel): string {
  const L = links(model.base)
  const rows = model.rows.map(({ experiment: e, promoted }) => [
    L.experiment(e.id),
    `<span title="${esc(e.hypothesis)}">${esc(truncate(e.hypothesis))}</span>`,
    predictionText(e.prediction),
    esc(gateLabel(e.gate)),
    int(e.round_ids.length),
    `${int(promoted.length)}${promoted.length ? ` ${promoted.map((id) => L.challenger(id)).join(' ')}` : ''}`,
    `${num(e.spent.usd, 2)} / ${e.budget.usd === undefined ? DASH : num(e.budget.usd, 2)} <span class="muted">usd</span>`,
    badge(e.status),
  ])
  return shell({
    title: 'experiments',
    nav: navOf(model.base, 'experiments'),
    base: model.base,
    body: `<section><h2>Experiments<span class="count">${model.rows.length}</span></h2>${card(table(['id', 'hypothesis', 'prediction', 'gate', 'rounds', 'promotions', 'spent / budget', 'status'], rows, 'No experiment pre-registered yet.'))}</section>`,
    refreshMs: model.refreshMs,
  })
}

export function json(model: ExperimentsModel): object {
  return withSources({ page: 'experiments', rows: model.rows }, model.rows.flatMap((r) => [r.experiment.id, ...r.experiment.round_ids, ...r.promoted]))
}
