// The router and the page contract over the fake ledger: every route renders
// and has a JSON twin ending in `sources`, none of them is a stub, unknown
// rows 404, the SSE route streams, the legacy API still answers.
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { createHandler } from '../src/index.ts'
import * as bench from '../src/pages/bench.ts'
import * as challenger from '../src/pages/challenger.ts'
import * as experiment from '../src/pages/experiment.ts'
import * as experiments from '../src/pages/experiments.ts'
import * as home from '../src/pages/home.ts'
import * as notebook from '../src/pages/notebook.ts'
import * as round from '../src/pages/round.ts'
import * as servings from '../src/pages/servings.ts'
import type { PageModule, PageParams } from '../src/pages/types.ts'
import { CHAL, CHAMP, EXP, ROOT, ROUND2, SESSION, SKILL, fakeDeps, numbersInJson, untraceable } from './fixtures.ts'

function call(handler: ReturnType<typeof createHandler>, method: string, url: string) {
  let status = 0
  let type = ''
  let body = ''
  const req = Object.assign(new EventEmitter(), { method, url })
  const res = Object.assign(new EventEmitter(), {
    writableEnded: false,
    writeHead(s: number, h: Record<string, string>) { status = s; type = h['content-type'] ?? '' },
    write(chunk: string) { body += chunk },
    end(b?: string) { if (b !== undefined) body += b; res.writableEnded = true },
  })
  handler(req as never, res as never)
  return { status, type, body, close: () => req.emit('close') }
}

const handler = createHandler(fakeDeps(), { basePath: '/samsara', refreshMs: 1000 })
const get = (url: string) => call(handler, 'GET', url)

const none: Omit<PageParams, 'query'> = {}
/** url, a marker of its content, the module, and the route params that name its row. */
const PAGES: [string, string, PageModule<any>, Omit<PageParams, 'query'>][] = [
  ['/samsara', 'Champion', home, none],
  ['/samsara/', 'Champion', home, none],
  ['/samsara/experiments', 'Experiments', experiments, none],
  [`/samsara/experiments/${EXP}`, 'Experiment', experiment, { id: EXP }],
  [`/samsara/rounds/${ROUND2}`, 'Round', round, { id: ROUND2 }],
  [`/samsara/challengers/${CHAL}`, 'Coordinates', challenger, { id: CHAL }],
  ['/samsara/servings', 'Servings', servings, none],
  ['/samsara/bench', 'Bench', bench, none],
  [`/samsara/notebook/${SESSION}`, 'Notebook', notebook, { session: SESSION }],
]

