// The policy-defining simulations from docs/design/gate.md, ported from
// the gate policy simulation (docs/design/gate.md) with a seeded PRNG. No model, no
// network; the rep counts are sized so the file runs well under a minute.

import { describe, expect, it } from 'vitest'
import { Context } from '@samsara/kernel'
import {
  GateRegistry,
  GateRegistryError,
  bcaBootstrapCI,
  gateDefault,
  gatePolicy,
  holmAdjustedAlpha,
  holmStepDown,
  jackknifeAcceleration,
  mde,
  mulberry32,
  normalCdf,
  normalQuantile,
  pairedDeltas,
  randomNormal,
  type CompareRequest,
  type GatePolicy,
  type Rng,
  type ScoredAttempt,
  type Tier,
} from '../src/index.ts'
import * as pluginDefault from '../src/plugin-default.ts'

// ---------------------------------------------------------------- fixtures

const SD = 0.2 // paired per-task sd (the S1 noise floor)

interface ArmOptions {
  n: number
  samples?: number
  effect?: number
  cost?: number
  kind?: ScoredAttempt['kind']
  fixed?: number[]
}

function side(id: string, rng: Rng, o: ArmOptions): ScoredAttempt[] {
  const out: ScoredAttempt[] = []
  const samples = o.samples ?? 1
  for (let i = 0; i < o.n; i++) {
    for (let s = 0; s < samples; s++) {
      out.push({
        attemptId: `${id}-${i}-${s}`,
        challengerId: id,
        taskId: `t${i}`,
        entityKey: `e${i}`,
        sample: s,
        status: 'COMPLETED',
        metric: 'score',
        value: (o.fixed?.[i] ?? 0) + (o.effect ?? 0) + randomNormal(rng, 0, SD / Math.SQRT2),
        kind: o.kind ?? 'reality',
        cost: { usd: o.cost ?? 1, tokens: 1000 },
      })
    }
  }
  return out
}

function request(over: Partial<CompareRequest> & { challenger: ScoredAttempt[]; champion: ScoredAttempt[] }, policy: GatePolicy, tier: Tier = 'holdout'): CompareRequest {
  return {
    tier,
    primaryMetric: 'score',
    noiseFloor: { sdPaired: SD, nReruns: 3 },
    policy,
    round: { k: 1, index: 0 },
    seed: 7,
    ...over,
  }
}

// The policy default B=2000 is cheap enough here; nEffFloor has no default and is declared.
const fast = (over: Partial<GatePolicy> = {}) => gatePolicy({ nEffFloor: 10, ...over })

/** One round: K siblings against the same champion scores; returns the sibling verdicts. */
function round(rng: Rng, n: number, K: number, policy: GatePolicy, arm: Partial<ArmOptions> = {}, seedBase = 0) {
  const latent = Array.from({ length: n }, () => randomNormal(rng, 0.5, 0.3))
  const champion = side('champ', rng, { n, fixed: latent })
  const verdicts = []
  for (let k = 0; k < K; k++) {
    const challenger = side(`ch${k}`, rng, { n, fixed: latent, ...arm })
    const req = request({ challenger, champion, round: { k: K, index: 0 }, seed: seedBase + k }, policy)
    verdicts.push(gateDefault(req).verdict)
  }
  return verdicts
}

// ---------------------------------------------------------------- simulations

