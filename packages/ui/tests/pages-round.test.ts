// The round page with and without the lifecycle service, its SSE route
// (one event streamed, then closed on client abort), the bench page with and
// without a result under its dir, the home strip's onboarding hints in each
// empty state, and traceability: every number on those pages is in the twin.
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { LifecycleEvent } from '@oldbulb/samsara-lifecycle'
import type { View, ViewRows } from '@oldbulb/samsara-ledger'
import { compareSource, createHandler } from '../src/index.ts'
import * as bench from '../src/pages/bench.ts'
import * as home from '../src/pages/home.ts'
import * as round from '../src/pages/round.ts'
import { formatEvent, roundOf, sseLifecycleOf, streamRoundEvents, wireEvent } from '../src/sse.ts'
import { CHAL, CHAL2, CHAMP, EXP, FLOOR2, ROOT, ROUND1, ROUND2, ROUND3, compares, fakeDeps, untraceable } from './fixtures.ts'

const withLifecycle = { ...fakeDeps(), base: '/samsara', refreshMs: 1000 }
const withoutLifecycle = { ...fakeDeps(), lifecycle: undefined, base: '/samsara', refreshMs: 1000 }
const q = (init: Record<string, string> = {}) => new URLSearchParams(init)

/** Deps whose ledger answers empty for the given views. */
function depsWithout(...views: View[]) {
  const deps = fakeDeps()
  const read = deps.ledger.read
  deps.ledger.read = <N extends View>(view: N, viewer: 'proposer' | 'gate' | 'human') => (views.includes(view) ? [] : read(view, viewer)) as ViewRows[N]
  deps.lifecycle = undefined
  return { ...deps, base: '/samsara', refreshMs: 1000 }
}

