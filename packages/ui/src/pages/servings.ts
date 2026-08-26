// `/servings` — the champion history, oldest first: who was served from when
// to when, by which transition, under which consent and profile. The one
// without `to` is served now.

import type { ServingRow } from '@oldbulb/samsara-ledger'
import { loadServings, withSources } from '../api.ts'
import { badge, card, links, sha, table, val } from '../html.ts'
import { navOf, shell } from '../theme.ts'
import type { PageBase, PageDeps, PageParams } from './types.ts'

export interface ServingsModel extends PageBase {
  servings: ServingRow[]
}

export function load(deps: PageDeps, _params: PageParams): ServingsModel {
  return { base: deps.base, refreshMs: deps.refreshMs, servings: loadServings(deps.ledger) }
}

export function render(model: ServingsModel): string {
  const L = links(model.base)
  const rows = model.servings.map((s) => [
    L.challenger(s.champion_id), val(s.from), s.to ? val(s.to) : badge('serving', 'ok'),
    badge(s.by, s.by === 'promote' ? 'ok' : 'danger'), val(s.consent_id), sha(s.profile_sha),
  ])
  return shell({
    title: 'servings',
    nav: navOf(model.base, 'servings'),
    base: model.base,
    body: `<section><h2>Servings<span class="count">${model.servings.length}</span></h2>${card(table(['champion', 'from', 'to', 'by', 'consent', 'profile sha'], rows, 'No champion served yet.'))}</section>`,
    refreshMs: model.refreshMs,
  })
}

export function json(model: ServingsModel): object {
  return withSources({ page: 'servings', servings: model.servings }, model.servings.flatMap((s) => [s.id, s.champion_id, s.consent_id]))
}