describe('gate-default simulations (gate.md "Tests that define the policy")', () => {
  const ROUNDS = 300
  const N = 50

  it('null siblings, K=4: false-keep per round < alpha*K', () => {
    const rng = mulberry32(1)
    const policy = fast()
    let falseKeeps = 0
    for (let r = 0; r < ROUNDS; r++) {
      if (round(rng, N, 4, policy, {}, r * 10).includes('promote')) falseKeeps++
    }
    const rate = falseKeeps / ROUNDS
    expect(rate).toBeLessThan(policy.alpha * 4)
    // With Holm and the MDE floor the per-round rate is well inside alpha, not just alpha*K.
    expect(rate).toBeLessThan(policy.alpha)
  })

  it('a pure-noise task set promotes nothing over 20 rounds', () => {
    // Pure noise: the measured noise floor swamps the effect the pack declares detectable,
    // so every round is hold:underpowered (S2) and no verdict can be promote.
    const rng = mulberry32(2)
    const policy = fast({ mde: 0.05 }) // MDE at n=30, sd=0.2 is 0.102 > 0.05
    const verdicts = new Set<string>()
    for (let r = 0; r < 20; r++) for (const v of round(rng, 30, 4, policy, {}, r * 10)) verdicts.add(v)
    expect(verdicts).toEqual(new Set(['hold:underpowered']))

    // Without a declared minimum effect the noise-floor MDE still binds: far fewer
    // promotions than the alpha*K*rounds a bare significance test would allow.
    const rng2 = mulberry32(3)
    let promotes = 0
    for (let r = 0; r < 20; r++) promotes += round(rng2, N, 4, fast(), {}, r * 10).filter(v => v === 'promote').length
    expect(promotes).toBeLessThanOrEqual(2)
  })

  it('a bigger-budget arm (3 samples per task, same null) is not promoted more often', () => {
    const rngA = mulberry32(4)
    const rngB = mulberry32(4)
    const policy = fast()
    let a = 0
    let b = 0
    for (let r = 0; r < ROUNDS; r++) {
      a += round(rngA, N, 4, policy, { samples: 1 }, r * 10).filter(v => v === 'promote').length
      b += round(rngB, N, 4, policy, { samples: 3 }, r * 10).filter(v => v === 'promote').length
    }
    expect(b / ROUNDS).toBeLessThanOrEqual(a / ROUNDS + 0.03)
    expect(b / ROUNDS).toBeLessThan(policy.alpha)
  })

  it('a known-good challenger (+1.5*mde) is promoted with power >= 0.8', () => {
    const rng = mulberry32(5)
    const policy = fast()
    const effect = 1.5 * mde(SD, N, policy.alpha, policy.power)
    let promotes = 0
    for (let r = 0; r < ROUNDS; r++) {
      if (round(rng, N, 1, policy, { effect }, r * 10)[0] === 'promote') promotes++
    }
    expect(promotes / ROUNDS).toBeGreaterThanOrEqual(0.8)
  })

  it('the same good challenger is never promoted on holdin, and is dropped on futility when harmful', () => {
    const rng = mulberry32(6)
    const policy = fast()
    const latent = Array.from({ length: N }, () => randomNormal(rng, 0.5, 0.3))
    const champion = side('champ', rng, { n: N, fixed: latent })
    const good = gateDefault(request({ challenger: side('g', rng, { n: N, fixed: latent, effect: 0.2 }), champion }, policy, 'holdin'))
    expect(good.verdict).toBe('hold')
    expect(good.compare.ruleFired).toBe('screen')
    const bad = gateDefault(request({ challenger: side('b', rng, { n: N, fixed: latent, effect: -0.2 }), champion }, policy, 'holdin'))
    expect(bad.verdict).toBe('drop')
    expect(bad.compare.ruleFired).toBe('futility')
  })
})

