// The page contract the router speaks: `load` gathers a model from the deps
// (ledger reads as VIEWER, lifecycle helpers), `render` formats it as a
// complete document, `json` is the twin every number on the page traces to.
// A page never computes a statistic; it formats what the ledger recorded.

import type { UiDeps } from '../api.ts'

export interface PageDeps extends UiDeps {
  /** The route prefix, no trailing slash (`/` when mounted at the root). */
  base: string
  refreshMs: number
}

export interface PageParams {
  /** The row id of an `/experiments/:id`, `/rounds/:id` or `/challengers/:id` route. */
  id?: string
  /** The session of a `/notebook/:session` route. */
  session?: string
  query: URLSearchParams
}

export interface PageModule<M> {
  /** `undefined` when the route names a row the ledger does not have. */
  load(deps: PageDeps, params: PageParams): M | undefined
  render(model: M): string
  json(model: M): object
}

/** What every model carries so `render` can link and refresh. */
export interface PageBase {
  base: string
  refreshMs: number
}
