// Every catalog rule on three synthetic pairs: a clear win, a symmetric null
// and a regression. No model, no network.

import { describe, expect, it } from 'vitest'
import { gatePolicy, type CompareRequest, type ScoredAttempt } from '@oldbulb/samsara-gate'
import {
  CATALOG,
  CATALOG_VERSION,
  autoscientists,
  catalogGate,
  clusteredSe,
  dgmKeepBetter,
  hclCommit,
  hillclimb,
  keepBetter,
  ladder,
  mcnemar,
  mcnemarExactP,
  miller,
  normalOneSided,
  pace,
  rsea,
  selfHarness,
  type CatalogRule,
} from '../src/index.ts'

// ---------------------------------------------------------------- fixtures

const N = 40
/** Entity e0..e29 singletons, then pairs of tasks share an entity. */
const entityOf = (i: number) => (i < 30 ? `e${i}` : `e${30 + Math.floor((i - 30) / 2)}`)

function side(id: string, values: readonly number[], samples = 1): ScoredAttempt[] {
  const out: ScoredAttempt[] = []
  for (let s = 0; s < samples; s++) {
    values.forEach((value, i) => {
      out.push({
        attemptId: `${id}-${i}-${s}`, challengerId: id, taskId: `t${i}`, entityKey: entityOf(i), sample: s, status: 'COMPLETED',
        metric: 'm', value, kind: 'reality', cost: { usd: 1, tokens: 100 },
      })
    })
  }
  return out
}

function request(champion: readonly number[], challenger: readonly number[], extra: Partial<CompareRequest> = {}, samples = 1): CompareRequest {
  return {
    challenger: side('b', challenger, samples), champion: side('a', champion, samples), tier: 'holdout', primaryMetric: 'm',
    noiseFloor: { sdPaired: 0.5, nReruns: 3 }, policy: gatePolicy({ nEffFloor: 5 }), round: { k: 1, index: 0 }, seed: 3,
    ...extra,
  }
}

// champion alternates 0/1; the win lifts every task to 1; the null moves half up and half down by an exactly representable amount; the tie is identical; the regression drops every task.
const champ = Array.from({ length: N }, (_, i) => i % 2)
const WIN = request(champ, champ.map(() => 1))
const NULL = request(champ, champ.map((v, i) => v + (i % 2 === 0 ? 0.25 : -0.25)))
const TIE = request(champ, champ)
const REGRESS = request(champ, champ.map(v => v - 0.3))

const verdict = (g: CatalogRule, req: CompareRequest) => g.judge(req).verdict

// ---------------------------------------------------------------- catalog