describe('gate-default rules', () => {
  const rng = mulberry32(9)
  const policy = fast()
  const latent = Array.from({ length: 40 }, () => randomNormal(rng, 0.5, 0.3))
  const champion = side('champ', rng, { n: 40, fixed: latent })

  it('judge-kind primary metric => invalid', () => {
    const challenger = side('j', rng, { n: 40, fixed: latent, effect: 1, kind: 'judge' })
    const { verdict, compare } = gateDefault(request({ challenger, champion }, policy))
    expect(verdict).toBe('invalid')
    expect(compare.ruleFired).toBe('type:judge')
  })

  it('nEff below floor => hold:underpowered, never promote', () => {
    const challenger = side('small', rng, { n: 40, fixed: latent, effect: 1 }).slice(0, 8)
    const { verdict, compare } = gateDefault(request({ challenger, champion }, policy))
    expect(verdict).toBe('hold:underpowered')
    expect(compare.ruleFired).toBe('power:nEff')
    expect(compare.nEff).toBe(8)
    expect(compare.counts.unpaired).toBe(32)
  })

  it('cost ratio 1.5 with equal quality => drop', () => {
    const challenger = side('pricey', rng, { n: 40, fixed: latent, cost: 1.5 })
    const { verdict, compare } = gateDefault(request({ challenger, champion }, policy))
    expect(verdict).toBe('drop')
    expect(compare.ruleFired).toBe('cost')
    expect(compare.costRatio).toBeCloseTo(1.5, 6)
  })

  it('ABORTED|FAILED attempts are excluded and counted; smoke decides on validity only', () => {
    const challenger = side('s', rng, { n: 40, fixed: latent })
    for (let i = 0; i < 6; i++) challenger[i]!.status = 'FAILED'
    const smoke = gateDefault(request({ challenger, champion }, policy, 'smoke'))
    expect(smoke.verdict).toBe('drop')
    expect(smoke.compare.ruleFired).toBe('validity')
    expect(smoke.compare.counts.excluded).toBe(6)
    expect(smoke.compare.counts.validRate).toBeCloseTo(34 / 40, 9)
    const okSmoke = gateDefault(request({ challenger: side('ok', rng, { n: 40, fixed: latent }), champion }, policy, 'smoke'))
    expect(okSmoke.verdict).toBe('hold')
  })

  it('live is hold:live:unimplemented; the ladder reports beatBest against bestSoFar', () => {
    const challenger = side('l', rng, { n: 40, fixed: latent, effect: 0.3 })
    const live = gateDefault(request({ challenger, champion }, policy, 'live'))
    expect(live.verdict).toBe('hold')
    expect(live.compare.ruleFired).toBe('live:unimplemented')
    const ho = gateDefault(request({ challenger, champion, bestSoFar: 0.0 }, policy))
    expect(ho.verdict).toBe('promote')
    expect(ho.compare.ladder.beatBest).toBe(true)
    const ho2 = gateDefault(request({ challenger, champion, bestSoFar: 0.3 }, policy))
    expect(ho2.compare.ladder.beatBest).toBe(false)
    expect(ho2.compare.holm.adjustedAlpha).toBe(0.05)
  })

  it('is deterministic for a fixed seed', () => {
    const challenger = side('d', rng, { n: 40, fixed: latent, effect: 0.05 })
    const a = gateDefault(request({ challenger, champion, seed: 42 }, policy))
    const b = gateDefault(request({ challenger, champion, seed: 42 }, policy))
    expect(a).toEqual(b)
  })
})

// ---------------------------------------------------------------- unit tests