describe('round page', () => {
  it('pins the gate, the noise floor and the siblings with promotion and shadow compares side by side', () => {
    const model = round.load(withLifecycle, { id: ROUND2, query: q() })!
    expect(model.round.id).toBe(ROUND2)
    expect(model.noiseFloor?.id).toBe(FLOOR2)
    expect(model.siblings.map((s) => s.row.id)).toEqual([CHAL])
    expect(model.siblings[0]!.promotion).toHaveLength(1)
    expect(model.siblings[0]!.shadows).toHaveLength(1)
    const html = round.render(model)
    expect(html).toContain('<span class="tnum">gate-default@1</span>')
    expect(html).toContain('policy <span class="tnum"')
    expect(html).toContain('<span class="tnum">keep-better@0.1.0</span>')
    expect(html).toContain('sd_paired <span class="tnum">0.100</span>')
    expect(html).toContain('<th>gate-default@1</th><th>shadow keep-better@0.1.0</th>')
    expect(html).toContain('<span class="badge warn">hold:underpowered</span> mean <span class="tnum">0.200</span>')
    expect(html).toContain('<span class="badge ok">promote</span> <span class="badge neutral">shadow</span> <span class="muted">keep-better@0.1.0</span>')
    expect(html).toContain('<a class="pill active" href="/samsara/#rounds" aria-current="page">Rounds</a>')
    expect(html).not.toContain('undefined')
  })

  it('lists the next actions per sibling with their costs when the lifecycle service is present', () => {
    const html = round.render(round.load(withLifecycle, { id: ROUND2, query: q() })!)
    expect(html).toContain('<th>sibling</th><th>action</th><th>tier</th><th>attempts</th><th>usd</th>')
    for (const kind of ['replicate', 'holdout', 'drop']) expect(html).toContain(`>${kind}</span></td>`)
    expect(html).toContain('<span class="tnum">2.00</span>')
    expect(html).toContain('<span class="tnum">4</span> <span class="muted">remaining</span>')
    // The consent the round waits on, with the command to run from the workbench.
    expect(html).toContain('class="callout warn"')
    expect(html).toContain(`data-copy="/samsara approve ${CHAL}"`)
  })

  it('renders without the lifecycle service: no next actions, no pending consent, still every compare', () => {
    const model = round.load(withoutLifecycle, { id: ROUND2, query: q() })!
    expect(model.lifecycle).toBe(false)
    expect(model.pending).toEqual([])
    expect(model.siblings[0]!.nextActions).toBeUndefined()
    const html = round.render(model)
    expect(html).toContain('Next actions and their costs come from the lifecycle service, which is not mounted.')
    expect(html).not.toContain('/samsara approve')
    expect(html).toContain('<th>gate-default@1</th>')
    expect(html).not.toContain('undefined')
  })

  it('shows the outcome of a decided round: the promoted row, the consent', () => {
    const model = round.load(withLifecycle, { id: ROUND1, query: q() })!
    expect(model.consent?.id).toBe('consent-1')
    const html = round.render(model)
    expect(html).toContain(`<dt>promoted</dt><dd><a class="tnum" title="${CHAMP}"`)
    expect(html).toContain('<span class="badge ok">promote</span> <span class="muted">me · unix-socket')
    expect(html).not.toContain('<script>\n(() => {\n  if (!window.EventSource) return;')
  })

  it('opens the event stream and marks the counters only while the round is open', () => {
    const open = round.render(round.load(withLifecycle, { id: ROUND3, query: q() })!)
    expect(open).toContain(`new EventSource("/samsara/rounds/${ROUND3}/events")`)
    expect(open).toContain(`data-sibling="${CHAL2}"`)
    expect(open).toContain('data-field="status"')
    expect(open).toContain('data-field="attempts-holdin"')
    expect(open).toContain('id="progress-live"')
    expect(open).toContain('Open: nothing decided yet.')
    const judged = round.render(round.load(withLifecycle, { id: ROUND2, query: q() })!)
    expect(judged).not.toContain('new EventSource')
    expect(judged).toContain('Judged: awaiting the decision.')
  })

  it('survives the page refresh: the live script holds no node and writes its values again after every swap of <main>', () => {
    const open = round.render(round.load(withLifecycle, { id: ROUND3, query: q() })!)
    const script = open.slice(open.indexOf('if (!window.EventSource) return;'), open.indexOf('src.onerror'))
    // Both scripts are on the page: the refresh swaps <main> and announces it, the live one listens.
    expect(open).toContain('setInterval(refresh, REFRESH)')
    expect(open).toContain("document.dispatchEvent(new Event(\"samsara:refreshed\"))")
    expect(script).toContain('document.addEventListener("samsara:refreshed", () => {')
    expect(script).toContain('for (const [id, field, text] of seen.values()) show(id, field, text);')
    // The caption is looked up on every write, never captured once.
    expect(script).not.toContain("\n  const live = document.getElementById('progress-live')")
    expect(script).toContain("const say = (text) => { const live = document.getElementById('progress-live'); if (live) live.textContent = text; };")
    // Streamed values are remembered until the round closes, then dropped so the ledger's count shows.
    expect(script).toContain("seen.set(id + ':' + field, [id, field, text])")
    expect(script).toContain("const done = () => { src.close(); seen.clear(); caption = ''; say('round closed; refreshing'); };")
  })

  it('counts no lifetime attempts for the champion: an attempt row has no round, so its row is a live-only target while open', () => {
    // CHAMP's only attempt (a1) was its sibling run in round 1: neither round 2 nor round 3 may show it.
    const open = round.load(withLifecycle, { id: ROUND3, query: q() })!
    expect(open).not.toHaveProperty('champion')
    const html = round.render(open)
    expect(html).toContain(`champion · live only`)
    expect(html).toContain(`<span data-sibling="${CHAMP}"><span data-field="attempts-holdin" class="muted">—</span></span>`)
    expect(html).not.toContain(`<span data-sibling="${CHAMP}"><span class="tnum" data-field="attempts-holdin">1</span>`)
    expect(html).toContain('the champion\'s as streamed')
    expect((round.json(open) as { sources: string[] }).sources).not.toContain('a1')
    const judged = round.render(round.load(withLifecycle, { id: ROUND2, query: q() })!)
    expect(judged).not.toContain('champion · live only')
    expect(judged).not.toContain(`data-sibling="${CHAMP}"`)
    expect((round.json(round.load(withLifecycle, { id: ROUND2, query: q() })!) as { sources: string[] }).sources).not.toContain('a1')
  })

  it('is undefined for an unknown round', () => {
    expect(round.load(withLifecycle, { id: 'nope', query: q() })).toBeUndefined()
  })

  it('traces every number to the twin, with and without the lifecycle service', () => {
    for (const deps of [withLifecycle, withoutLifecycle]) {
      for (const id of [ROUND1, ROUND2, ROUND3]) {
        const model = round.load(deps, { id, query: q() })!
        const json = round.json(model) as { sources: string[] }
        expect(untraceable(round.render(model), json), id).toEqual([])
        expect(json.sources).toContain(id)
        expect(json.sources).toContain(model.round.champion_id)
        expect(json.sources).toContain(EXP)
      }
    }
    const twin = round.json(round.load(withLifecycle, { id: ROUND2, query: q() })!) as { sources: string[] }
    expect(twin.sources).toContain(CHAL)
    expect(twin.sources).toContain(FLOOR2)
    expect(twin.sources).toContain(compareSource(compares[1]!))
  })
})

