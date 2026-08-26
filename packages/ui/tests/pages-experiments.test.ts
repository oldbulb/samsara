// The experiments, experiment, servings and notebook pages over the fixture
// ledger plus a second experiment whose two rounds exercise every verdict
// class of the design note: every route renders, the curve has one dot per
// judged sibling and one step per promotion, every number on a page is in
// its JSON twin.
import type { ChallengerRow, CompareRow, ExperimentRow, RoundRow, View, ViewRows, Viewer } from '@oldbulb/samsara-ledger'
import { describe, expect, it } from 'vitest'
import { compareSource, type UiDeps } from '../src/api.ts'
import { createHandler } from '../src/index.ts'
import * as experiment from '../src/pages/experiment.ts'
import * as experiments from '../src/pages/experiments.ts'
import * as notebook from '../src/pages/notebook.ts'
import * as servings from '../src/pages/servings.ts'
import { CHAL, CHAL2, CHAMP, EVAL, EXP, ROOT, ROUND1, ROUND3, SESSION, challengers, compares, experiments as experimentRows, fakeDeps, rounds, sha, untraceable } from './fixtures.ts'

// A second experiment: round 4 (k=3) promoted X1, superseded X2, dropped X3, its shadow gate holding X1;
// round 5 (k=2) under the changed gate found X4 invalid and X5 underpowered.
const EXP2 = sha('experiment-2')
const ROUND4 = sha('round-4')
const ROUND5 = sha('round-5')
const [X1, X2, X3, X4, X5] = ['x1', 'x2', 'x3', 'x4', 'x5'].map(sha) as [string, string, string, string, string]
const GATE1 = rounds[0]!.gate
const GATE2 = rounds[2]!.gate
const SHADOW = rounds[1]!.shadow_gates[0]!
const KB = 'keep-better@0.1.0'

function compare(challenger_id: string, vs_id: string, round_id: string, mean: number, ci: [number, number], verdict: CompareRow['verdict']['value'], rule: string, extra: Partial<CompareRow> = {}): CompareRow {
  return {
    challenger_id, vs_id, tier: 'holdin', truth_snapshot_id: 'truth-1', per_task: [{ task_id: 't1', delta: mean }], mean, ci, method: 'bca', cluster_key: 'entity',
    n_eff: 4, mde: 0.12, round_id, replicates: 2, min_effect: 0.05, sd_source: 'noise_floor', rule_fired: rule, verdict: { value: verdict, by: 'gate-default@1', rule }, gate: 'gate-default@1', at: '2026-02-02T00:00:00Z', ...extra,
  }
}

const extraChallengers: ChallengerRow[] = [X1, X2, X3, X4, X5].map((id, i) => ({ ...challengers[2]!, id, parent_ids: [CHAMP], lineage: i === 0 ? 'side' : 'main', status: 'judged' as const }))
const extraCompares: CompareRow[] = [
  compare(X1, CHAMP, ROUND4, 0.3, [0.1, 0.5], 'promote', 'ci>0'),
  compare(X1, CHAMP, ROUND4, 0.3, [0.1, 0.5], 'hold', 'keep-better', { verdict: { value: 'hold', by: KB, rule: 'keep-better' }, gate: KB, shadow: true }),
  compare(X2, CHAMP, ROUND4, 0.25, [0.05, 0.45], 'hold:superseded', 'ci>0'),
  compare(X3, CHAMP, ROUND4, -0.2, [-0.4, -0.05], 'drop', 'ci<0'),
  compare(X4, CHAMP, ROUND5, 0, [0, 0], 'invalid', 'coordinates:facts', { verdict: { value: 'invalid', by: 'gate-default@2', rule: 'coordinates:facts' }, gate: 'gate-default@2' }),
  compare(X5, CHAMP, ROUND5, 0.05, [-0.2, 0.3], 'hold', 'power:nEff', { verdict: { value: 'hold', by: 'gate-default@2', rule: 'power:nEff' }, gate: 'gate-default@2' }),
]
const extraRounds: RoundRow[] = [
  { id: ROUND4, eval_config_sha: EVAL, champion_id: CHAMP, gate: GATE1, shadow_gates: [SHADOW], k: 3, sibling_ids: [X1, X2, X3], experiment_id: EXP2, status: 'decided', opened_at: '2026-02-01T00:00:00Z', closed_at: '2026-02-03T00:00:00Z', outcome: { promoted: X1, superseded: [X2], consent_id: 'consent-3' } },
  { id: ROUND5, eval_config_sha: EVAL, champion_id: X1, gate: GATE2, shadow_gates: [], k: 2, sibling_ids: [X4, X5], experiment_id: EXP2, status: 'judged', opened_at: '2026-02-04T00:00:00Z' },
]
const extraExperiments: ExperimentRow[] = [{
  ...experimentRows[0]!, id: EXP2, hypothesis: 'a much longer hypothesis about whether the second lineage keeps its edge once the gate version changes under it', gate: GATE1,
  budget: { usd: 20 }, spent: { usd: 12.25, attempts: 5, rounds: 2, holdout_reveals: 0 }, created_at: '2026-01-31T00:00:00Z', round_ids: [ROUND4, ROUND5], status: 'closed', closed_at: '2026-02-05T00:00:00Z',
}]

