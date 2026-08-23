// gate-default: rule 0 (facts mismatch, docs/design/ui-and-certification.md)
// then docs/design/gate.md rules 1-8 in order. Rule 9 (live) is not
// implemented; live requests return 'hold' with ruleFired 'live:unimplemented'.

import { bcaBootstrapCI, clusterBy, holmAdjustedAlpha, isEligible, ladderStep, mde as mdeOf, mean, mulberry32, pairedDeltas, sd } from './stats.ts'
import type { Compare, CompareRequest, GateJudgement, ScoredAttempt, Verdict } from './types.ts'

export const GATE_DEFAULT_NAME = 'gate-default'
export const GATE_DEFAULT_VERSION = '0.1.0'

function costOf(metric: 'cost_usd' | 'tokens', rows: readonly ScoredAttempt[]): (a: ScoredAttempt) => number {
  // usd only when every row reports it; otherwise tokens, so a ratio never mixes units.
  const usd = metric === 'cost_usd' && rows.length > 0 && rows.every(a => a.cost.usd !== undefined)
  return usd ? a => a.cost.usd! : a => a.cost.tokens
}

function ratio(num: number, den: number): number {
  if (den === 0) return num === 0 ? 1 : Infinity
  return num / den
}

export function gateDefault(req: CompareRequest): GateJudgement {
  const { policy, tier } = req
  const rows = (xs: ScoredAttempt[]) => xs.filter(a => a.metric === req.primaryMetric)
  const challenger = rows(req.challenger)
  const champion = rows(req.champion)

  // ---- statistics (computed once, for the ledger; the rules below only read them)
  const cost = costOf(policy.costBudget.metric, [...challenger, ...champion])
  const pairing = pairedDeltas(challenger, champion, cost)
  const deltas = pairing.deltas.map(d => d.delta)
  const clusters = pairing.deltas.map(d => d.entityKey)
  const groups = clusterBy(deltas, clusters)
  const nEff = groups.size
  const meanDelta = deltas.length ? mean(deltas) : NaN
  const entityMeans = [...groups.values()].map(mean)
  const sdEntity = sd(entityMeans)
  const mde = mdeOf(req.noiseFloor.sdPaired, nEff, policy.alpha, policy.power)
  const adjustedAlpha = holmAdjustedAlpha(policy.alpha, req.round.k, req.round.index)
  const rng = mulberry32(req.seed ?? 0)
  const ci = bcaBootstrapCI(deltas, clusters, policy.bootstrap.B, adjustedAlpha, rng)
  const costRatio = ratio(mean(pairing.costs.challenger), mean(pairing.costs.champion))
  const step = ladderStep(sdEntity, nEff)
  const beatBest = nEff > 0 && meanDelta > (req.bestSoFar ?? -Infinity) + step
  const validCount = challenger.filter(a => a.status === 'COMPLETED' && a.valid !== false).length
  const validRate = challenger.length ? validCount / challenger.length : 0

  const compare: Compare = {
    perTask: pairing.deltas,
    mean: meanDelta,
    ci: [ci.lo, ci.hi],
    method: 'bca',
    clusterKey: 'entity',
    nEff,
    mde,
    holm: { adjustedAlpha },
    costRatio,
    ladder: { step, beatBest },
    counts: { paired: pairing.deltas.length, unpaired: pairing.unpaired, excluded: pairing.excluded, validRate },
    ruleFired: '',
  }
  const decide = (verdict: Verdict, ruleFired: string): GateJudgement => ({ compare: { ...compare, ruleFired }, verdict })

  // 0. Facts mismatch: two harnesses are never pooled; certification lists them.
  if (req.factsSha !== undefined && req.factsSha.challenger !== req.factsSha.champion) return decide('invalid', 'facts:mismatch')

  // 1. Type check: judge-kind scores never reach a verdict.
  if ([...challenger, ...champion].some(a => a.kind === 'judge')) return decide('invalid', 'type:judge')
  if (challenger.filter(isEligible).length === 0) return decide('invalid', 'type:no-data')

  // 2. Validity (smoke): nothing else is decided on smoke.
  if (tier === 'smoke') {
    return validRate >= policy.validityFloor ? decide('hold', 'validity') : decide('drop', 'validity')
  }

  // 9. Live: anytime-valid test not implemented.
  if (tier === 'live') return decide('hold', 'live:unimplemented')

  // 3. Power floor (S2): nEff and the noise-floor MDE against the pack-declared minimum effect.
  if (nEff < policy.nEffFloor) return decide('hold:underpowered', 'power:nEff')
  if (policy.mde !== undefined && mde > policy.mde) return decide('hold:underpowered', 'power:mde')
  // 4. MDE (S1) is `compare.mde`, from the noise floor, and binds in rule 7.

  // 5. Screen (S4): futility-only early stop on the held-in tier.
  if (tier === policy.futility.tier) {
    const se = sdEntity / Math.sqrt(nEff)
    const z = se > 0 ? meanDelta / se : meanDelta === 0 ? 0 : Math.sign(meanDelta) * Infinity
    if (z < policy.futility.zStop) return decide('drop', 'futility')
  }

  // 7's quality test, shared with rule 6's Pareto clause.
  const qualityWin = ci.lo > 0 && meanDelta >= mde

  // 6. Cost (S8): over budget and not certified better on quality => drop.
  if (costRatio > policy.costBudget.maxRatio && !qualityWin) return decide('drop', 'cost')

  // Held-in never promotes; it screens.
  if (tier === 'holdin') return decide('hold', 'screen')

  // 7. Holdout: one pre-registered one-sided test at the Holm-adjusted level, and mean >= MDE.
  // 8. Ladder exposure is `compare.ladder`; raw means stay judge-side (the ledger redacts).
  return qualityWin ? decide('promote', 'holdout') : decide('hold', 'holdout')
}
