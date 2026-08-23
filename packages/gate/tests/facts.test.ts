// Rule 0: the gate refuses to compare attempts from two different harnesses.

import { describe, expect, it } from 'vitest'
import { gateDefault, gatePolicy, type CompareRequest, type ScoredAttempt } from '../src/index.ts'

function arm(id: string, value: number): ScoredAttempt[] {
  return ['t1', 't2', 't3'].map((taskId, i) => ({
    attemptId: `${id}-${i}`, challengerId: id, taskId, entityKey: `e${i}`, sample: 0, status: 'COMPLETED',
    metric: 'score', value, kind: 'reality', cost: { usd: 1, tokens: 100 },
  }))
}

function request(factsSha?: CompareRequest['factsSha']): CompareRequest {
  return {
    challenger: arm('a', 1), champion: arm('b', 0), tier: 'smoke', primaryMetric: 'score',
    noiseFloor: { sdPaired: 0, nReruns: 0 }, policy: gatePolicy({ nEffFloor: 3 }), round: { k: 1, index: 0 }, seed: 0,
    ...(factsSha ? { factsSha } : {}),
  }
}

describe('gate-default rule 0: facts mismatch', () => {
  it('refuses when the two facts shas differ, before any other rule', () => {
    const j = gateDefault(request({ challenger: 'aaa', champion: 'bbb' }))
    expect(j.verdict).toBe('invalid')
    expect(j.compare.ruleFired).toBe('facts:mismatch')
  })
  it('refuses a judge-kind mismatch as facts first (rule 0 precedes rule 1)', () => {
    const req = request({ challenger: 'aaa', champion: 'bbb' })
    req.challenger[0]!.kind = 'judge'
    expect(gateDefault(req).compare.ruleFired).toBe('facts:mismatch')
  })
  it('judges normally when the shas match or are absent', () => {
    expect(gateDefault(request({ challenger: 'aaa', champion: 'aaa' })).compare.ruleFired).toBe('validity')
    expect(gateDefault(request()).compare.ruleFired).toBe('validity')
  })
})
