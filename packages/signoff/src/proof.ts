// Pure proof primitives: an Ed25519 signature over the canonical JSON of a
// sign-off payload. No I/O, no clock, no context — the same payload and key
// always produce the same verdict.

import { createHash, generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto'

/** Mirrors the ledger's `CONSENT_ACTIONS`. `gate_change` names a gate, not a challenger: its `rowId` is the policy's `name@version`. */
export type SignoffAction = 'promote' | 'demote' | 'reject' | 'reopen' | 'eval_config_change' | 'gate_change' | 'holdout_reveal'
export const SIGNOFF_ACTIONS: readonly SignoffAction[] = ['promote', 'demote', 'reject', 'reopen', 'eval_config_change', 'gate_change', 'holdout_reveal']

export interface ProofPayload {
  nonce: string
  rowId: string
  action: SignoffAction
  who: string
  issuedAt: string
  /** The round a `promote` consent is bound to (E2): the pending sign-off names it and the proof must repeat it. */
  roundId?: string
}

/** The file names `samsara-signoff keygen` writes. The private key belongs on the signer's side; the host reads only the public one. */
export const PRIVATE_KEY_FILE = 'signoff.key'
export const PUBLIC_KEY_FILE = 'signoff.pub'

export interface Proof {
  payload: ProofPayload
  signature: string
}

export interface Keypair {
  publicKey: string
  privateKey: string
}

/** JSON with object keys sorted recursively; arrays keep their order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[k]
      if (v !== undefined) out[k] = sortKeys(v)
    }
    return out
  }
  return value
}

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

/** The bytes that get signed: the canonical JSON of exactly the payload fields (`roundId` only when the sign-off carries one). */
export function canonicalPayload(payload: ProofPayload): string {
  const { nonce, rowId, action, who, issuedAt, roundId } = payload
  return canonicalJson({ nonce, rowId, action, who, issuedAt, ...(roundId !== undefined ? { roundId } : {}) })
}

/** Fresh Ed25519 keypair, both halves PEM (spki / pkcs8). */
export function generateKeypair(): Keypair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  return { publicKey, privateKey }
}

/** base64 Ed25519 signature of the canonical payload. */
export function sign(privateKeyPem: string, payload: ProofPayload): string {
  return cryptoSign(null, Buffer.from(canonicalPayload(payload)), privateKeyPem).toString('base64')
}

/** True iff `signature` is a valid signature of `payload` under the key; malformed input is simply false. */
export function verify(publicKeyPem: string, payload: ProofPayload, signature: string): boolean {
  try {
    return cryptoVerify(null, Buffer.from(canonicalPayload(payload)), publicKeyPem, Buffer.from(signature, 'base64'))
  } catch {
    return false
  }
}

/** Content hash of a whole proof (payload + signature); what the consent row records as `proof_sha`. */
export function proofSha(proof: Proof): string {
  return sha256(canonicalJson({ payload: canonicalPayload(proof.payload), signature: proof.signature }))
}