function richDeps(): UiDeps {
  const base = fakeDeps()
  const extra: Partial<{ [N in View]: ViewRows[N] }> = { challengers: extraChallengers, compares: extraCompares, rounds: extraRounds, experiments: extraExperiments }
  const byId = new Map(extraChallengers.map((c) => [c.id, c]))
  return {
    ...base,
    ledger: {
      ...base.ledger,
      read<N extends View>(view: N, viewer: Viewer) { return [...base.ledger.read(view, viewer), ...(extra[view] ?? [])] as ViewRows[N] },
      challenger: (id) => byId.get(id) ?? base.ledger.challenger(id),
    },
  }
}

function call(handler: ReturnType<typeof createHandler>, url: string) {
  let status = 0
  let body = ''
  handler({ method: 'GET', url } as never, { writeHead(s: number) { status = s }, end(b: string) { body = b } } as never)
  return { status, body }
}

const handler = createHandler(richDeps(), { basePath: '/samsara', refreshMs: 1000 })
const get = (url: string) => call(handler, url)
const twin = (url: string) => JSON.parse(get(`${url}.json`).body)
const deps = { ...richDeps(), base: '/samsara', refreshMs: 1000 }
const count = (html: string, re: RegExp) => (html.match(re) ?? []).length

const URLS = ['/samsara/experiments', `/samsara/experiments/${EXP}`, `/samsara/experiments/${EXP2}`, '/samsara/servings', `/samsara/notebook/${SESSION}`]

describe('routes', () => {
  it.each(URLS)('%s renders and its twin carries sources', (url) => {
    const r = get(url)
    expect(r.status).toBe(200)
    expect(r.body).toMatch(/^<!doctype html>/)
    expect(r.body).toContain('<a class="wordmark" href="/samsara">samsara</a>')
    expect(r.body).not.toContain('Not yet')
    expect(r.body).not.toContain('undefined')
    expect(r.body).not.toContain('NaN')
    expect(twin(url).sources.length).toBeGreaterThan(0)
  })

  it.each(URLS)('%s: every number on the page is in its twin', (url) => {
    expect(untraceable(get(url).body, twin(url))).toEqual([])
  })

  it('404s an unknown experiment and a session without rows', () => {
    expect(get('/samsara/experiments/nope').status).toBe(404)
    expect(get('/samsara/notebook/nope').status).toBe(404)
    expect(experiment.load(deps, { id: 'nope', query: new URLSearchParams() })).toBeUndefined()
    expect(notebook.load(deps, { session: 'nope', query: new URLSearchParams() })).toBeUndefined()
  })
})

