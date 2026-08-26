// bench: measure any gate policy on recorded attempts. Same-config reruns of
// one champion supply a rerun-vs-rerun null (champion = rerun a, challenger =
// rerun b) and, with an injected effect on the challenger side, a power column;
// entity-cluster bootstrap resamples of the task set give each cell an
// acceptance rate with its Monte-Carlo SE. Pure given its inputs: the rows come
// in parsed (the caller reads the files), the only randomness is mulberry32
// from the seed, and no gate is special-cased — every policy sees the same
// CompareRequest, and a policy that answers with a promise (a subprocess gate)
// is awaited, so the bench itself is async.
//
// The rates are bootstrap acceptance rates on the one pack the rows came from,
// not population error rates: every resample reuses the same rows and the
// independent information under the null is the handful of unordered rerun
// pairs, so the exact decisions on the real ordered pairs are reported too.

import { gateMethodOf, gatePolicy, mean, mulberry32, sd, type GatePolicyProvider, type MetricKind, type ScoredAttempt, type Tier, type Verdict } from '@oldbulb/samsara-gate'

// ---------------------------------------------------------------- inputs

/** One row of an attempts.jsonl; only these fields are read. */
export interface BenchAttemptRow {
  attemptId: string
  task_id: string
  status: string
  cost?: { usd?: number }
  scores?: { metric: string; value: number; kind?: string; stratum?: string }[]
}

/** One task row: the entity the bootstrap clusters by comes only from here. */
export interface BenchTaskRow {
  task_id: string
  entity_key: string
  stratum?: string
}

/**
 * Injected effects, applied to the challenger side of every pair.
 * flip: each challenger value below the ceiling becomes the ceiling with probability p (best case: no regressions, shrinks sd).
 * regress: fixes with p' = p / (1 - breakPerFix) and breaks ceiling values at breakPerFix breaks per fix, replacing them
 *   with a draw from the recorded below-ceiling values, so the net delta matches flip p while the variance is not shrunk.
 * shift: a constant +delta on every challenger value.
 */
export type BenchEffect =
  | { kind: 'flip'; p: number }
  | { kind: 'regress'; p: number; breakPerFix?: number }
  | { kind: 'shift'; delta: number }

export interface BenchOptions {
  attempts: readonly BenchAttemptRow[]
  tasks: readonly BenchTaskRow[]
  /** The metric judged; its rows must be present on every scored attempt. */
  metric: string
  gates: readonly GatePolicyProvider[]
  /** Overrides on the gate policy every request carries (gate.md defaults otherwise). */
  policy?: { nEffFloor?: number; mde?: number; alpha?: number }
  /** Entity-cluster resamples per cell. Default 200. */
  resamples?: number
  seed?: number
  effects?: readonly BenchEffect[]
  /** Tier stamped on every request. Default 'holdout'. */
  tier?: Tier
  /** The metric's maximum, which flip and regress are defined against. Default 1. */
  ceiling?: number
}

// ---------------------------------------------------------------- outputs

export interface BenchCell {
  gate: string
  scenario: string
  /** Fraction of resamples whose verdict was 'promote'. */
  rate: number
  /** Monte-Carlo SE sqrt(rate (1 - rate) / resamples). */
  mcSe: number
  verdicts: Partial<Record<Verdict, number>>
  /** Mean over resamples of the mean paired delta actually judged. */
  meanDelta: number
}

export interface BenchExact {
  gate: string
  /** Ordered rerun pair 'a>b': champion = rerun a, challenger = rerun b. */
  pair: string
  verdict: Verdict
  ruleFired: string
  mean: number
}

export interface BenchResult {
  metric: string
  tasks: number
  entities: number
  reruns: number
  /** Scored rows used; `excluded` counts ABORTED/FAILED rows and rows without the metric. */
  rows: number
  excluded: number
  /** sd over units of the per-unit mean rerun delta, averaged over the unordered rerun pairs. */
  sdPaired: { task: number; entity: number }
  orderedPairs: string[]
  resamples: number
  seed: number
  gates: string[]
  scenarios: { name: string; effect: BenchEffect | null }[]
  cells: BenchCell[]
  exact: BenchExact[]
}

// ---------------------------------------------------------------- data

interface Rerun { value: number; kind: MetricKind; usd?: number; sample: number }
interface Task { id: string; entity: string; stratum?: string; reruns: Rerun[] }

