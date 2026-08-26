// @oldbulb/samsara-gate-catalog — acceptance rules from the RSI literature as
// gate policies, one factory per rule, plus CATALOG (every rule at its default
// configuration) and catalogGate(name) for lookup by name or name@version.
//
// Every rule is a GatePolicyProvider. The statistics that gate-default puts in
// Compare (pairing by (taskId, sample), entity clusters, nEff, replicates, MDE,
// cost ratio, ladder exposure, counts) are computed here the same way and with
// the same helpers, so a catalog verdict row reads like a gate-default row; the
// rule only decides `verdict`, `ci`, `method`, `holm` and `ruleFired`. Rules with
// no interval report ci = [mean, mean] and method = their name; rules with no
// significance level report holm.adjustedAlpha = the request's alpha. On the
// holdout tier every rule answers 'promote' or 'hold' (never 'drop'); the type
// and facts checks mirror gate-default's rules 0 and 1 ('invalid').
//
// A literature rule decides only on holdout. The other tiers get the
// framework's ladder (`tiered`): smoke is validity only (rule 2), holdin never
// promotes (the power floor, then the rule with 'promote' screened to 'hold'),
// live holds. The bench calls every rule at tier holdout, so its numbers are
// the rules' own.
//
// The framework does not know what a metric means. Rules that the papers state
// on binary outcomes are stated here on the sign
// of the paired per-task delta, which is the same thing for a binary metric and
// a sign test otherwise.

import {
  clusterBy,
  isEligible,
  ladderStep,
  mde as mdeOf,
  mean,
  mulberry32,
  normalQuantile,
  pairedDeltas,
  sd,
  type Compare,
  type CompareRequest,
  type GateJudgement,
  type GatePolicyProvider,
  type ScoredAttempt,
  type TaskDelta,
  type Verdict,
} from '@oldbulb/samsara-gate'

export const CATALOG_VERSION = '0.1.0'

/** A catalog rule is pure and answers synchronously; the seam also admits policies that return a promise. */
export interface CatalogRule extends GatePolicyProvider {
  judge(req: CompareRequest): GateJudgement
}

// ---------------------------------------------------------------- shared statistics

interface Prepared {
  challenger: ScoredAttempt[]
  champion: ScoredAttempt[]
  pairs: TaskDelta[]
  deltas: number[]
  clusters: string[]
  nEff: number
  entityMeans: number[]
  /** Per distinct task, in first-seen order: mean delta over its paired samples. */
  perTask: { taskId: string; entityKey: string; delta: number }[]
  /** Per sample index, mean delta over the tasks paired at that sample. */
  perSample: number[]
  compare: Compare
  /** Set when rule 0 or 1 refused; the rule returns it unchanged. */
  invalid?: GateJudgement
}

function costOf(metric: 'cost_usd' | 'tokens', rows: readonly ScoredAttempt[]): (a: ScoredAttempt) => number {
  // usd only when every row reports it; otherwise tokens, so a ratio never mixes units.
  const usd = metric === 'cost_usd' && rows.length > 0 && rows.every(a => a.cost.usd !== undefined)
  return usd ? a => a.cost.usd! : a => a.cost.tokens
}

function ratio(num: number, den: number): number {
  if (den === 0) return num === 0 ? 1 : Infinity
  return num / den
}