// ------------------------------------------------------------------- SSE

function fakeRes() {
  const res = new EventEmitter() as EventEmitter & { status: number; headers: Record<string, string>; chunks: string[]; writableEnded: boolean; writeHead(s: number, h: Record<string, string>): void; write(c: string): boolean; end(c?: string): void }
  res.status = 0
  res.headers = {}
  res.chunks = []
  res.writableEnded = false
  res.writeHead = (s, h) => { res.status = s; res.headers = h }
  res.write = (c) => { res.chunks.push(c); return true }
  res.end = (c) => { if (c) res.chunks.push(c); res.writableEnded = true }
  return res
}

function fakeLifecycle() {
  const emitter = new EventEmitter()
  const lifecycle = {
    on: vi.fn((event: 'lifecycle/event', listener: (e: LifecycleEvent) => void) => {
      emitter.on(event, listener)
      return () => { emitter.off(event, listener) }
    }),
  }
  return { lifecycle, emit: (e: LifecycleEvent) => emitter.emit('lifecycle/event', e), listeners: () => emitter.listenerCount('lifecycle/event') }
}

const progress: LifecycleEvent = { kind: 'attempt/progress', challengerId: CHAL2, roundId: ROUND3, tier: 'holdin', done: 1, total: 2, at: '2026-01-05T00:01:00Z' }