function load(o: BenchOptions): { tasks: Task[]; entities: string[]; byEntity: Map<string, Task[]>; reruns: number; excluded: number; rows: number } {
  if (o.attempts.length === 0) throw new Error('bench: no attempt rows')
  if (o.tasks.length === 0) throw new Error('bench: no tasks')
  const meta = new Map(o.tasks.map(t => [t.task_id, t]))
  const byId = new Map<string, Task>()
  let notScored = 0
  let noMetric = 0
  let rows = 0
  // The file's semantics are the runner's: attemptId -> last row, so a resumed run's re-recorded
  // attempt (or a concatenated file) counts once instead of as extra reruns paired with themselves.
  const last = new Map<string, BenchAttemptRow>()
  for (const r of o.attempts) last.set(r.attemptId, r)
  for (const r of last.values()) {
    if (r.status === 'ABORTED' || r.status === 'FAILED') { notScored++; continue }
    const s = r.scores?.find(x => x.metric === o.metric)
    if (!s) { noMetric++; continue }
    // The gate rejects any 'judge' row, so every rule would answer invalid and the table would read 0.
    if (s.kind === 'judge') throw new Error(`bench: metric ${o.metric} is of kind judge (on ${r.attemptId}); the gate judges reality or mechanical metrics only`)
    rows++
    let t = byId.get(r.task_id)
    if (!t) {
      const m = meta.get(r.task_id)
      t = { id: r.task_id, entity: m?.entity_key ?? '', reruns: [] }
      if (m?.stratum !== undefined) t.stratum = m.stratum
      byId.set(r.task_id, t)
    }
    // Sample index: the attempt id's trailing integer (the ledger's convention), else occurrence order.
    const tail = /-(\d+)$/.exec(r.attemptId ?? '')
    const rerun: Rerun = { value: s.value, kind: (s.kind as MetricKind | undefined) ?? 'reality', sample: tail ? Number(tail[1]) : t.reruns.length }
    if (r.cost?.usd !== undefined) rerun.usd = r.cost.usd
    t.reruns.push(rerun)
  }
  const excluded = notScored + noMetric
  if (rows === 0) throw new Error(`bench: no scored rows for metric ${o.metric} (${notScored} ABORTED/FAILED, ${noMetric} without the metric)`)
  const tasks = [...byId.values()]
  for (const t of tasks) t.reruns.sort((a, b) => a.sample - b.sample)
  const noEntity = tasks.filter(t => t.entity === '').map(t => t.id)
  if (noEntity.length) throw new Error(`bench: no entity for task_ids: ${noEntity.join(', ')}`)
  const few = tasks.filter(t => t.reruns.length < 2).map(t => `${t.id} (${t.reruns.length})`)
  if (few.length) throw new Error(`bench: fewer than 2 scored reruns for: ${few.join(', ')}`)
  const reruns = Math.min(...tasks.map(t => t.reruns.length))
  for (const t of tasks) t.reruns.length = reruns
  const byEntity = new Map<string, Task[]>()
  for (const t of tasks) {
    const arr = byEntity.get(t.entity)
    if (arr) arr.push(t)
    else byEntity.set(t.entity, [t])
  }
  return { tasks, entities: [...byEntity.keys()], byEntity, reruns, excluded, rows }
}

/** sd (ddof 1) over units of the per-unit mean of (value_a - value_b), averaged over the unordered rerun pairs. */
function sdPaired(tasks: readonly Task[], reruns: number, unit: 'task' | 'entity'): number {
  const out: number[] = []
  for (let a = 0; a < reruns; a++) {
    for (let b = a + 1; b < reruns; b++) {
      const acc = new Map<string, number[]>()
      for (const t of tasks) {
        const k = unit === 'task' ? t.id : t.entity
        const d = t.reruns[a]!.value - t.reruns[b]!.value
        const arr = acc.get(k)
        if (arr) arr.push(d)
        else acc.set(k, [d])
      }
      out.push(sd([...acc.values()].map(mean)))
    }
  }
  return mean(out)
}

// ---------------------------------------------------------------- injection

interface Injector { apply(value: number, rng: () => number): number }