/** gate-default's statistics block, verbatim in substance, with the rule's name as the interval method. */
function prepare(req: CompareRequest, rule: string): Prepared {
  const { policy } = req
  const rows = (xs: ScoredAttempt[]) => xs.filter(a => a.metric === req.primaryMetric)
  const challenger = rows(req.challenger)
  const champion = rows(req.champion)

  const cost = costOf(policy.costBudget.metric, [...challenger, ...champion])
  const pairing = pairedDeltas(challenger, champion, cost)
  const deltas = pairing.deltas.map(d => d.delta)
  const clusters = pairing.deltas.map(d => d.entityKey)
  const groups = clusterBy(deltas, clusters)
  const nEff = groups.size
  const meanDelta = deltas.length ? mean(deltas) : NaN
  const entityMeans = [...groups.values()].map(mean)
  const sdEntity = sd(entityMeans)
  const byTask = new Map<string, { entityKey: string; values: number[] }>()
  const bySample = new Map<number, number[]>()
  for (const d of pairing.deltas) {
    const t = byTask.get(d.taskId)
    if (t) t.values.push(d.delta)
    else byTask.set(d.taskId, { entityKey: d.entityKey, values: [d.delta] })
    const s = bySample.get(d.sample)
    if (s) s.push(d.delta)
    else bySample.set(d.sample, [d.delta])
  }
  const perTask = [...byTask].map(([taskId, t]) => ({ taskId, entityKey: t.entityKey, delta: mean(t.values) }))
  const perSample = [...bySample].sort((x, y) => x[0] - y[0]).map(([, v]) => mean(v))
  const replicates = byTask.size > 0 ? pairing.deltas.length / byTask.size : 0
  const mde = mdeOf(req.noiseFloor.sdPaired, nEff, policy.alpha, policy.power, replicates)
  const costRatio = ratio(mean(pairing.costs.challenger), mean(pairing.costs.champion))
  const step = ladderStep(sdEntity, nEff)
  const beatBest = nEff > 0 && meanDelta > (req.bestSoFar ?? -Infinity) + step
  const validCount = challenger.filter(a => a.status === 'COMPLETED' && a.valid !== false).length
  const validRate = challenger.length ? validCount / challenger.length : 0

  const compare: Compare = {
    perTask: pairing.deltas,
    mean: meanDelta,
    ci: [meanDelta, meanDelta],
    method: rule,
    clusterKey: 'entity',
    nEff,
    mde,
    replicates,
    minEffect: policy.mde ?? 0,
    holm: { adjustedAlpha: policy.alpha },
    costRatio,
    ladder: { step, beatBest },
    counts: { paired: pairing.deltas.length, unpaired: pairing.unpaired, excluded: pairing.excluded, validRate },
    ruleFired: '',
  }
  const p: Prepared = { challenger, champion, pairs: pairing.deltas, deltas, clusters, nEff, entityMeans, perTask, perSample, compare }

  // 0. Facts mismatch, 1. type check: as gate-default.
  if (req.factsSha !== undefined && req.factsSha.challenger !== req.factsSha.champion) p.invalid = judgement(p, 'facts:mismatch', 'invalid')
  else if ([...challenger, ...champion].some(a => a.kind === 'judge')) p.invalid = judgement(p, 'type:judge', 'invalid')
  else if (challenger.filter(isEligible).length === 0) p.invalid = judgement(p, 'type:no-data', 'invalid')
  return p
}

function judgement(p: Prepared, ruleFired: string, verdict: Verdict, extra: Partial<Pick<Compare, 'ci' | 'method' | 'holm'>> = {}): GateJudgement {
  return { compare: { ...p.compare, ...extra, ruleFired }, verdict }
}

const keep = (ok: boolean): Verdict => (ok ? 'promote' : 'hold')

function provider(name: string, judge: (p: Prepared, req: CompareRequest) => GateJudgement): CatalogRule {
  return {
    name,
    version: CATALOG_VERSION,
    judge(req) {
      const p = prepare(req, name)
      return p.invalid ?? tiered(p, req, () => judge(p, req))
    },
  }
}

/** The framework's tier ladder around a rule: the rule itself decides only on holdout. */
function tiered(p: Prepared, req: CompareRequest, rule: () => GateJudgement): GateJudgement {
  const { tier, policy } = req
  if (tier === 'smoke') return judgement(p, 'validity', p.compare.counts.validRate >= policy.validityFloor ? 'hold' : 'drop')
  if (tier === 'live') return judgement(p, 'live:unimplemented', 'hold')
  if (tier === 'holdin') {
    if (p.nEff < policy.nEffFloor) return judgement(p, 'power:nEff', 'hold:underpowered')
    const j = rule()
    return j.verdict === 'promote' ? { compare: { ...j.compare, ruleFired: 'screen' }, verdict: 'hold' } : j
  }
  return rule()
}