describe('catalog', () => {
  it('lists every rule once, at one version, and looks up by name or name@version', () => {
    const names = CATALOG.map(g => g.name)
    expect(new Set(names).size).toBe(names.length)
    expect(names).toEqual(['keep-better', 'hillclimb', 'dgm-keep-better', 'self-harness', 'rsea', 'ladder', 'miller', 'normal-one-sided', 'mcnemar', 'pace', 'hcl-commit', 'autoscientists'])
    expect(CATALOG.every(g => g.version === CATALOG_VERSION)).toBe(true)
    expect(catalogGate('miller')?.name).toBe('miller')
    expect(catalogGate(`pace@${CATALOG_VERSION}`)?.name).toBe('pace')
    expect(catalogGate('pace@9.9.9')).toBeUndefined()
    expect(catalogGate('nope')).toBeUndefined()
  })

  it('returns a complete Compare with the shared statistics', () => {
    for (const g of CATALOG) {
      const { compare, verdict } = g.judge(WIN)
      expect(['promote', 'hold']).toContain(verdict)
      expect(compare.perTask).toHaveLength(N)
      expect(compare.mean).toBeCloseTo(0.5)
      expect(compare.nEff).toBe(35)
      expect(compare.replicates).toBe(1)
      expect(compare.clusterKey).toBe('entity')
      expect(compare.costRatio).toBe(1)
      expect(compare.counts).toEqual({ paired: N, unpaired: 0, excluded: 0, validRate: 1 })
      expect(compare.mde).toBeGreaterThan(0)
      expect(compare.minEffect).toBe(0)
      expect(compare.ladder.step).toBeGreaterThan(0)
      expect(compare.ruleFired.startsWith(g.name)).toBe(true)
      expect(typeof compare.method).toBe('string')
      expect(compare.ci[0]).toBeLessThanOrEqual(compare.mean)
      expect(compare.ci[1]).toBeGreaterThanOrEqual(compare.mean)
    }
  })

  it('rules without an interval report ci = [mean, mean] and method = name; miller reports a normal clustered interval', () => {
    const kb = keepBetter().judge(WIN).compare
    expect(kb.ci).toEqual([kb.mean, kb.mean])
    expect(kb.method).toBe('keep-better')
    expect(kb.holm.adjustedAlpha).toBe(WIN.policy.alpha)
    const mi = miller().judge(WIN).compare
    expect(mi.method).toBe('normal-clustered')
    expect(mi.holm.adjustedAlpha).toBe(0.025)
    expect(mi.ci[0]).toBeLessThan(mi.mean)
    expect(mi.ci[1] - mi.mean).toBeCloseTo(mi.mean - mi.ci[0])
  })

  it('mirrors gate-default rules 0 and 1', () => {
    for (const g of CATALOG) {
      expect(g.judge({ ...WIN, factsSha: { challenger: 'x', champion: 'y' } })).toMatchObject({ verdict: 'invalid', compare: { ruleFired: 'facts:mismatch' } })
      const judge = request(champ, champ)
      judge.challenger[0]!.kind = 'judge'
      expect(g.judge(judge)).toMatchObject({ verdict: 'invalid', compare: { ruleFired: 'type:judge' } })
      const aborted = request(champ, champ)
      for (const a of aborted.challenger) a.status = 'ABORTED'
      expect(g.judge(aborted)).toMatchObject({ verdict: 'invalid', compare: { ruleFired: 'type:no-data' } })
    }
  })

  it('never drops, and holds on a regression', () => {
    for (const g of CATALOG) {
      expect(verdict(g, REGRESS)).toBe('hold')
      for (const req of [WIN, NULL, REGRESS]) expect(verdict(g, req)).not.toBe('drop')
    }
  })

  it('decides only on holdout: smoke is validity, holdin never promotes, live holds', () => {
    for (const g of CATALOG) {
      expect(g.judge({ ...WIN, tier: 'smoke' })).toMatchObject({ verdict: 'hold', compare: { ruleFired: 'validity' } })
      const invalid = request(champ, champ.map(() => 1))
      for (const a of invalid.challenger) a.valid = false
      expect(g.judge({ ...invalid, tier: 'smoke' })).toMatchObject({ verdict: 'drop', compare: { ruleFired: 'validity' } })
      expect(g.judge({ ...WIN, tier: 'live' })).toMatchObject({ verdict: 'hold', compare: { ruleFired: 'live:unimplemented' } })
      expect(g.judge({ ...WIN, tier: 'holdin', policy: gatePolicy({ nEffFloor: 99 }) })).toMatchObject({ verdict: 'hold:underpowered', compare: { ruleFired: 'power:nEff' } })
      for (const req of [WIN, NULL, REGRESS]) {
        const j = g.judge({ ...req, tier: 'holdin' })
        expect(j.verdict).not.toBe('promote')
        if (verdict(g, req) === 'promote') expect(j.compare.ruleFired).toBe('screen')
      }
      // the holdout verdict is the rule's own, unchanged
      expect(verdict(g, WIN)).toBe(g.judge({ ...WIN, tier: 'holdout' }).verdict)
    }
  })
})

// ---------------------------------------------------------------- rules

