import { describe, expect, it } from 'vitest'
import { SIGNOFF_ACTIONS, canonicalPayload, generateKeypair, proofSha, sign, verify, type ProofPayload } from '../src/proof.ts'

const payload: ProofPayload = { nonce: 'ab'.repeat(32), rowId: 'row-1', action: 'promote', who: 'alice', issuedAt: '2026-01-01T00:00:00.000Z' }

describe('proof', () => {
  it('the action set is the ledger\'s consent action set', () => {
    expect(SIGNOFF_ACTIONS).toEqual(['promote', 'demote', 'reject', 'reopen', 'eval_config_change', 'gate_change', 'holdout_reveal'])
  })

  it('signs and verifies a payload', () => {
    const k = generateKeypair()
    const sig = sign(k.privateKey, payload)
    expect(verify(k.publicKey, payload, sig)).toBe(true)
  })

  it('canonical JSON ignores key order and extra fields', () => {
    const shuffled = { who: 'alice', issuedAt: payload.issuedAt, action: 'promote', rowId: 'row-1', nonce: payload.nonce, extra: 1 } as unknown as ProofPayload
    expect(canonicalPayload(shuffled)).toBe(canonicalPayload(payload))
    expect(proofSha({ payload: shuffled, signature: 'x' })).toBe(proofSha({ payload, signature: 'x' }))
  })

  it('rejects a wrong key, a tampered payload and garbage', () => {
    const k = generateKeypair()
    const other = generateKeypair()
    const sig = sign(k.privateKey, payload)
    expect(verify(other.publicKey, payload, sig)).toBe(false)
    expect(verify(k.publicKey, { ...payload, rowId: 'row-2' }, sig)).toBe(false)
    expect(verify(k.publicKey, payload, 'not base64 of anything')).toBe(false)
    expect(verify('not a pem', payload, sig)).toBe(false)
  })
})
