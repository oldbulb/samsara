// @oldbulb/samsara-ui — host plugin `samsara-ui`: one prefix route on ctx.webServer
// serving the read-only /samsara pages, each with a JSON twin, the live event
// stream of a round, plus the legacy JSON API. Config comes from the row
// (never the command line: a co-resident web-app startup row would reject
// unknown flags). Sign-off never goes through HTTP (E2): the pages only show
// the command to run.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context, Schema } from '@oldbulb/samsara-kernel'
// Value imports so the ctx.ledger / ctx.champion / ctx.signoff augmentations are installed.
import '@oldbulb/samsara-ledger'
import '@oldbulb/samsara-champion'
import '@oldbulb/samsara-signoff'
import { buildCertification, buildChallenger, buildSummary, loadRound, type UiDeps } from './api.ts'
import { callout, card, esc } from './html.ts'
import * as bench from './pages/bench.ts'
import * as challenger from './pages/challenger.ts'
import * as experiment from './pages/experiment.ts'
import * as experiments from './pages/experiments.ts'
import * as home from './pages/home.ts'
import * as notebook from './pages/notebook.ts'
import * as round from './pages/round.ts'
import * as servings from './pages/servings.ts'
import type { PageDeps, PageModule, PageParams } from './pages/types.ts'
import { sseLifecycleOf, streamRoundEvents } from './sse.ts'
import { navOf, shell } from './theme.ts'

export * from './api.ts'
export * from './charts.ts'
export * from './html.ts'
export * from './sse.ts'
export * from './theme.ts'
export type { PageBase, PageDeps, PageModule, PageParams } from './pages/types.ts'

export const name = 'samsara-ui'
export const inject = ['webServer', 'ledger', 'champion', 'signoff']

export interface Config {
  /** Absolute path prefix the pages and API live under (no trailing slash). */
  basePath?: string
  /** How often a page re-fetches itself. */
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

interface Route {
  pattern: RegExp
  page: PageModule<any>
  /** Which param the first capture group fills. */
  param?: 'id' | 'session'
}

/** The pages under the prefix; `/` and `/index` are the home page. Every page answers `.json` too. */
const ROUTES: Route[] = [
  { pattern: /^\/?$/, page: home },
  { pattern: /^\/index$/, page: home },
  { pattern: /^\/experiments$/, page: experiments },
  { pattern: /^\/experiments\/([^/]+)$/, page: experiment, param: 'id' },
  { pattern: /^\/rounds\/([^/]+)$/, page: round, param: 'id' },
  { pattern: /^\/challengers\/([^/]+)$/, page: challenger, param: 'id' },
  { pattern: /^\/servings$/, page: servings },
  { pattern: /^\/bench$/, page: bench },
  { pattern: /^\/notebook\/([^/]+)$/, page: notebook, param: 'session' },
]

function notFoundPage(base: string, what: string): string {
  return shell({
    title: 'not found',
    nav: navOf(base),
    base,
    body: `<section><h2>Not found</h2>${card(`<div class="card-body">${callout('danger', `No ${esc(what)} here. <a href="${base}/">Back to the overview</a>.`)}</div>`)}</section>`,
  })
}

/** The request handler, independent of the Context so tests can call it with a fake deps object. */
export function createHandler(deps: UiDeps, config: { basePath: string; refreshMs: number }): Handler {
  const base = config.basePath.replace(/\/+$/, '') || '/'
  const prefix = base === '/' ? '' : base
  const pageDeps: PageDeps = { ledger: deps.ledger, champion: deps.champion, signoff: deps.signoff, get lifecycle() { return deps.lifecycle }, base: prefix, refreshMs: config.refreshMs }
  return (req, res) => {
    if (req.method !== 'GET') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    const url = new URL(req.url ?? '/', 'http://x')
    const pathname = url.pathname
    let rest: string | undefined
    if (pathname === base || pathname === `${prefix}.json`) rest = pathname.slice(prefix.length)
    else if (pathname.startsWith(`${prefix}/`)) rest = pathname.slice(prefix.length)
    if (rest === undefined) {
      json(res, 404, { error: 'not found' })
      return
    }

    // Legacy JSON API.
    if (rest === '/api/summary') {
      json(res, 200, buildSummary(deps))
      return
    }
    const legacyChallenger = /^\/api\/challenger\/([^/]+)$/.exec(rest)
    if (legacyChallenger) {
      const detail = buildChallenger(deps, decodeURIComponent(legacyChallenger[1]!))
      if (detail) json(res, 200, detail)
      else json(res, 404, { error: 'unknown challenger' })
      return
    }
    const certify = /^\/api\/certify\/([^/]+)$/.exec(rest)
    if (certify) {
      json(res, 200, buildCertification(deps, decodeURIComponent(certify[1]!)))
      return
    }

    // Live progress of a round: the lifecycle events that name it, as SSE.
    const events = /^\/rounds\/([^/]+)\/events$/.exec(rest)
    if (events) {
      const roundId = decodeURIComponent(events[1]!)
      if (!loadRound(deps.ledger, roundId)) json(res, 404, { error: 'unknown round' })
      else streamRoundEvents(sseLifecycleOf(deps.lifecycle), req, res, { roundId, refreshMs: config.refreshMs })
      return
    }

    const wantJson = rest.endsWith('.json')
    const path = wantJson ? rest.slice(0, -'.json'.length) : rest
    for (const route of ROUTES) {
      const m = route.pattern.exec(path)
      if (!m) continue
      const value = route.param && m[1] !== undefined ? decodeURIComponent(m[1]) : undefined
      const params: PageParams = { query: url.searchParams, ...(route.param && value !== undefined ? { [route.param]: value } : {}) }
      const model = route.page.load(pageDeps, params)
      if (model === undefined) {
        if (wantJson) json(res, 404, { error: 'not found' })
        else send(res, 404, HTML_MIME, notFoundPage(prefix, `${route.param ?? 'page'} ${value ?? path}`))
        return
      }
      if (wantJson) json(res, 200, route.page.json(model))
      else send(res, 200, HTML_MIME, route.page.render(model))
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
    // Optional: the lifecycle row may mount after this one, so it is looked up per request.
    get lifecycle() { return ctx.get('lifecycle') },
  }
  const handler = createHandler(deps, { basePath, refreshMs })
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: basePath.replace(/\/+$/, '') || '/', handler }),
    `samsara-ui: ${basePath} route`,
  )
}