describe('experiments table', () => {
  const html = experiments.render(experiments.load(deps, { query: new URLSearchParams() }))

  it('lists every experiment with its prediction, gate, rounds, promotions, spend and status', () => {
    expect(html).toContain('<h2>Experiments<span class="count">2</span></h2>')
    expect(html).toContain(`href="/samsara/experiments/${EXP}"`)
    expect(html).toContain('acc up by <span class="tnum">0.100</span>')
    expect(html).toContain('<td>gate-default@1</td>')
    expect(html).toContain('<td><span class="tnum">3</span></td>')
    expect(html).toContain(`<span class="tnum">1</span> <a class="tnum" title="${CHAMP}" href="/samsara/challengers/${CHAMP}">`)
    expect(html).toContain('<span class="tnum">4.50</span> / <span class="tnum">10.00</span> <span class="muted">usd</span>')
    expect(html).toContain('<span class="badge ok">active</span>')
    expect(html).toContain('<span class="badge neutral">closed</span>')
  })

  it('truncates a long hypothesis and keeps the whole one in the title', () => {
    expect(html).toContain('title="a much longer hypothesis about whether the second lineage keeps its edge once the gate version changes under it">a much longer hypothesis')
    expect(html).toContain('…</span>')
  })

  it('has an empty state', () => {
    expect(experiments.render({ base: '/samsara', refreshMs: 0, rows: [] })).toContain('No experiment pre-registered yet.')
  })
})