/** Miller 2024 §2.2 clustered SE of the mean delta: sqrt(sum_c (sum_{i in c} (d_i - dbar))^2) / n; sd/sqrt(n) when every cluster is a singleton. */
export function clusteredSe(deltas: readonly number[], clusters: readonly string[]): number {
  const n = deltas.length
  if (n === 0) return NaN
  const m = mean(deltas)
  let s = 0
  for (const g of clusterBy(deltas, clusters).values()) {
    let c = 0
    for (const d of g) c += d - m
    s += c * c
  }
  return Math.sqrt(s) / n
}

/** Exact two-sided McNemar p-value on the discordant counts (b, c): 2 * P(Bin(b+c, 1/2) <= min(b, c)), capped at 1; 1 when there are none. */
export function mcnemarExactP(b: number, c: number): number {
  const k = b + c
  if (k === 0) return 1
  const x = Math.min(b, c)
  // P(X = j) for j = 0..x, built iteratively from P(X = 0) = 2^-k.
  let pj = Math.pow(2, -k)
  let cum = 0
  for (let j = 0; j <= x; j++) {
    cum += pj
    pj = (pj * (k - j)) / (j + 1)
  }
  return Math.min(1, 2 * cum)
}

/** Fisher-Yates in place with the caller's PRNG. */
function shuffle<T>(xs: T[], rng: () => number): T[] {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const t = xs[i]!
    xs[i] = xs[j]!
    xs[j] = t
  }
  return xs
}

/**
 * The held-in / held-out emulation shared by self-harness and rsea: the
 * request's entities (sorted, then shuffled by mulberry32(req.seed)) are split
 * in half — the first floor(m/2) held-in, the rest held-out — and each side's
 * delta is the sum of its per-task deltas (a pass-count difference for a
 * binary metric).
 */
function splitDeltas(p: Prepared, req: CompareRequest): { heldIn: number; heldOut: number } {
  const entities = shuffle([...new Set(p.clusters)].sort(), mulberry32(req.seed ?? 0))
  const heldInSet = new Set(entities.slice(0, Math.floor(entities.length / 2)))
  let heldIn = 0
  let heldOut = 0
  for (const t of p.perTask) {
    if (heldInSet.has(t.entityKey)) heldIn += t.delta
    else heldOut += t.delta
  }
  return { heldIn, heldOut }
}

// ---------------------------------------------------------------- rules

/** keep-better: promote iff the mean paired delta is > 0. The implicit baseline of SICA, RSEA's strict update, DGM with leeway 0 and GEA's rank. */
export function keepBetter(): CatalogRule {
  return provider('keep-better', p => judgement(p, 'keep-better', keep(p.compare.mean > 0)))
}

export interface HillclimbOptions {
  /** true: mean delta > 0; false: mean delta >= 0 (lateral moves accepted). Default true. */
  strict?: boolean
}

/** hillclimb: keep-better with the tie rule made explicit. */
export function hillclimb(o: HillclimbOptions = {}): CatalogRule {
  const strict = o.strict ?? true
  const rule = strict ? 'hillclimb:strict' : 'hillclimb:lateral'
  return provider('hillclimb', p => judgement(p, rule, keep(strict ? p.compare.mean > 0 : p.compare.mean >= 0)))
}

export interface DgmKeepBetterOptions {
  /** DGM `eval_noise`: the challenger may sit this far below the champion. Default 0.1. */
  leeway?: number
}

/**
 * dgm-keep-better (Zhang et al. 2025, `update_archive(method='keep_better')`):
 * unpaired mean of the challenger's eligible rows >= unpaired mean of the
 * champion's eligible rows - leeway. Nothing is paired; only the two means matter.
 */
export function dgmKeepBetter(o: DgmKeepBetterOptions = {}): CatalogRule {
  const leeway = o.leeway ?? 0.1
  return provider('dgm-keep-better', p => {
    const child = mean(p.challenger.filter(isEligible).map(a => a.value))
    const initial = mean(p.champion.filter(isEligible).map(a => a.value))
    return judgement(p, 'dgm-keep-better', keep(child >= initial - leeway))
  })
}