describe('routes', () => {
  it.each(PAGES)('%s renders a complete themed page', (url, marker) => {
    const r = get(url)
    expect(r.status).toBe(200)
    expect(r.type).toBe('text/html; charset=utf-8')
    expect(r.body).toContain(marker)
    expect(r.body).toMatch(/^<!doctype html>/)
    expect(r.body).toContain('body[data-ds-dark-theme] {')
    expect(r.body).toContain('<a class="wordmark" href="/samsara">samsara</a>')
    expect(r.body).not.toMatch(/<script src=|<link /)
    expect(r.body).not.toContain('undefined')
  })

  it.each(PAGES)('%s has a JSON twin ending in sources', (url) => {
    const twin = url === '/samsara/' ? '/samsara/.json' : `${url}.json`
    const r = get(twin)
    expect(r.status).toBe(200)
    expect(r.type).toBe('application/json; charset=utf-8')
    const parsed = JSON.parse(r.body)
    expect(Array.isArray(parsed.sources)).toBe(true)
  })

  it('answers the home twin at <base>.json and <base>/index.json too', () => {
    for (const url of ['/samsara.json', '/samsara/index.json']) expect(JSON.parse(get(url).body)).toHaveProperty('tiers.holdin')
  })

  it('every number on the home and challenger pages appears in the twin', () => {
    for (const url of ['/samsara', `/samsara/challengers/${CHAL}`, `/samsara?challenger=${CHAL}`]) {
      const html = get(url).body
      const json = JSON.parse(get(url.includes('?') ? url.replace('?', '.json?') : `${url}.json`).body)
      expect(untraceable(html, json), url).toEqual([])
      expect(json.sources.length).toBeGreaterThan(0)
    }
  })

  it('reads every view as the operator: no held-out per-task row reaches a page, a twin or the legacy API', () => {
    const viewers = new Set<string>()
    const deps = fakeDeps()
    const read = deps.ledger.read
    deps.ledger.read = ((view, viewer) => { viewers.add(viewer); return read(view, viewer) }) as typeof read
    const h = createHandler(deps, { basePath: '/samsara', refreshMs: 1000 })
    const urls = [
      `/samsara/challengers/${CHAL}`, `/samsara/challengers/${CHAL}.json`, `/samsara/challengers/${CHAMP}.json`, `/samsara?challenger=${CHAL}`, `/samsara/index.json?challenger=${CHAL}`,
      `/samsara/rounds/${ROUND2}.json`, `/samsara/experiments/${EXP}.json`, '/samsara/api/summary', `/samsara/api/challenger/${CHAL}`, `/samsara/api/certify/${SKILL}`,
    ]
    for (const url of urls) {
      const body = call(h, 'GET', url).body
      // The held-out attempt a3 ran task t2 and scored 0.9; CHAMP's holdout compare carried per-task deltas.
      expect(body, url).not.toContain('per_task')
      expect(body, url).not.toContain('t2</td>')
      expect(body, url).not.toContain('"task_id":"t2"')
      expect(body, url).not.toContain('"a3"')
      expect(body, url).not.toMatch(/acc=<span class="tnum">0\.900/)
    }
    expect([...viewers]).toEqual(['operator'])
    // What the page shows instead: the aggregate, counted.
    const page = call(h, 'GET', `/samsara/challengers/${CHAL}`).body
    expect(page).toContain('holdout aggregate')
    expect(page).toContain('held-out aggregates: acc mean <span class="tnum">0.900</span> over 1')
  })

  it('names the attempts behind the derived cost ratio in the home twin and marks the cell derived', () => {
    const html = get('/samsara').body
    const json = JSON.parse(get('/samsara/index.json').body) as { sources: string[] }
    expect(html).toContain('<span title="derived: mean usd per attempt over the champion\'s, from 2 attempts">cost <span class="tnum">1.50</span></span>')
    for (const id of ['a1', 'a2']) expect(json.sources).toContain(id)
  })

  it('badges an underpowered hold the same on every page that shows the row', () => {
    const warn = '<span class="badge warn">hold:underpowered</span>'
    for (const url of ['/samsara', `/samsara/challengers/${CHAL}`, `/samsara/rounds/${ROUND2}`, `/samsara/experiments/${EXP}`]) {
      const body = get(url).body
      expect(body, url).toContain(warn)
      expect(body, url).not.toContain('<span class="badge neutral">hold</span> <span class="muted">power:nEff')
      expect(body, url).not.toMatch(/badge neutral">hold<\/span> mean/)
    }
  })

  it('reports a number the twin does not carry, and credits no digit run inside a sha, an id or a number tuple', () => {
    const html = get('/samsara').body.replace('</main>', '<p>7 99 2029 0.333 3.50 12.34</p></main>')
    expect(untraceable(html, JSON.parse(get('/samsara/index.json').body))).toEqual(['7', '99', '2029', '0.333', '3.50', '12.34'])
    const known = numbersInJson({ id: 'e7ac827c27b0acaa1a', name: 'consent-42', at: '2026-01-02T03:04:05Z', ci: [0.05, 0.25], rows: [{ n: 3 }, {}], gate: 'gate-default@1' })
    expect([...known].sort()).toEqual(['0.05', '0.0500', '0.050', '0.1', '0.25', '0.250', '0.2500', '0.3', '04', '1', '2', '2026', '3', '3.0', '3.00', '3.000', '3.0000'].sort())
  })

  it('404s an unknown row as a themed page or as JSON', () => {
    const page = get('/samsara/challengers/nope')
    expect(page.status).toBe(404)
    expect(page.type).toBe('text/html; charset=utf-8')
    expect(page.body).toContain('No id nope here')
    expect(get('/samsara/challengers/nope.json').status).toBe(404)
  })

  it('serves no stub: every page is built and its twin names its rows', () => {
    for (const [url] of PAGES) expect(get(url).body, url).not.toContain('Not yet')
    const twin = JSON.parse(get(`/samsara/rounds/${ROUND2}.json`).body)
    expect(twin.round.id).toBe(ROUND2)
    expect(twin.sources).toContain(ROUND2)
  })

  it('streams a known round as an event stream and 404s an unknown one', () => {
    const r = get(`/samsara/rounds/${ROUND2}/events`)
    expect(r.status).toBe(200)
    expect(r.type).toBe('text/event-stream; charset=utf-8')
    expect(r.body).toMatch(/^retry: 1000\n\n/)
    r.close()
    const missing = get('/samsara/rounds/nope/events')
    expect(missing.status).toBe(404)
    expect(missing.type).toBe('application/json; charset=utf-8')
  })

  it('keeps the legacy JSON API', () => {
    expect(JSON.parse(get('/samsara/api/summary').body)).toHaveProperty('tiers.holdin')
    expect(JSON.parse(get(`/samsara/api/challenger/${CHAL}`).body).row.id).toBe(CHAL)
    expect(JSON.parse(get(`/samsara/api/certify/${SKILL}`).body).rows).toHaveLength(1)
    expect(get('/samsara/api/challenger/nope').status).toBe(404)
  })

  it('answers 404 under and outside the prefix and 405 for non-GET', () => {
    expect(get('/samsara/api/other').status).toBe(404)
    expect(get('/samsara/x').status).toBe(404)
    expect(get('/samsarax').status).toBe(404)
    expect(get('/elsewhere').status).toBe(404)
    expect(call(handler, 'POST', '/samsara/api/summary').status).toBe(405)
  })

  it('serves at the root when basePath is /', () => {
    const rootHandler = createHandler(fakeDeps(), { basePath: '/', refreshMs: 1000 })
    expect(call(rootHandler, 'GET', '/').body).toContain('<a class="wordmark" href="/">samsara</a>')
    expect(call(rootHandler, 'GET', '/experiments').status).toBe(200)
    expect(JSON.parse(call(rootHandler, 'GET', '/experiments.json').body).page).toBe('experiments')
  })
})

describe('page contract', () => {
  it('hands every page module the same deps and params shape', () => {
    const deps = { ...fakeDeps(), base: '/samsara', refreshMs: 1000 }
    for (const [url, , page, params] of PAGES) {
      const model = page.load(deps, { ...params, query: new URLSearchParams() })
      expect(model, url).toBeDefined()
      expect(page.render(model)).toMatch(/^<!doctype html>/)
      expect(page.json(model)).toHaveProperty('sources')
    }
    expect(challenger.load(deps, { id: 'nope', query: new URLSearchParams() })).toBeUndefined()
    expect(home.load(deps, { query: new URLSearchParams() }).summary.tiers.holdout.map((r) => r.id)).toEqual([CHAL, ROOT])
  })
})