describe('experiment page', () => {
  const one = experiment.load(deps, { id: EXP, query: new URLSearchParams() })!
  const two = experiment.load(deps, { id: EXP2, query: new URLSearchParams() })!
  const html1 = experiment.render(one)
  const html2 = experiment.render(two)

  it('renders the header with hypothesis, prediction, budget bar, gate and the session that created it', () => {
    expect(html1).toContain('<p>a shorter skill reads better</p>')
    expect(html1).toContain('<dt>prediction</dt><dd>acc up by <span class="tnum">0.100</span></dd>')
    expect(html1).toContain('<dt>gate</dt><dd>gate-default@1 <span class="muted">policy <span class="tnum"')
    expect(html1).toContain(`href="/samsara/notebook/${SESSION}"`)
    expect(html1).toContain('cmd-1')
    expect(html1).toContain('<td>usd</td><td><span class="tnum">4.50</span></td><td><span class="tnum">10.00</span></td><td><div class="bar"><i style="width:45%"></i></div></td>')
    expect(html1).toContain('<td>rounds</td><td><span class="tnum">3</span></td><td><span class="tnum">5</span></td><td><div class="bar"><i style="width:60%"></i></div></td>')
    expect(html1).toContain('<td>attempts</td><td><span class="tnum">4</span></td><td><span class="muted">—</span></td><td><span class="muted">—</span></td>')
    expect(html1).toContain('<span class="badge ok">active</span>')
  })

  it('lists the rounds with the promotion verdict and one column per shadow gate', () => {
    expect(one.shadowGates).toEqual([KB])
    expect(html1).toContain('<th>round</th><th>champion</th><th>k</th><th>verdict</th><th>keep-better@0.1.0</th><th>n_eff</th><th>mde</th><th>replicates</th><th>status</th>')
    expect(html1).toContain('<h2>Rounds<span class="count">3</span></h2>')
    for (const id of [ROUND1, ROUND3]) expect(html1).toContain(`href="/samsara/rounds/${id}"`)
    // Round 1: promoted on holdout under gate-default@1, no shadow gate.
    expect(html1).toContain(`<span class="badge ok">promote</span> <span class="muted">gate-default@1 · holdout</span>`)
    // Round 2: held underpowered (rule `power:*`), the shadow gate says promote.
    expect(html1).toContain('<span class="badge warn">hold:underpowered</span> <span class="muted">gate-default@1 · holdin</span>')
    expect(html1).toContain(`<span class="badge ok">promote</span> <span class="badge neutral">shadow</span> <span class="muted">${KB}</span>`)
    // Round 3: open, nothing judged yet.
    expect(html1).toContain(`href="/samsara/challengers/${CHAL2}">${CHAL2.slice(0, 12)}</a> <span class="muted">—</span>`)
    expect(html1).toContain('<span class="badge ok">open</span>')
    // Numbers from the compare rows only.
    expect(html1).toContain('<td><span class="tnum">0.100</span></td>')
  })

  it('sums no cost per round: attempts carry no round id, so a sibling re-entering a later round could not be told apart', () => {
    // CHAL's attempts total 3.5 usd across holdin and holdout; no round shows that figure.
    expect(html1).not.toContain('3.50')
    expect(html1).not.toContain('<th>cost</th>')
    expect(one.rounds[1]).not.toHaveProperty('cost')
    expect(JSON.stringify(experiment.json(one))).not.toContain('"cost"')
  })

  it('exercises every verdict badge class of the note across the two experiments', () => {
    const all = html1 + html2
    expect(all).toContain('<span class="badge ok">promote</span> <span class="muted">gate-default@1')
    expect(all).toContain('<span class="badge warn">hold:underpowered</span> <span class="muted">gate-default@1')
    expect(all).toContain('<span class="badge warn">hold:underpowered</span> <span class="muted">gate-default@2')
    expect(all).toContain('<span class="badge neutral">hold</span> <span class="muted">superseded</span>')
    expect(all).toContain('<span class="badge danger">drop</span>')
    expect(all).toContain('<span class="badge danger outline">invalid</span>')
    expect(all).toContain(`<span class="badge neutral">hold</span> <span class="badge neutral">shadow</span> <span class="muted">${KB}</span>`)
    expect(html2).toContain('<span class="badge neutral">closed</span>')
  })

  it('draws one dot per sibling judged on holdin, one promotion mark on the baseline, the shadow marks, the gate change and the prediction band', () => {
    // Experiment 1: CHAMP and CHAL judged, CHAL2 still running; one promotion.
    expect(one.curve.siblings.map((s) => s.id)).toEqual([CHAMP, CHAL])
    expect(one.curve.lineages).toEqual([{ name: 'main', steps: [{ round: 0, value: 0.18 }] }])
    expect(one.curve.shadows).toEqual([{ round: 1, gate: KB, verdict: 'promote', id: CHAL }])
    expect(one.curve.gateChanges).toEqual([{ round: 2, label: 'gate-default@2' }])
    expect(one.curve.prediction).toEqual({ low: 0, high: 0.1, label: 'predicted acc up by 0.1' })
    expect(one.curve.baseline).toBe(0)
    expect(count(html1, /<circle class="sibling/g)).toBe(2)
    expect(count(html1, /<circle class="sibling promoted"/g)).toBe(1)
    expect(count(html1, /<line class="whisker"/g)).toBe(1)
    expect(count(html1, /<path class="champion"/g)).toBe(1)
    expect(count(html1, /<line class="promotion"/g)).toBe(1)
    expect(count(html1, /<rect class="shadow"/g)).toBe(1)
    expect(count(html1, /<g class="gate-change">/g)).toBe(1)
    expect(count(html1, /<rect class="band"/g)).toBe(1)
    expect(html1).toContain(`<title>${CHAMP} r1: 0.18 [0.08, 0.28] promote on holdin</title>`)
    expect(html1).toContain(`<title>${KB} (shadow) ${CHAL} r2: promote</title>`)
    // Experiment 2: five judged siblings, X1 promoted into its own lineage, the gate changed for round 5.
    expect(count(html2, /<circle class="sibling/g)).toBe(5)
    expect(count(html2, /<circle class="sibling promoted"/g)).toBe(1)
    expect(two.curve.lineages).toEqual([{ name: 'side', steps: [{ round: 0, value: 0.3 }] }])
    expect(two.curve.gateChanges).toEqual([{ round: 1, label: 'gate-default@2' }])
    expect(html2).toContain('>gate-default@2</text>')
    expect(html2).toContain(`<title>${X5} r2: 0.05 [-0.2, 0.3] hold:underpowered on holdin</title>`)
  })

  it('keeps the curve on one tier and one baseline: every y is a delta against the round champion on holdin, the champion line is flat at 0', () => {
    // CHAMP's promotion was decided at holdout (0.15 vs ROOT): that delta is in the table, never on the curve.
    expect(one.curve.metric).toBe('Δ acc vs champion · holdin')
    expect(html1).toContain('>Δ acc vs champion · holdin</text>')
    expect(one.curve.siblings.every((s) => s.verdict?.endsWith(' on holdin'))).toBe(true)
    expect(html1).not.toContain('promote on holdout</title>')
    expect(html1).toContain(`<title>main: champion baseline 0; promoted r1 by 0.18</title>`)
    expect(html1).toMatch(/<path class="champion" d="M48 [\d.]+ H624"/)
    // A sibling judged at holdout only is not on the curve, and a round without a holdin row leaves it empty.
    const holdoutOnly = experiment.curveOf(one.experiment, one.rounds.map((r) => ({ ...r, siblings: r.siblings.map((s) => ({ ...s, holdin: { promotion: null, shadows: {} } })) })))
    expect(holdoutOnly.siblings).toEqual([])
    expect(holdoutOnly.lineages).toEqual([])
    expect(experiment.render({ ...one, curve: holdoutOnly })).toContain('No sibling judged on holdin yet.')
    // The rounds table still shows the highest tier judged.
    expect(html1).toContain('<span class="badge ok">promote</span> <span class="muted">gate-default@1 · holdout</span>')
  })

  it('shows the prediction beside the observed delta of every promoted or held row', () => {
    expect(html1).toContain('<h2>Predicted vs observed</h2>')
    expect(html1).toContain('<th>observed Δ acc</th>')
    expect(html1).toContain('<span class="badge ok">promote</span></td><td><span class="tnum">0.150</span></td><td>[<span class="tnum">0.050</span>, <span class="tnum">0.250</span>]</td><td>2</td>')
    expect(html1).toContain('<span class="badge warn">hold:underpowered</span></td><td><span class="tnum">0.200</span></td>')
    expect(count(html1, /<td><span class="badge (ok|neutral|warn)">(promote|hold|hold:underpowered)<\/span><\/td>/g)).toBe(2)
    expect(html2).toContain('<span class="badge neutral">hold</span> <span class="muted">superseded</span></td><td><span class="tnum">0.250</span>')
    expect(html2).not.toContain('<span class="badge danger">drop</span></td><td><span class="tnum">-0.200</span>')
  })

  it('lists the consents pending on its rounds with the approve line to copy', () => {
    expect(one.pending).toEqual([{ roundId: rounds[1]!.id, candidate: CHAL, action: 'promote' }])
    expect(html1).toContain('<h2>Pending consents<span class="count">1</span></h2>')
    expect(html1).toContain('class="callout warn"')
    expect(html1).toContain(`data-copy="/samsara approve ${CHAL}"`)
    expect(html1).toContain(`<pre>/samsara approve ${CHAL}</pre>`)
    expect(html2).toContain('No consent pending.')
    const noLifecycle = experiment.load({ ...deps, lifecycle: undefined }, { id: EXP, query: new URLSearchParams() })!
    expect(noLifecycle.pending).toEqual([])
  })

  it('has empty states for an experiment without rounds', () => {
    const bare = experiment.render({ ...one, rounds: [], shadowGates: [], pending: [], curve: experiment.curveOf(one.experiment, []) })
    expect(bare).toContain('No round opened yet.')
    expect(bare).toContain('No sibling judged on holdin yet.')
    expect(bare).toContain('No promoted or held row yet.')
    expect(bare).not.toContain('undefined')
  })

  it('traces every number to a row id in the twin', () => {
    const json = experiment.json(one) as { sources: string[] }
    for (const id of [EXP, ROUND1, ROUND3, CHAMP, CHAL, CHAL2, ROOT]) expect(json.sources).toContain(id)
    for (const c of compares) expect(json.sources).toContain(compareSource(c))
  })
})

describe('servings page', () => {
  const model = servings.load(deps, { query: new URLSearchParams() })
  const html = servings.render(model)

  it('lists the champion history oldest first, the served one marked', () => {
    expect(html).toContain('<h2>Servings<span class="count">2</span></h2>')
    expect(html.indexOf(`href="/samsara/challengers/${ROOT}"`)).toBeLessThan(html.indexOf(`href="/samsara/challengers/${CHAMP}"`))
    expect(html).toContain('<td>2025-12-03T00:00:00Z</td><td><span class="badge ok">promote</span></td><td><span class="muted">—</span></td>')
    expect(html).toContain('<td><span class="badge ok">serving</span></td><td><span class="badge ok">promote</span></td><td>consent-1</td>')
    expect(count(html, /<span class="badge ok">serving<\/span>/g)).toBe(1)
  })

  it('marks a demotion and a reversal as danger', () => {
    const out = servings.render({ ...model, servings: [{ id: 's', champion_id: ROOT, from: 'x', to: 'y', by: 'demote', profile_sha: 'p' }, { id: 't', champion_id: ROOT, from: 'y', by: 'reversed', profile_sha: 'p' }] })
    expect(out).toContain('<span class="badge danger">demote</span>')
    expect(out).toContain('<span class="badge danger">reversed</span>')
    expect(servings.render({ ...model, servings: [] })).toContain('No champion served yet.')
  })

  it('names the serving, champion and consent rows as sources', () => {
    expect((servings.json(model) as { sources: string[] }).sources).toEqual(['serving-1', ROOT, 'serving-2', CHAMP, 'consent-1'])
  })
})

describe('notebook page', () => {
  const model = notebook.load(deps, { session: SESSION, query: new URLSearchParams() })!
  const html = notebook.render(model)

  it('lists the session events in order, linking each to its round and experiment', () => {
    expect(html).toContain('<dt>session</dt><dd><span class="tnum">sess-1</span></dd>')
    expect(html).toContain('<dt>operator</dt><dd>p <span class="muted">/</span> op-1</dd>')
    expect(html).toContain('<dt>events</dt><dd><span class="tnum">5</span></dd>')
    expect(model.rows.map((r) => r.seq)).toEqual([0, 1, 2, 3, 4])
    expect(count(html, new RegExp(`href="/samsara/rounds/${ROUND1}"`, 'g'))).toBe(3)
    expect(count(html, new RegExp(`href="/samsara/experiments/${EXP}"`, 'g'))).toBe(5)
    expect(html).toContain('<td>experiment new</td>')
  })

  it('marks approvals and errors', () => {
    expect(html).toContain('<span class="badge warn">approval/asked</span>')
    expect(html).toContain('<span class="badge ok">approval/decided</span>')
    expect(html).toContain('<span class="badge danger">tool/result</span></td><td>round_open</td><td><span class="badge danger">ERROR</span></td>')
    expect(html).toContain('<span class="badge neutral">tool/call</span>')
    expect(html).toContain('<span class="badge neutral">command/run</span>')
  })

  it('names the event rows and what they touched as sources', () => {
    const json = notebook.json(model) as { sources: string[]; session: string }
    expect(json.session).toBe(SESSION)
    expect(json.sources).toEqual(['nb-0', EXP, 'nb-1', ROUND1, 'nb-2', 'nb-3', 'nb-4', ROUND3])
  })
})

describe('with the plain fixture', () => {
  const plain = createHandler(fakeDeps(), { basePath: '/samsara', refreshMs: 1000 })
  it('renders the four pages and traces their numbers too', () => {
    for (const url of ['/samsara/experiments', `/samsara/experiments/${EXP}`, '/samsara/servings', `/samsara/notebook/${SESSION}`]) {
      const html = call(plain, url).body
      expect(html).toMatch(/^<!doctype html>/)
      expect(untraceable(html, JSON.parse(call(plain, `${url}.json`).body)), url).toEqual([])
    }
    expect(count(call(plain, '/samsara/experiments').body, /<tbody><tr>/g)).toBe(1)
    expect(compares.length).toBe(4)
  })
})
