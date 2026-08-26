// The errors table: every LifecycleError code and every LedgerError code
// maps to a sentence and a next action, and the two renderers (thrown errors,
// refusals) carry them; anything that is not a service or ledger error passes
// through unchanged.

import { describe, expect, it } from 'vitest'
import { LedgerError, type LedgerErrorCode } from '@oldbulb/samsara-ledger'
import { LifecycleError, type LifecycleErrorCode } from '@oldbulb/samsara-lifecycle'
import { LEDGER_ERRORS, LIFECYCLE_ERRORS, codeOf, describeError, explain, explained } from '../src/errors.ts'

/** The unions, spelled out: a code added to either package without a row in the table fails here (and the table's type fails the build). */
const LIFECYCLE_CODES: LifecycleErrorCode[] = [
  'NOT_COMPARABLE', 'GATE_NOT_CONSENTED', 'GATE_MISMATCH', 'PROFILE_CHANGED', 'NO_NOISE_FLOOR', 'ROUND_CLOSED', 'NOT_IN_ROUND',
  'BAD_TRANSITION', 'NO_CONSENT', 'BUDGET_EXCEEDED', 'OPERATOR_IS_PROPOSER', 'UNKNOWN',
]
const LEDGER_CODES: LedgerErrorCode[] = ['VERDICT_EXISTS', 'ATTEMPT_EXISTS', 'UNKNOWN_CHALLENGER', 'UNKNOWN_ROUND', 'UNKNOWN_EXPERIMENT', 'NOT_OPEN']

describe('the errors table', () => {
  it('names every lifecycle code and every ledger code, and nothing else', () => {
    expect(Object.keys(LIFECYCLE_ERRORS).sort()).toEqual([...LIFECYCLE_CODES].sort())
    expect(Object.keys(LEDGER_ERRORS).sort()).toEqual([...LEDGER_CODES].sort())
  })

  it.each(LIFECYCLE_CODES)('%s: a sentence and a next action, rendered from a LifecycleError with its message', (code) => {
    const e = new LifecycleError(code, `the service said ${code.toLowerCase()}`)
    const x = explain(code)!
    expect(x.code).toBe(code)
    expect(x.sentence).toMatch(/^[A-Z].*\.$/)
    expect(x.next.length).toBeGreaterThan(20)
    expect(x.next).not.toBe(x.sentence)
    expect(codeOf(e)).toBe(code)
    const text = describeError(e)
    expect(text.split('\n')).toEqual([`the service said ${code.toLowerCase()} [${code}]`, x.sentence, `Next: ${x.next}`])
  })

  it.each(LEDGER_CODES)('%s: a sentence and a next action, rendered from a LedgerError with its message', (code) => {
    const e = new LedgerError(`the ledger said ${code.toLowerCase()}`, code)
    const x = explain(code)!
    expect(x.sentence).toMatch(/^[A-Z].*\.$/)
    expect(x.next.length).toBeGreaterThan(20)
    expect(describeError(e)).toBe(`the ledger said ${code.toLowerCase()} [${code}]\n${x.sentence}\nNext: ${x.next}`)
  })

  it('every next action names a tool, a command or what to configure', () => {
    for (const code of [...LIFECYCLE_CODES, ...LEDGER_CODES]) {
      expect(explain(code)!.next, code).toMatch(/samsara_[a-z_]+|\/samsara [a-z]+|configure|retry|run again|propose|open/)
    }
  })

  it('NO_NOISE_FLOOR takes the calibrate quote as its next action, or the generic call without one', () => {
    expect(explain('NO_NOISE_FLOOR', { calibrate: 'samsara_calibrate fixture/fake on holdin x3 ≈ $1.20 (12 attempts)' })!.next).toBe('calibrate first: samsara_calibrate fixture/fake on holdin x3 ≈ $1.20 (12 attempts)')
    expect(explain('NO_NOISE_FLOOR')!.next).toBe('calibrate first: samsara_calibrate { pack, loop, set: "holdin", reruns: 3 }')
    expect(describeError(new LifecycleError('NO_NOISE_FLOOR', 'no floor'), { calibrate: 'samsara_calibrate x ≈ $2' })).toContain('Next: calibrate first: samsara_calibrate x ≈ $2')
  })

  it('explained renders a refusal code the table knows, and leaves any other code or error alone', () => {
    expect(explained('BUDGET_EXCEEDED', 'spent')).toMatch(/^spent \[BUDGET_EXCEEDED\]\n.+\nNext: .+\/samsara budget/)
    expect(explained('NOT_APPROVED', 'the person refused')).toBe('the person refused')
    expect(explain('NOT_A_CODE')).toBeUndefined()
    expect(codeOf(new Error('plain'))).toBeUndefined()
    expect(describeError(new Error('plain'))).toBe('plain')
    expect(describeError('a string')).toBe('a string')
    // A code that happens to be a property name of every object is no code.
    expect(explain('toString')).toBeUndefined()
  })
})