function injector(effect: BenchEffect | null, tasks: readonly Task[], ceiling: number): Injector {
  if (!effect) return { apply: v => v }
  if (effect.kind === 'shift') return { apply: v => v + effect.delta }
  if (effect.kind === 'flip') return { apply: (v, rng) => (v < ceiling && rng() < effect.p ? ceiling : v) }
  const all = tasks.flatMap(t => t.reruns.map(r => r.value))
  const below = all.filter(v => v < ceiling).sort((x, y) => x - y)
  const belowShare = below.length / all.length
  const breakPerFix = effect.breakPerFix ?? 0.25
  const pFix = effect.p / (1 - breakPerFix)
  const pBreak = belowShare < 1 ? (breakPerFix * pFix * belowShare) / (1 - belowShare) : 0
  return {
    apply(v, rng) {
      if (v < ceiling) return rng() < pFix ? ceiling : v
      if (below.length && rng() < pBreak) return below[Math.floor(rng() * below.length)]!
      return v
    },
  }
}

// ---------------------------------------------------------------- requests

function attempt(side: string, taskId: string, entityKey: string, stratum: string | undefined, r: Rerun, value: number): ScoredAttempt {
  const a: ScoredAttempt = {
    attemptId: `${side}/${taskId}`, challengerId: side, taskId, entityKey, sample: 0, status: 'COMPLETED',
    metric: '', value, kind: r.kind, cost: { tokens: 0 },
  }
  if (stratum !== undefined) a.stratum = stratum
  if (r.usd !== undefined) a.cost.usd = r.usd
  return a
}

function scenarioName(e: BenchEffect): string {
  return e.kind === 'shift' ? `shift ${e.delta}` : `${e.kind} ${e.p}`
}

/** Unique labels for the gates: name@version, suffixed when two policies share one. */
function labels(gates: readonly GatePolicyProvider[]): string[] {
  const seen = new Map<string, number>()
  return gates.map(g => {
    const base = gateMethodOf(g)
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    return n === 1 ? base : `${base}#${n}`
  })
}

const EXACT_SEED = 7

export async function bench(o: BenchOptions): Promise<BenchResult> {
  const resamples = o.resamples ?? 200
  if (!Number.isInteger(resamples) || resamples < 1) throw new Error(`bench: resamples must be a positive integer, got ${resamples}`)
  const { tasks, entities, byEntity, reruns, excluded, rows } = load(o)
  const seed = o.seed ?? 0
  const tier = o.tier ?? 'holdout'
  const ceiling = o.ceiling ?? 1
  const gateLabels = labels(o.gates)
  const sdTask = sdPaired(tasks, reruns, 'task')
  const sdEntity = sdPaired(tasks, reruns, 'entity')
  const policy = gatePolicy({
    nEffFloor: o.policy?.nEffFloor ?? 20,
    ...(o.policy?.mde !== undefined ? { mde: o.policy.mde } : {}),
    ...(o.policy?.alpha !== undefined ? { alpha: o.policy.alpha } : {}),
  })
  const pairs: [number, number][] = []
  for (let a = 0; a < reruns; a++) for (let b = 0; b < reruns; b++) if (a !== b) pairs.push([a, b])
  const scenarios: BenchResult['scenarios'] = [{ name: 'null', effect: null }, ...(o.effects ?? []).map(e => ({ name: scenarioName(e), effect: e }))]

  const request = (sides: { champion: ScoredAttempt[]; challenger: ScoredAttempt[] }, gateSeed: number) => ({
    ...sides,
    tier,
    primaryMetric: o.metric,
    noiseFloor: { sdPaired: sdTask, nReruns: reruns },
    policy,
    round: { k: 1, index: 0 },
    seed: gateSeed,
  })
  const sides = (drawn: { task: Task; taskId: string; entityKey: string }[], a: number, b: number, inject: Injector, rng: () => number) => {
    const champion: ScoredAttempt[] = []
    const challenger: ScoredAttempt[] = []
    let sum = 0
    for (const { task, taskId, entityKey } of drawn) {
      const ra = task.reruns[a]!
      const rb = task.reruns[b]!
      const value = inject.apply(rb.value, rng)
      champion.push({ ...attempt('champion', taskId, entityKey, task.stratum, ra, ra.value), metric: o.metric })
      challenger.push({ ...attempt('challenger', taskId, entityKey, task.stratum, rb, value), metric: o.metric })
      sum += value - ra.value
    }
    return { champion, challenger, meanDelta: drawn.length ? sum / drawn.length : NaN }
  }

  const cells: BenchCell[] = []
  for (const [ci, scenario] of scenarios.entries()) {
    const rng = mulberry32((seed + 1000 + ci) >>> 0)
    const inject = injector(scenario.effect, tasks, ceiling)
    const tally = gateLabels.map(() => ({ verdicts: {} as Partial<Record<Verdict, number>>, promote: 0 }))
    let deltaSum = 0
    for (let r = 0; r < resamples; r++) {
      const [a, b] = pairs[r % pairs.length]!
      // Each drawn entity is its own cluster: a fresh id per draw keeps duplicates distinct.
      const drawn: { task: Task; taskId: string; entityKey: string }[] = []
      for (let k = 0; k < entities.length; k++) {
        const e = entities[Math.floor(rng() * entities.length)]!
        for (const task of byEntity.get(e)!) drawn.push({ task, taskId: `${task.id}#${k}`, entityKey: `${e}#${k}` })
      }
      const s = sides(drawn, a, b, inject, rng)
      deltaSum += s.meanDelta
      const req = request(s, (seed + ci * 1000003 + r) >>> 0)
      for (const [gi, g] of o.gates.entries()) {
        const { verdict } = await g.judge(req)
        const t = tally[gi]!
        t.verdicts[verdict] = (t.verdicts[verdict] ?? 0) + 1
        if (verdict === 'promote') t.promote++
      }
    }
    gateLabels.forEach((gate, gi) => {
      const rate = tally[gi]!.promote / resamples
      cells.push({ gate, scenario: scenario.name, rate, mcSe: Math.sqrt((rate * (1 - rate)) / resamples), verdicts: tally[gi]!.verdicts, meanDelta: deltaSum / resamples })
    })
  }

  const exact: BenchExact[] = []
  const real = tasks.map(task => ({ task, taskId: task.id, entityKey: task.entity }))
  const identity = injector(null, tasks, ceiling)
  for (const [a, b] of pairs) {
    const req = request(sides(real, a, b, identity, () => 0), EXACT_SEED)
    for (const [gi, g] of o.gates.entries()) {
      const j = await g.judge(req)
      exact.push({ gate: gateLabels[gi]!, pair: `${a}>${b}`, verdict: j.verdict, ruleFired: j.compare.ruleFired, mean: j.compare.mean })
    }
  }

  return {
    metric: o.metric,
    tasks: tasks.length,
    entities: entities.length,
    reruns,
    rows,
    excluded,
    sdPaired: { task: sdTask, entity: sdEntity },
    orderedPairs: pairs.map(([a, b]) => `${a}>${b}`),
    resamples,
    seed,
    gates: gateLabels,
    scenarios,
    cells,
    exact,
  }
}