describe('sign rules', () => {
  it('keep-better and hillclimb', () => {
    expect(verdict(keepBetter(), WIN)).toBe('promote')
    expect(verdict(keepBetter(), NULL)).toBe('hold')
    expect(verdict(hillclimb(), NULL)).toBe('hold')
    expect(hillclimb().judge(NULL).compare.ruleFired).toBe('hillclimb:strict')
    // lateral accepts a tie
    expect(verdict(hillclimb({ strict: false }), NULL)).toBe('promote')
    expect(hillclimb({ strict: false }).judge(NULL).compare.ruleFired).toBe('hillclimb:lateral')
    expect(verdict(hillclimb({ strict: false }), REGRESS)).toBe('hold')
  })

  it('dgm-keep-better compares unpaired means with a leeway', () => {
    expect(verdict(dgmKeepBetter(), WIN)).toBe('promote')
    expect(verdict(dgmKeepBetter(), NULL)).toBe('promote')
    expect(verdict(dgmKeepBetter(), REGRESS)).toBe('hold')
    expect(verdict(dgmKeepBetter({ leeway: 0.5 }), REGRESS)).toBe('promote')
    expect(verdict(dgmKeepBetter({ leeway: 0 }), request(champ, champ.map(v => v - 0.01)))).toBe('hold')
    // unpaired: a challenger with a different task set is still judged on its mean
    const unpaired = request(champ, champ.map(() => 1))
    unpaired.challenger = unpaired.challenger.map(a => ({ ...a, taskId: `${a.taskId}x` }))
    expect(unpaired.challenger.length).toBe(N)
    expect(verdict(dgmKeepBetter(), unpaired)).toBe('promote')
  })

  it('self-harness needs both halves >= 0 and one > 0', () => {
    expect(verdict(selfHarness(), WIN)).toBe('promote')
    expect(verdict(selfHarness(), NULL)).toBe('hold')
    // a win confined to one half is a lateral move on the other: accepted
    const oneSided = request(champ, champ.map((v, i) => (i < 4 ? 1 : v)))
    expect(verdict(selfHarness(), oneSided)).toBe('promote')
    // a single loss and nothing else puts one half below 0
    const loss = request(champ, champ.map((v, i) => (i === 1 ? 0 : v)))
    expect(verdict(selfHarness(), loss)).toBe('hold')
    // deterministic in the seed
    const mixed = request(champ, champ.map((v, i) => (i === 1 ? 0 : i < 6 ? 1 : v)))
    expect(selfHarness().judge({ ...mixed, seed: 11 })).toEqual(selfHarness().judge({ ...mixed, seed: 11 }))
  })

  it('rsea decides on the held-out half only', () => {
    expect(verdict(rsea(), WIN)).toBe('promote')
    expect(verdict(rsea(), TIE)).toBe('promote')
    expect(rsea().judge(TIE).compare.ruleFired).toBe('rsea:lateral')
    expect(verdict(rsea({ strict: true }), TIE)).toBe('hold')
    expect(verdict(rsea({ strict: true }), WIN)).toBe('promote')
    expect(verdict(rsea({ strict: true }), REGRESS)).toBe('hold')
  })

  it('hcl-commit counts improvement in task units and caps regressions', () => {
    expect(verdict(hclCommit(), WIN)).toBe('promote')
    expect(verdict(hclCommit(), NULL)).toBe('hold')
    // +3 tasks, 1 regression
    const req = request(champ, champ.map((v, i) => (i === 1 ? 0 : i < 6 ? 1 : v)))
    expect(hclCommit().judge(req).compare.mean).toBeCloseTo(2 / N)
    expect(verdict(hclCommit(), req)).toBe('promote')
    expect(verdict(hclCommit({ deltaMin: 3 }), req)).toBe('hold')
    expect(verdict(hclCommit({ tau: 0 }), req)).toBe('hold')
    expect(verdict(hclCommit({ tau: 1 }), req)).toBe('promote')
  })
})

