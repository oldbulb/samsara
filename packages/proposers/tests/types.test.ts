import { describe, expect, it } from 'vitest'
import { ProposalError, assertTaskIdsWithin, canonicalJson, validateDraft, validateProposal, taskIdsOf } from '../src/types.ts'

const good = {
  parent: 'ch-parent',
  surface: 'skill',
  patch: { surface: 'skill', skill_dir: '/x/skill' },
  intent: 'Tighten the checklist.',
  prediction: { metric: 'pass', direction: 'up', predicted_fixes: ['t1'], at_risk: ['t2'] },
  proposer: { name: 'human', version: '1', config_sha: 'a'.repeat(64) },
}

describe('validateProposal', () => {
  it('accepts a complete skill proposal and a rows proposal', () => {
    expect(validateProposal(good)).toEqual(good)
    const rows = { ...good, surface: 'prompt', patch: { surface: 'prompt', rows: [{ id: 'r1', config: {} }] } }
    expect(validateProposal(rows).surface).toBe('prompt')
  })
  it('rejects missing fields', () => {
    for (const key of ['parent', 'surface', 'patch', 'intent', 'prediction', 'proposer'] as const) {
      const { [key]: _drop, ...rest } = good
      expect(() => validateProposal(rest)).toThrow(ProposalError)
    }
    expect(() => validateProposal({ ...good, prediction: { metric: 'pass' } })).toThrow(/direction/)
  })
  it('rejects an unknown surface, a wrong patch shape and a surface mismatch', () => {
    expect(() => validateProposal({ ...good, surface: 'weights' })).toThrow(ProposalError)
    expect(() => validateProposal({ ...good, patch: { surface: 'skill', rows: [] } })).toThrow(ProposalError)
    expect(() => validateProposal({ ...good, surface: 'prompt' })).toThrow(/does not match/)
    expect(() => validateProposal({ ...good, patch: { surface: 'prompt', rows: [{}] } })).toThrow(/does not match/)
  })
  it('rejects extra top-level fields and a malformed config_sha', () => {
    expect(() => validateProposal({ ...good, extra: 1 })).toThrow(ProposalError)
    expect(() => validateProposal({ ...good, proposer: { ...good.proposer, config_sha: 'nope' } })).toThrow(ProposalError)
  })
})

describe('validateDraft', () => {
  it('needs neither parent nor proposer', () => {
    const { parent: _p, proposer: _q, ...draft } = good
    expect(validateDraft(draft)).toEqual(draft)
    expect(() => validateDraft({ ...draft, proposer: good.proposer })).toThrow(ProposalError)
  })
})

describe('task ids', () => {
  it('lists prediction ids and rejects ones outside the allowed set', () => {
    expect(taskIdsOf(good)).toEqual(['t1', 't2'])
    expect(() => assertTaskIdsWithin(good, ['t1', 't2'])).not.toThrow()
    expect(() => assertTaskIdsWithin(good, ['t1'])).toThrow(/t2/)
  })
})

describe('canonicalJson', () => {
  it('sorts keys and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: [2, { z: 1, y: 2 }] } })).toBe('{"a":{"c":[2,{"y":2,"z":1}]},"b":1}')
  })
})