/**
 * self-harness (Zhang et al. 2026): delta_in >= 0 and delta_out >= 0 and
 * max(delta_in, delta_out) > 0, each side's delta a sum of per-task deltas.
 *
 * A CompareRequest carries one tier, so the request's tier is the set being
 * judged and the paper's two fixed splits are emulated inside it by the seeded
 * entity split of `splitDeltas` (the rule does not read `tier`). The paper
 * aggregates two repeats per side as pass counts; here every paired sample of a
 * task contributes through the task's mean delta.
 */
export function selfHarness(): CatalogRule {
  return provider('self-harness', (p, req) => {
    const { heldIn, heldOut } = splitDeltas(p, req)
    return judgement(p, 'self-harness', keep(heldIn >= 0 && heldOut >= 0 && Math.max(heldIn, heldOut) > 0))
  })
}

export interface RseaOptions {
  /** true: the frozen-best update (delta_out > 0); false: the lateral working-state accept (delta_out >= 0). Default false. */
  strict?: boolean
}

/** rsea (Nguyen et al. 2026, Algorithm 1): decided on the held-out half of the seeded entity split only. */
export function rsea(o: RseaOptions = {}): CatalogRule {
  const strict = o.strict ?? false
  const rule = strict ? 'rsea:strict' : 'rsea:lateral'
  return provider('rsea', (p, req) => {
    const { heldOut } = splitDeltas(p, req)
    return judgement(p, rule, keep(strict ? heldOut > 0 : heldOut >= 0))
  })
}

export interface LadderOptions {
  /** 'paper': step = sd(per-row deltas) / sqrt(paired rows) (Blum & Hardt 2015, Figure 2); 'samsara': step = sd(entity means) / sqrt(nEff) (gate-default's ladder exposure). Default 'paper'. */
  variant?: 'paper' | 'samsara'
}

/** ladder: promote iff mean delta > (bestSoFar ?? 0) + step. A release rule, not a test: about a one-sided 1-sigma rule per comparison. */
export function ladder(o: LadderOptions = {}): CatalogRule {
  const variant = o.variant ?? 'paper'
  const rule = `ladder:${variant}`
  return provider('ladder', (p, req) => {
    const step = variant === 'paper' ? ladderStep(sd(p.deltas), p.deltas.length) : p.compare.ladder.step
    return judgement(p, rule, keep(p.compare.mean > (req.bestSoFar ?? 0) + step))
  })
}

/** A normal-theory interval on the entity-clustered SE at one-sided level `alpha`: [mean - z SE, mean + z SE]. */
function normalRule(name: string, alpha: number): CatalogRule {
  return provider(name, p => {
    const se = clusteredSe(p.deltas, p.clusters)
    const z = normalQuantile(1 - alpha)
    const m = p.compare.mean
    const lo = m - z * se
    return judgement(p, name, keep(lo > 0), { ci: [lo, m + z * se], method: 'normal-clustered', holm: { adjustedAlpha: alpha } })
  })
}

/** miller (Miller 2024): the paired, entity-clustered 95% CI excludes 0 on the favourable side (one-sided 0.025). No multiplicity, no SESOI. */
export function miller(): CatalogRule {
  return normalRule('miller', 0.025)
}

export interface NormalOneSidedOptions {
  /** One-sided level. Default 0.05. */
  alpha?: number
}

/** normal-one-sided: mean - z_{1-alpha} * clustered SE > 0. gate-default's rule 7 with a normal interval instead of BCa and no Holm/SESOI. */
export function normalOneSided(o: NormalOneSidedOptions = {}): CatalogRule {
  return normalRule('normal-one-sided', o.alpha ?? 0.05)
}

export interface McnemarOptions {
  /** Two-sided level. Default 0.05. */
  alpha?: number
}

/**
 * mcnemar: exact two-sided test on the discordant paired rows (b = delta < 0,
 * c = delta > 0), clustering-blind; promote iff p < alpha and c > b. RSEA
 * reports this post hoc; the direction conjunct is added here because a gate
 * must not promote a significant regression.
 */
