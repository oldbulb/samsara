// @samsara/ui — host plugin `samsara-ui`: one prefix route on ctx.webServer
// serving the read-only /samsara page and its JSON API. Config comes from the
// row (never the command line: a co-resident web-app startup row would reject
// unknown flags). Sign-off never goes through HTTP (E2): the page only shows
// the command to run.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context, Schema } from '@samsara/kernel'
// Value imports so the ctx.ledger / ctx.champion / ctx.signoff augmentations are installed.
import '@samsara/ledger'
import '@samsara/champion'
import '@samsara/signoff'
import { buildCertification, buildChallenger, buildSummary, type UiDeps } from './api.ts'
import { renderPage } from './page.ts'

export * from './api.ts'
export { renderPage } from './page.ts'

export const name = 'samsara-ui'
export const inject = ['webServer', 'ledger', 'champion', 'signoff']

export interface Config {
  /** Absolute path prefix the page and API live under (no trailing slash). */
  basePath?: string
  /** How often the page re-fetches the API. */
  refreshMs?: number
}

export const Config: Schema<Config> = Schema.object({
  basePath: Schema.string().default('/samsara'),
  refreshMs: Schema.number().default(5000),
})

export type Handler = (req: IncomingMessage, res: ServerResponse) => void

const JSON_MIME = 'application/json; charset=utf-8'
const HTML_MIME = 'text/html; charset=utf-8'

function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, { 'content-type': type })
  res.end(body)
}

function json(res: ServerResponse, status: number, value: unknown): void {
  send(res, status, JSON_MIME, JSON.stringify(value))
}

/** The request handler, independent of the Context so tests can call it with a fake deps object. */
export function createHandler(deps: UiDeps, config: { basePath: string; refreshMs: number }): Handler {
  const base = config.basePath.replace(/\/+$/, '') || '/'
  const page = renderPage(base, config.refreshMs)
  return (req, res) => {
    if (req.method !== 'GET') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    const pathname = new URL(req.url ?? '/', 'http://x').pathname
    const rest = pathname === base ? '' : pathname.startsWith(`${base}/`) ? pathname.slice(base.length) : undefined
    if (rest === undefined) {
      json(res, 404, { error: 'not found' })
      return
    }
    if (rest === '' || rest === '/') {
      send(res, 200, HTML_MIME, page)
      return
    }
    if (rest === '/api/summary') {
      json(res, 200, buildSummary(deps))
      return
    }
    const challenger = /^\/api\/challenger\/([^/]+)$/.exec(rest)
    if (challenger) {
      const detail = buildChallenger(deps, decodeURIComponent(challenger[1]!))
      if (detail) json(res, 200, detail)
      else json(res, 404, { error: 'unknown challenger' })
      return
    }
    const certify = /^\/api\/certify\/([^/]+)$/.exec(rest)
    if (certify) {
      json(res, 200, buildCertification(deps, decodeURIComponent(certify[1]!)))
      return
    }
    json(res, 404, { error: 'not found' })
  }
}

export function apply(ctx: Context, config: Config): void {
  const basePath = config.basePath ?? '/samsara'
  const refreshMs = config.refreshMs ?? 5000
  const deps: UiDeps = {
    ledger: ctx.ledger,
    champion: ctx.champion,
    signoff: { pending: () => ctx.signoff.pending(), socketPath: ctx.signoff.config.socketPath },
  }
  const handler = createHandler(deps, { basePath, refreshMs })
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: basePath.replace(/\/+$/, '') || '/', handler }),
    `samsara-ui: ${basePath} route`,
  )
}
