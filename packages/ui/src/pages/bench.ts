// `/bench` — the gate bench tables for the champion's recorded reruns. The
// page never runs a bench: that is a statistic, and the runner's bench module
// needs the pack's task rows (the entity the bootstrap clusters by) which the
// UI does not have. It reads every result `gate bench … --out` wrote under
// `data/bench/` (relative to the launch cwd, like the ledger file) and
// formats it; `?gates=a,b` keeps only those gates, `?resamples=n` only the
// results computed with that many resamples.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { withSources } from '../api.ts'
import { DASH, callout, card, codeBlock, esc, int, num, pill, table, verdictBadge } from '../html.ts'
import { navOf, shell } from '../theme.ts'
import type { PageBase, PageDeps, PageParams } from './types.ts'

/** Where `gate bench --out` results are read from, relative to the launch cwd. */
export const BENCH_DIR = 'data/bench'

/** The runner's `BenchResult`, structurally (the UI does not depend on the gate catalog); only these fields are read. */
export interface BenchCell {
  gate: string
  scenario: string
  rate: number
  mcSe: number
  verdicts: Record<string, number>
  meanDelta: number
}
export interface BenchExact {
  gate: string
  pair: string
  verdict: string
  ruleFired: string
  mean: number
}
export interface BenchResult {
  metric: string
  tasks: number
  entities: number
  reruns: number
  rows: number
  excluded: number
  sdPaired: { task: number; entity: number }
  orderedPairs: string[]
  resamples: number
  seed: number
  gates: string[]
  scenarios: { name: string; effect: unknown }[]
  cells: BenchCell[]
  exact: BenchExact[]
}

export interface BenchFile {
  /** The file name under the bench dir: the source every number of the table traces to. */
  file: string
  writtenAt: string
  result: BenchResult
  /** Per gate, how many of the real ordered pairs it promoted. */
  promotes: Record<string, number>
}

export interface BenchModel extends PageBase {
  dir: string
  /** The gates the query asked for; empty = every gate the file has. */
  gates: string[]
  resamples?: number
  files: BenchFile[]
  /** JSON files under the dir that are not bench results. */
  skipped: string[]
}

function isBenchResult(x: unknown): x is BenchResult {
  const r = x as Partial<BenchResult> | null
  return !!r && typeof r === 'object' && typeof r.metric === 'string' && Array.isArray(r.gates) && Array.isArray(r.cells) && Array.isArray(r.exact)
    && Array.isArray(r.scenarios) && Array.isArray(r.orderedPairs) && typeof r.resamples === 'number'
}

/** Every bench result under `dir`, newest first; absent dir = none. */
export function readBenchDir(dir: string): { files: BenchFile[]; skipped: string[] } {
  const files: BenchFile[] = []
  const skipped: string[] = []
  let names: string[]
  try { names = readdirSync(dir).filter((n) => n.endsWith('.json')) } catch { return { files, skipped } }
  for (const name of names.sort()) {
    const path = join(dir, name)
    try {
      const result: unknown = JSON.parse(readFileSync(path, 'utf8'))
      if (!isBenchResult(result)) { skipped.push(name); continue }
      files.push({ file: name, writtenAt: statSync(path).mtime.toISOString(), result, promotes: promotesOf(result) })
    } catch { skipped.push(name) }
  }
  return { files: files.sort((a, b) => b.writtenAt.localeCompare(a.writtenAt)), skipped }
}

function promotesOf(r: BenchResult): Record<string, number> {
  const out: Record<string, number> = {}
  for (const g of r.gates) out[g] = r.exact.filter((e) => e.gate === g && e.verdict === 'promote').length
  return out
}

/** The result narrowed to the gates asked for (those it has). */
function keepGates(f: BenchFile, gates: string[]): BenchFile {
  if (gates.length === 0) return f
  const keep = new Set(gates)
  const r = f.result
  const result: BenchResult = { ...r, gates: r.gates.filter((g) => keep.has(g)), cells: r.cells.filter((c) => keep.has(c.gate)), exact: r.exact.filter((e) => keep.has(e.gate)) }
  return { ...f, result, promotes: promotesOf(result) }
}