export function mcnemar(o: McnemarOptions = {}): CatalogRule {
  const alpha = o.alpha ?? 0.05
  return provider('mcnemar', p => {
    let b = 0
    let c = 0
    for (const d of p.deltas) {
      if (d < 0) b++
      else if (d > 0) c++
    }
    return judgement(p, 'mcnemar', keep(mcnemarExactP(b, c) < alpha && c > b), { holm: { adjustedAlpha: alpha } })
  })
}

export interface PaceOptions {
  /** Commit when the e-process reaches 1/alpha. Default 0.05. */
  alpha?: number
  /** Bet size in (0, 1). Default 0.5. */
  lambda?: number
}

/**
 * pace: testing by betting. Over the discordant paired rows in order, with
 * w = 1 for a challenger win and 0 for a loss, E <- E * (1 + lambda (2w - 1));
 * promote iff E ever reaches 1/alpha. Anytime-valid at level alpha for ONE
 * candidate against one champion: there is no Holm across a round's siblings,
 * so K candidates judged this way carry K * alpha.
 */
export function pace(o: PaceOptions = {}): CatalogRule {
  const alpha = o.alpha ?? 0.05
  const lambda = o.lambda ?? 0.5
  return provider('pace', p => {
    let e = 1
    let crossed = false
    for (const d of p.deltas) {
      if (d === 0) continue
      e *= 1 + lambda * (d > 0 ? 1 : -1)
      if (e >= 1 / alpha) { crossed = true; break }
    }
    return judgement(p, 'pace', keep(crossed), { holm: { adjustedAlpha: alpha } })
  })
}

export interface HclCommitOptions {
  /** Minimum improvement, in task units: the sum of per-task deltas (net tasks gained for a binary metric). Default 1. */
  deltaMin?: number
  /** Maximum number of regressed tasks (per-task delta < 0: the champion succeeded where the challenger failed, for a binary metric). Default Infinity. */
  tau?: number
}

/** hcl-commit: improvement >= deltaMin tasks and regressions <= tau. */
export function hclCommit(o: HclCommitOptions = {}): CatalogRule {
  const deltaMin = o.deltaMin ?? 1
  const tau = o.tau ?? Infinity
  return provider('hcl-commit', p => {
    let improvement = 0
    let regressions = 0
    for (const t of p.perTask) {
      improvement += t.delta
      if (t.delta < 0) regressions++
    }
    return judgement(p, 'hcl-commit', keep(improvement >= deltaMin && regressions <= tau))
  })
}

export interface AutoscientistsOptions {
  /** Multiplier on the standard error of the mean delta. Default 2. */
  M?: number
}

/**
 * autoscientists: promote iff mean delta > M * sd(per-row deltas) / sqrt(paired rows);
 * failing that, when the comparison has >= 2 replicates, promote iff the mean
 * delta at every sample index is > 0.
 */
export function autoscientists(o: AutoscientistsOptions = {}): CatalogRule {
  const M = o.M ?? 2
  return provider('autoscientists', p => {
    const n = p.deltas.length
    const bar = n > 0 ? (M * sd(p.deltas)) / Math.sqrt(n) : Infinity
    if (p.compare.mean > bar) return judgement(p, 'autoscientists:mean', 'promote')
    if (p.compare.replicates >= 2 && p.perSample.length >= 2) {
      return judgement(p, 'autoscientists:replicates', keep(p.perSample.every(m => m > 0)))
    }
    return judgement(p, 'autoscientists:mean', 'hold')
  })
}

// ---------------------------------------------------------------- catalog

/** Every rule at its default configuration. */
export const CATALOG: readonly CatalogRule[] = [
  keepBetter(),
  hillclimb(),
  dgmKeepBetter(),
  selfHarness(),
  rsea(),
  ladder(),
  miller(),
  normalOneSided(),
  mcnemar(),
  pace(),
  hclCommit(),
  autoscientists(),
]

/** Look a default-configured rule up by name or name@version. */
export function catalogGate(name: string): CatalogRule | undefined {
  return CATALOG.find(g => g.name === name || `${g.name}@${g.version}` === name)
}