// ---------------------------------------------------------------- markdown

const f3 = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : String(x))

export function formatBench(r: BenchResult): string {
  if (r.gates.length === 0) throw new Error('bench: no gates to format')
  const cell = (gate: string, scenario: string) => r.cells.find(c => c.gate === gate && c.scenario === scenario)!
  const names = r.scenarios.map(s => s.name)
  const L: string[] = []
  L.push(`# bench: ${r.metric}`)
  L.push('')
  L.push(
    `${r.tasks} tasks, ${r.entities} entities, ${r.reruns} reruns (${r.rows} scored rows, ${r.excluded} excluded); ` +
      `sd_paired task ${f3(r.sdPaired.task)} / entity ${f3(r.sdPaired.entity)}; ` +
      `${r.resamples} entity-cluster resamples per cell over the ordered rerun pairs ${r.orderedPairs.join(', ')}; seed ${r.seed}. ` +
      'Cells are acceptance rates (fraction of resamples promoted) with their Monte-Carlo SE: bootstrap rates on this one pack, not population error rates.',
  )
  L.push('')
  L.push(`| gate | ${names.join(' | ')} |`)
  L.push(`|---|${names.map(() => '---').join('|')}|`)
  L.push(`| mean delta | ${names.map(n => f3(cell(r.gates[0]!, n).meanDelta)).join(' | ')} |`)
  for (const g of r.gates) {
    L.push(`| ${g} | ${names.map(n => { const c = cell(g, n); return `${c.rate.toFixed(2)} ±${c.mcSe.toFixed(2)}` }).join(' | ')} |`)
  }
  L.push('')
  L.push('## Exact decisions on the real ordered pairs')
  L.push('')
  L.push(`| gate | ${r.orderedPairs.join(' | ')} | promotes |`)
  L.push(`|---|${r.orderedPairs.map(() => '---').join('|')}|---|`)
  for (const g of r.gates) {
    const row = r.orderedPairs.map(p => r.exact.find(e => e.gate === g && e.pair === p)!)
    L.push(`| ${g} | ${row.map(e => `${e.verdict} (${e.ruleFired})`).join(' | ')} | ${row.filter(e => e.verdict === 'promote').length}/${row.length} |`)
  }
  return L.join('\n') + '\n'
}