describe('stats', () => {
  it('normal quantile and cdf match tabulated values', () => {
    expect(normalQuantile(0.975)).toBeCloseTo(1.959964, 5)
    expect(normalQuantile(0.95)).toBeCloseTo(1.644854, 5)
    expect(normalQuantile(0.8)).toBeCloseTo(0.841621, 5)
    expect(normalQuantile(0.5)).toBeCloseTo(0, 6)
    expect(normalQuantile(0.001)).toBeCloseTo(-3.090232, 4)
    expect(normalCdf(1.959964)).toBeCloseTo(0.975, 6)
    expect(normalCdf(-1)).toBeCloseTo(0.158655, 6)
  })

  it('mde = (z_{1-a/2} + z_{1-b}) * sd / sqrt(n)', () => {
    // (1.959964 + 0.841621) * 0.2 / sqrt(50) = 0.079242
    expect(mde(0.2, 50, 0.05, 0.8)).toBeCloseTo(0.079242, 5)
    expect(mde(0.2, 0, 0.05, 0.8)).toBe(Infinity)
  })

  it('holm: adjusted level and step-down', () => {
    expect(holmAdjustedAlpha(0.05, 4, 0)).toBeCloseTo(0.0125, 9)
    expect(holmAdjustedAlpha(0.05, 4, 3)).toBeCloseTo(0.05, 9)
    expect(() => holmAdjustedAlpha(0.05, 4, 4)).toThrow(RangeError)
    expect(holmStepDown([0.01, 0.04, 0.03, 0.2], 0.05)).toEqual([true, false, false, false])
    expect(holmStepDown([0.01, 0.016, 0.02, 0.2], 0.05)).toEqual([true, true, true, false])
  })

  it('jackknife acceleration against a hand-computed value', () => {
    // clusters {1},{2},{3},{6}: leave-one-out means 11/3, 10/3, 3, 2; mean 3;
    // deviations -2/3, -1/3, 0, 1 -> sum^3 = 0.666667, sum^2 = 1.555556 -> a = 0.057270
    expect(jackknifeAcceleration([1, 2, 3, 6], [1, 1, 1, 1])).toBeCloseTo(0.057270, 5)
    expect(jackknifeAcceleration([1, 1, 1], [1, 1, 1])).toBe(0)
  })

  it('bca bootstrap: brackets the mean, clusters by entity, and has near-nominal coverage', () => {
    const rng = mulberry32(11)
    const xs = Array.from({ length: 40 }, () => randomNormal(rng, 0.1, 1))
    const ci = bcaBootstrapCI(xs, xs.map((_, i) => `e${i}`), 2000, 0.025, mulberry32(1))
    const m = xs.reduce((a, b) => a + b) / xs.length
    expect(ci.lo).toBeLessThan(m)
    expect(ci.hi).toBeGreaterThan(m)
    expect(Math.abs(ci.z0)).toBeLessThan(0.2)

    // Two rows per entity with identical values: clustering must not shrink the interval
    // the way 80 independent rows would.
    const doubled = [...xs, ...xs]
    const keys = [...xs.map((_, i) => `e${i}`), ...xs.map((_, i) => `e${i}`)]
    const clustered = bcaBootstrapCI(doubled, keys, 2000, 0.025, mulberry32(1))
    const naive = bcaBootstrapCI(doubled, doubled.map((_, i) => `r${i}`), 2000, 0.025, mulberry32(1))
    expect(clustered.hi - clustered.lo).toBeGreaterThan((naive.hi - naive.lo) * 1.2)

    let covered = 0
    const reps = 200
    for (let r = 0; r < reps; r++) {
      const ys = Array.from({ length: 30 }, () => randomNormal(rng, 0.1, 1))
      const c = bcaBootstrapCI(ys, ys.map((_, i) => `e${i}`), 500, 0.025, mulberry32(r))
      if (c.lo <= 0.1 && 0.1 <= c.hi) covered++
    }
    expect(covered / reps).toBeGreaterThanOrEqual(0.9)
  })

  it('pairedDeltas pairs on (taskId, sample) and counts exclusions', () => {
    const mk = (id: string, task: string, sample: number, value: number, status: ScoredAttempt['status'] = 'COMPLETED'): ScoredAttempt => ({
      attemptId: `${id}-${task}-${sample}`, challengerId: id, taskId: task, entityKey: task, sample, status, metric: 'm', value, kind: 'reality', cost: { tokens: 1 },
    })
    const p = pairedDeltas(
      [mk('a', 't1', 0, 1), mk('a', 't1', 1, 2), mk('a', 't2', 0, 5, 'FAILED'), mk('a', 't3', 0, 1)],
      [mk('c', 't1', 0, 0.5), mk('c', 't1', 1, 0.5), mk('c', 't2', 0, 1)],
    )
    expect(p.deltas.map(d => d.delta)).toEqual([0.5, 1.5])
    expect(p.excluded).toBe(1)
    expect(p.unpaired).toBe(2)
  })
})

describe('GateRegistry', () => {
  it('registers, judges with gateMethod, rejects duplicates, disposes', async () => {
    const ctx = new Context()
    await ctx.plugin(GateRegistry)
    expect(() => ctx.gate.judge({} as CompareRequest)).toThrow(GateRegistryError)
    const fiber = await ctx.plugin(pluginDefault)
    expect(ctx.gate.current()?.name).toBe('gate-default')
    const rng = mulberry32(3)
    const latent = Array.from({ length: 20 }, () => 0.5)
    const champion = side('champ', rng, { n: 20, fixed: latent })
    const row = ctx.gate.judge(request({ challenger: side('x', rng, { n: 20, fixed: latent }), champion }, fast()))
    expect(row.gateMethod).toBe('gate-default@0.1.0')
    expect(['hold', 'promote', 'drop']).toContain(row.verdict)

    const other = { name: 'gate-other', version: '1', judge: () => ({ compare: {} as never, verdict: 'hold' as const }) }
    const dispose = ctx.gate.register(other)
    expect(ctx.gate.current()).toBe(other)
    expect(ctx.gate.judge({} as CompareRequest).gateMethod).toBe('gate-other@1')
    expect(() => ctx.gate.register({ ...other })).toThrow(GateRegistryError)
    dispose()
    expect(ctx.gate.current()?.name).toBe('gate-default')
    await fiber.dispose()
    expect(ctx.gate.current()).toBeUndefined()
    expect(ctx.gate.list()).toEqual([])
  })
})