describe('round events (SSE)', () => {
  it('streams the events that name the round, heartbeats every refreshMs, and closes on client abort', () => {
    vi.useFakeTimers()
    try {
      const { lifecycle, emit, listeners } = fakeLifecycle()
      const req = new EventEmitter()
      const res = fakeRes()
      streamRoundEvents(lifecycle, req as never, res as never, { roundId: ROUND3, refreshMs: 1000 })
      expect(res.status).toBe(200)
      expect(res.headers['content-type']).toBe('text/event-stream; charset=utf-8')
      expect(res.chunks[0]).toBe('retry: 1000\n\n')
      expect(listeners()).toBe(1)

      emit(progress)
      emit({ kind: 'round/closed', roundId: ROUND2, at: '2026-01-05T00:02:00Z' })
      emit({ kind: 'noise_floor/recorded', id: 'x', at: '2026-01-05T00:03:00Z' })
      expect(res.chunks).toHaveLength(2)
      expect(res.chunks[1]).toBe(formatEvent(progress))
      expect(res.chunks[1]).toMatch(/^event: attempt\/progress\ndata: \{.*"done":1.*\}\n\n$/)

      vi.advanceTimersByTime(1000)
      expect(res.chunks[2]).toMatch(/^: \d{4}-\d{2}-\d{2}T.*\n\n$/)

      req.emit('close')
      expect(res.writableEnded).toBe(true)
      expect(listeners()).toBe(0)
      vi.advanceTimersByTime(3000)
      emit(progress)
      expect(res.chunks).toHaveLength(3)
      // A second close (res after req) is a no-op.
      res.emit('close')
      expect(res.chunks).toHaveLength(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a heartbeat-only stream open without the lifecycle service', () => {
    vi.useFakeTimers()
    try {
      const req = new EventEmitter()
      const res = fakeRes()
      streamRoundEvents(undefined, req as never, res as never, { roundId: ROUND3, refreshMs: 500 })
      expect(res.chunks[1]).toBe(': no lifecycle service mounted; heartbeats only\n\n')
      vi.advanceTimersByTime(500)
      expect(res.chunks).toHaveLength(3)
      expect(res.writableEnded).toBe(false)
      res.emit('close')
      expect(res.writableEnded).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('is wired on the handler: 200 event-stream for a known round, 404 for an unknown one', () => {
    const { lifecycle, emit } = fakeLifecycle()
    const deps = fakeDeps()
    deps.lifecycle = { ...deps.lifecycle!, ...lifecycle } as never
    const handler = createHandler(deps, { basePath: '/samsara', refreshMs: 60_000 })
    const req = Object.assign(new EventEmitter(), { method: 'GET', url: `/samsara/rounds/${ROUND3}/events` })
    const res = fakeRes()
    handler(req as never, res as never)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('text/event-stream; charset=utf-8')
    emit(progress)
    expect(res.chunks.at(-1)).toBe(formatEvent(progress))
    req.emit('close')
    expect(res.writableEnded).toBe(true)

    const missing = fakeRes()
    handler(Object.assign(new EventEmitter(), { method: 'GET', url: '/samsara/rounds/nope/events' }) as never, missing as never)
    expect(missing.status).toBe(404)
    expect(missing.headers['content-type']).toBe('application/json; charset=utf-8')
  })

  it('strips the per-task deltas from a judged compare before it goes on the wire, holdout included', () => {
    const judged: LifecycleEvent = {
      kind: 'campaign', roundId: ROUND3, experimentId: EXP, at: '2026-01-05T00:04:00Z',
      event: { kind: 'judged', roundId: ROUND3, challengerId: CHAL2, tier: 'holdout', compare: { ...compares[3]!, challenger_id: CHAL2, round_id: ROUND3, per_task: [{ task_id: 't9', delta: 0.42 }] }, spent: { usd: 1, attempts: 1, rounds: 1, holdout_reveals: 1 } },
    }
    const { lifecycle, emit } = fakeLifecycle()
    const req = new EventEmitter()
    const res = fakeRes()
    streamRoundEvents(lifecycle, req as never, res as never, { roundId: ROUND3, refreshMs: 60_000 })
    emit(judged)
    const frame = res.chunks.at(-1)!
    expect(frame).toMatch(/^event: campaign\ndata: /)
    expect(frame).not.toContain('per_task')
    expect(frame).not.toContain('t9')
    expect(frame).not.toContain('0.42')
    expect(JSON.parse(frame.slice('event: campaign\ndata: '.length))).toMatchObject({ event: { kind: 'judged', tier: 'holdout', compare: { mean: 0.15, ci: [0.05, 0.25], verdict: { value: 'promote' } } } })
    req.emit('close')
    // Every other event goes through as it is.
    expect(wireEvent(progress)).toBe(progress)
    expect(compares[3]).toHaveProperty('per_task')
  })

  it('names the round of an event and recognises a subscribable lifecycle', () => {
    expect(roundOf(progress)).toBe(ROUND3)
    expect(roundOf({ kind: 'consent/recorded', id: 'c', action: 'promote', at: 't' })).toBeUndefined()
    expect(sseLifecycleOf(undefined)).toBeUndefined()
    expect(sseLifecycleOf(fakeDeps().lifecycle)).toBeUndefined()
    expect(sseLifecycleOf(fakeLifecycle().lifecycle)).toBeDefined()
  })
})

// ----------------------------------------------------------------- bench

const RESULT: bench.BenchResult = {
  metric: 'acc', tasks: 2, entities: 2, reruns: 3, rows: 6, excluded: 0, sdPaired: { task: 0.12, entity: 0.11 }, orderedPairs: ['0>1', '1>0'], resamples: 200, seed: 0,
  gates: ['default', 'keep-better'], scenarios: [{ name: 'null', effect: null }, { name: 'flip 0.1', effect: { kind: 'flip', p: 0.1 } }],
  cells: [
    { gate: 'default', scenario: 'null', rate: 0.06, mcSe: 0.02, verdicts: { hold: 188, promote: 12 }, meanDelta: 0.001 },
    { gate: 'default', scenario: 'flip 0.1', rate: 0.55, mcSe: 0.04, verdicts: { hold: 90, promote: 110 }, meanDelta: 0.08 },
    { gate: 'keep-better', scenario: 'null', rate: 0.51, mcSe: 0.04, verdicts: { hold: 98, promote: 102 }, meanDelta: 0.001 },
    { gate: 'keep-better', scenario: 'flip 0.1', rate: 0.9, mcSe: 0.02, verdicts: { hold: 20, promote: 180 }, meanDelta: 0.08 },
  ],
  exact: [
    { gate: 'default', pair: '0>1', verdict: 'hold', ruleFired: 'underpowered', mean: 0.01 },
    { gate: 'default', pair: '1>0', verdict: 'hold', ruleFired: 'underpowered', mean: -0.01 },
    { gate: 'keep-better', pair: '0>1', verdict: 'promote', ruleFired: 'keep-better', mean: 0.01 },
    { gate: 'keep-better', pair: '1>0', verdict: 'hold', ruleFired: 'keep-better', mean: -0.01 },
  ],
}

const benchDir = mkdtempSync(join(tmpdir(), 'samsara-ui-bench-'))
writeFileSync(join(benchDir, 'noise.json'), JSON.stringify(RESULT))
writeFileSync(join(benchDir, 'notes.json'), JSON.stringify({ hello: 'world' }))
afterAll(() => { rmSync(benchDir, { recursive: true, force: true }) })

describe('bench page', () => {
  it('formats every result under the dir and skips what is not one', () => {
    const model = bench.load(withLifecycle, { query: q() }, benchDir)
    expect(model.files.map((f) => f.file)).toEqual(['noise.json'])
    expect(model.skipped).toEqual(['notes.json'])
    expect(model.files[0]!.promotes).toEqual({ default: 0, 'keep-better': 1 })
    const html = bench.render(model)
    expect(html).toContain('<th>gate</th><th>null</th><th>flip 0.1</th>')
    expect(html).toContain('<td>default</td><td><span class="tnum">0.06</span> <span class="muted">±<span class="tnum">0.02</span></span></td>')
    expect(html).toContain('<th>gate</th><th>0&gt;1</th><th>1&gt;0</th><th>promotes</th>')
    expect(html).toContain('<span class="tnum">1</span> / <span class="tnum">2</span>')
    expect(html).toContain('<code>notes.json</code>')
    expect(html).toContain('The page runs no bench')
    expect(html).not.toContain('undefined')
    const json = bench.json(model) as { sources: string[] }
    expect(json.sources).toEqual(['noise.json'])
    expect(untraceable(html, json)).toEqual([])
  })

  it('narrows to the gates and resamples the query names', () => {
    const one = bench.load(withLifecycle, { query: q({ gates: 'keep-better,nope', resamples: '200' }) }, benchDir)
    expect(one.files[0]!.result.gates).toEqual(['keep-better'])
    expect(one.files[0]!.result.cells).toHaveLength(2)
    const html = bench.render(one)
    expect(html).toContain('<span class="pill active">keep-better</span>')
    expect(html).toContain('--gates keep-better,nope --resamples 200 --out')
    expect(html).not.toContain('<td>default</td>')
    expect(untraceable(html, bench.json(one))).toEqual([])
    const none = bench.load(withLifecycle, { query: q({ resamples: '50' }) }, benchDir)
    expect(none.files).toEqual([])
    expect(bench.render(none)).toContain('was computed with <span class="tnum">50</span> resamples.')
  })

  it('says so when there is no result under the dir', () => {
    const model = bench.load(withLifecycle, { query: q() }, join(benchDir, 'absent'))
    expect(model.files).toEqual([])
    const html = bench.render(model)
    expect(html).toContain('No bench result under <code>')
    expect(html).toContain('data-copy="dsh --profile host gate bench')
    // No refresh on this page, yet the copy button has its handler.
    expect(html).not.toContain('REFRESH')
    expect(html).toContain("ev.target.closest('button.copy')")
    expect(html).not.toContain('--resamples')
    expect(untraceable(html, bench.json(model))).toEqual([])
    expect(bench.json(model)).toHaveProperty('sources', [])
  })
})

// ------------------------------------------------------------------ home

describe('home strip and hints', () => {
  it('shows the champion served, the active experiments, the open rounds under #rounds, the pending consent and the latest floors', () => {
    const model = home.load(withLifecycle, { query: q() })
    const st = model.status
    expect(st.champion?.serving.id).toBe('serving-2')
    expect(st.champion?.skill_sha).toBe(fakeDeps().ledger.challenger(CHAMP)!.skill_sha)
    expect(st.servings).toBe(2)
    expect(st.experiments.map((e) => e.id)).toEqual([EXP])
    expect(st.rounds.map((r) => r.id)).toEqual([ROUND2, ROUND3])
    expect(st.pending.map((p) => p.candidate)).toEqual([CHAL])
    expect(st.noiseFloors.map((f) => f.id).sort()).toEqual([...fakeDeps().ledger.read('noise_floors', 'human')].map((f) => f.id).sort())
    expect(st.hints).toEqual(['aa'])
    const html = home.render(model)
    expect(html.indexOf('<h2>Status</h2>')).toBeLessThan(html.indexOf('<h2>Champion</h2>'))
    expect(html).toContain('<div id="rounds">')
    expect(html).toContain(`data-copy="/samsara approve ${CHAL}"`)
    expect(html).toContain('Latest noise floor per eval config · 2')
    expect(html).toContain('No A/A control yet')
    expect(html).not.toContain('No noise floor yet')
    expect(html).not.toContain('No experiment yet')
    expect(untraceable(html, home.json(model))).toEqual([])
    const json = home.json(model) as { sources: string[]; status: home.StatusStrip }
    expect(json.status.servings).toBe(2)
    expect(json.sources).toContain('serving-2')
    expect(json.sources).toContain(ROUND3)
  })

  it('falls back to the ledger for rounds and floors without the lifecycle service', () => {
    const model = home.load(withoutLifecycle, { query: q() })
    expect(model.status.lifecycle).toBe(false)
    expect(model.status.rounds.map((r) => r.id)).toEqual([ROUND2, ROUND3])
    expect(model.status.noiseFloors.map((f) => f.id)).toEqual([...new Set(model.status.noiseFloors.map((f) => f.id))])
    expect(model.status.noiseFloors).toHaveLength(2)
    expect(model.status.pending).toEqual([])
    const html = home.render(model)
    expect(html).toContain('Pending consents come from the lifecycle service, which is not mounted.')
    expect(untraceable(html, home.json(model))).toEqual([])
  })

  it('hints at each missing prerequisite: noise floor, A/A control, experiment', () => {
    const cases: [View[], home.Hint[]][] = [
      [['noise_floors'], ['noise_floor', 'aa']],
      [['experiments'], ['aa', 'experiment']],
      [['challengers', 'noise_floors', 'experiments', 'servings', 'rounds'], ['noise_floor', 'aa', 'experiment']],
    ]
    for (const [views, hints] of cases) {
      const model = home.load(depsWithout(...views), { query: q() })
      expect(model.status.hints, views.join()).toEqual(hints)
      const html = home.render(model)
      expect(html).toContain('<h2>Getting started</h2>')
      expect(html.match(/class="callout warn"/g)?.length).toBeGreaterThanOrEqual(hints.length)
      if (hints.includes('noise_floor')) expect(html).toContain('No noise floor yet')
      if (hints.includes('experiment')) expect(html).toContain('No experiment yet')
      expect(html).not.toContain('undefined')
      expect(untraceable(html, home.json(model))).toEqual([])
    }
    const empty = home.load(depsWithout('challengers', 'noise_floors', 'experiments', 'servings', 'rounds'), { query: q() })
    expect(empty.status.champion).toBeUndefined()
    expect(home.render(empty)).toContain('Nothing served yet.')
    expect(home.render(empty)).toContain('No open round.')
  })

  it('shows no hint once the ledger has a control:aa row beside the floor and the experiment', () => {
    const deps = fakeDeps()
    const read = deps.ledger.read
    deps.ledger.read = <N extends View>(view: N, viewer: 'proposer' | 'gate' | 'human') =>
      (view === 'challengers' ? [...read('challengers', viewer), { ...deps.ledger.challenger(ROOT)!, id: 'aa-row', intent: 'control:aa' }] : read(view, viewer)) as ViewRows[N]
    const model = home.load({ ...deps, base: '/samsara', refreshMs: 1000 }, { query: q() })
    expect(model.status.hints).toEqual([])
    expect(home.render(model)).not.toContain('<h2>Getting started</h2>')
  })
})