describe('interval and test rules', () => {
  it('clusteredSe reduces to sd/sqrt(n) on singletons and grows with within-cluster correlation', () => {
    const d = [0.1, -0.2, 0.3, 0.05, -0.1, 0.2]
    const singles = clusteredSe(d, d.map((_, i) => `c${i}`))
    let m = 0
    for (const x of d) m += x / d.length
    let s = 0
    for (const x of d) s += (x - m) ** 2
    expect(singles).toBeCloseTo(Math.sqrt(s) / d.length)
    expect(clusteredSe([1, 1, -1, -1], ['a', 'a', 'b', 'b'])).toBeGreaterThan(clusteredSe([1, 1, -1, -1], ['a', 'b', 'a', 'b']))
  })

  it('miller and normal-one-sided', () => {
    expect(verdict(miller(), WIN)).toBe('promote')
    expect(verdict(miller(), NULL)).toBe('hold')
    expect(verdict(normalOneSided(), WIN)).toBe('promote')
    expect(verdict(normalOneSided(), NULL)).toBe('hold')
    // a small uniform lift on a noisy null is inside the 0.025 bound but outside a loose one
    const small = request(champ, champ.map((v, i) => v + (i % 2 === 0 ? 0.25 : -0.15)))
    expect(verdict(miller(), small)).toBe('hold')
    expect(verdict(normalOneSided({ alpha: 0.25 }), small)).toBe('promote')
    expect(normalOneSided({ alpha: 0.25 }).judge(small).compare.holm.adjustedAlpha).toBe(0.25)
  })

  it('mcnemarExactP', () => {
    expect(mcnemarExactP(0, 0)).toBe(1)
    expect(mcnemarExactP(5, 5)).toBe(1)
    expect(mcnemarExactP(0, 6)).toBeCloseTo(2 / 64)
    expect(mcnemarExactP(1, 9)).toBeCloseTo((2 * 11) / 1024)
    expect(mcnemarExactP(14, 7)).toBeCloseTo(0.189, 2)
  })

  it('mcnemar promotes only a significant win in the right direction', () => {
    expect(verdict(mcnemar(), WIN)).toBe('promote')
    expect(verdict(mcnemar(), NULL)).toBe('hold')
    expect(verdict(mcnemar(), REGRESS)).toBe('hold')
    // 4 wins, 0 losses: p = 2/16 = 0.125 > 0.05
    expect(verdict(mcnemar(), request(champ, champ.map((v, i) => (i < 8 ? 1 : v))))).toBe('hold')
    expect(verdict(mcnemar({ alpha: 0.2 }), request(champ, champ.map((v, i) => (i < 8 ? 1 : v))))).toBe('promote')
  })

  it('pace crosses 1/alpha only on a run of wins', () => {
    // 20 wins in a row: 1.5^20 >> 20
    expect(verdict(pace(), WIN)).toBe('promote')
    expect(verdict(pace(), NULL)).toBe('hold')
    // 7 wins: 1.5^7 = 17.1 < 20; 8 wins: 25.6 >= 20
    expect(verdict(pace(), request(champ, champ.map((v, i) => (i < 14 ? 1 : v))))).toBe('hold')
    expect(verdict(pace(), request(champ, champ.map((v, i) => (i < 16 ? 1 : v))))).toBe('promote')
    expect(verdict(pace({ alpha: 0.1 }), request(champ, champ.map((v, i) => (i < 14 ? 1 : v))))).toBe('promote')
    expect(verdict(pace({ lambda: 0.1 }), WIN)).toBe('hold')
  })

  it('autoscientists: M-sigma on the mean, else every replicate', () => {
    expect(verdict(autoscientists(), WIN)).toBe('promote')
    expect(autoscientists().judge(WIN).compare.ruleFired).toBe('autoscientists:mean')
    expect(verdict(autoscientists(), NULL)).toBe('hold')
    // a lift below 2 sigma at one and at two replicates holds on the mean; with two replicates that both improve it promotes
    const lift = champ.map((v, i) => v + (i % 2 === 0 ? 0.2 : -0.15))
    expect(verdict(autoscientists(), request(champ, lift))).toBe('hold')
    expect(verdict(autoscientists(), request(champ, lift, {}, 2))).toBe('promote')
    expect(autoscientists().judge(request(champ, lift, {}, 2)).compare.ruleFired).toBe('autoscientists:replicates')
    expect(autoscientists().judge(request(champ, lift, {}, 2)).compare.replicates).toBe(2)
    expect(verdict(autoscientists({ M: 0.5 }), request(champ, lift))).toBe('promote')
  })

  it('ladder: paper and samsara steps, against bestSoFar', () => {
    expect(verdict(ladder(), WIN)).toBe('promote')
    expect(verdict(ladder(), NULL)).toBe('hold')
    expect(ladder().judge(NULL).compare.ruleFired).toBe('ladder:paper')
    expect(verdict(ladder({ variant: 'samsara' }), WIN)).toBe('promote')
    expect(ladder({ variant: 'samsara' }).judge(WIN).compare.ruleFired).toBe('ladder:samsara')
    expect(verdict(ladder(), { ...WIN, bestSoFar: 0.6 })).toBe('hold')
  })
})