export function load(deps: PageDeps, params: PageParams, dir = BENCH_DIR): BenchModel {
  const gates = (params.query.get('gates') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const wanted = params.query.get('resamples')
  const resamples = wanted !== null && /^\d+$/.test(wanted) ? Number(wanted) : undefined
  const read = readBenchDir(resolve(dir))
  const files = read.files.filter((f) => resamples === undefined || f.result.resamples === resamples).map((f) => keepGates(f, gates))
  return { base: deps.base, refreshMs: deps.refreshMs, dir, gates, ...(resamples !== undefined ? { resamples } : {}), files, skipped: read.skipped }
}

export function render(model: BenchModel): string {
  return shell({
    title: 'bench',
    nav: navOf(model.base, 'bench'),
    base: model.base,
    body: sourceSection(model) + model.files.map(fileSection).join(''),
  })
}

export function json(model: BenchModel): object {
  const { base: _base, refreshMs: _refresh, ...rest } = model
  return withSources(rest, model.files.map((f) => f.file))
}

function sourceSection(m: BenchModel): string {
  const filters = `${m.gates.length ? m.gates.map((g) => pill(g, 'active')).join(' ') : pill('every gate')} ${m.resamples !== undefined ? pill(`${m.resamples} resamples`, 'active') : pill('any resamples')}`
  const command = `dsh --profile host gate bench --attempts data/runs/<run>/attempts.jsonl --tasks <tasks.jsonl> --metric <metric>${m.gates.length ? ` --gates ${m.gates.join(',')}` : ''}${m.resamples !== undefined ? ` --resamples ${String(m.resamples)}` : ''} --out ${m.dir}/<name>.json`
  const none = m.files.length === 0
    ? callout('warn', m.resamples !== undefined ? `No bench result under <code>${esc(m.dir)}</code> was computed with ${int(m.resamples)} resamples.` : `No bench result under <code>${esc(m.dir)}</code> yet.`)
    : ''
  const skipped = m.skipped.length ? `<p class="muted">Not bench results, skipped: ${m.skipped.map((s) => `<code>${esc(s)}</code>`).join(' ')}</p>` : ''
  return `<section><h2>Bench<span class="count">${m.files.length}</span></h2>${card(`<div class="card-body">`
    + `<p class="muted">Gate acceptance rates on the champion's recorded reruns, read from <code>${esc(m.dir)}/*.json</code>. The page runs no bench: the CLI writes a result there, with the pack's task rows the bootstrap clusters by.</p>`
    + `<p>${filters}</p>${none}${skipped}${codeBlock('gate bench', command)}</div>`)}</section>`
}

function fileSection(f: BenchFile): string {
  const r = f.result
  const cell = (gate: string, scenario: string) => r.cells.find((c) => c.gate === gate && c.scenario === scenario)
  const names = r.scenarios.map((s) => s.name)
  const facts = `${int(r.tasks)} tasks · ${int(r.entities)} entities · ${int(r.reruns)} reruns <span class="muted">(${int(r.rows)} scored rows, ${int(r.excluded)} excluded)</span> · sd_paired task ${num(r.sdPaired.task)} / entity ${num(r.sdPaired.entity)} · ${int(r.resamples)} resamples · seed ${int(r.seed)} · pairs ${r.orderedPairs.map((p) => `<code>${esc(p)}</code>`).join(' ')}`
  const rates = table(['gate', ...names], r.gates.length === 0 ? [] : [
    ['<span class="muted">mean delta</span>', ...names.map((n) => num(cell(r.gates[0]!, n)?.meanDelta))],
    ...r.gates.map((g) => [esc(g), ...names.map((n) => {
      const c = cell(g, n)
      return c ? `${num(c.rate, 2)} <span class="muted">±${num(c.mcSe, 2)}</span>` : DASH
    })]),
  ], 'No gate left after the filter.')
  const exact = table(['gate', ...r.orderedPairs, 'promotes'], r.gates.map((g) => [
    esc(g),
    ...r.orderedPairs.map((p) => {
      const e = r.exact.find((x) => x.gate === g && x.pair === p)
      return e ? `${verdictBadge(e.verdict)} <span class="muted">${esc(e.ruleFired)}</span> ${num(e.mean)}` : DASH
    }),
    `<span class="tnum">${int(f.promotes[g])} / ${int(r.orderedPairs.length)}</span>`,
  ]), 'No gate left after the filter.')
  return `<section><h3>${esc(r.metric)} <span class="muted">· ${esc(f.file)} · written ${esc(f.writtenAt)}</span></h3>`
    + card(`<div class="card-body"><p class="muted">${facts}</p><p class="muted">Cells are acceptance rates (fraction of resamples promoted) with their Monte-Carlo SE: bootstrap rates on this one task set, not population error rates.</p></div>${rates}`)
    + `</section><section><h3>Exact decisions on the real ordered pairs <span class="muted">· ${esc(f.file)}</span></h3>${card(exact)}</section>`
}
