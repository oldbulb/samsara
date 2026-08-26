import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@oldbulb/samsara-kernel'
import { Signoff, SignoffError, PENDING_TTL_MS, canonicalJson, internals, generateKeypair, proofSha, sha256, sign, type ConsentRecord, type ProofPayload } from '../src/index.ts'
import { confirm, keygen, pending, SignoffClientError } from '../src/client.ts'

const dirs: string[] = []
afterEach(() => {
  internals.now = () => Date.now()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function open() {
  // short tmpdir: unix socket paths are length-limited
  const dir = mkdtempSync(join('/tmp', 'sso-'))
  dirs.push(dir)
  // The keypair stays on the signer's side; the host holds a copy of the public key only (E2).
  const keys = await keygen(join(dir, 'signer'))
  const publicKeyPath = join(dir, 'signoff.pub')
  copyFileSync(keys.publicKeyPath, publicKeyPath)
  const socketPath = join(dir, 's.sock')
  const ctx = new Context()
  const fiber = ctx.plugin(Signoff, { socketPath, publicKeyPath })
  await fiber
  await ctx.signoff.ready
  return { ctx, dir, socketPath, keys, publicKeyPath, signoff: ctx.signoff, close: () => fiber.dispose() }
}

const proofFor = (privateKey: string, p: Partial<ProofPayload> & { nonce: string; rowId: string }) => {
  const payload: ProofPayload = { action: 'promote', who: 'alice', issuedAt: new Date().toISOString(), ...p }
  return { payload, signature: sign(privateKey, payload) }
}

describe('Signoff service', () => {
  it('keygen writes a 0600 private key and a public key beside it', async () => {
    const { dir, keys, close } = await open()
    expect(statSync(keys.privateKeyPath).mode & 0o777).toBe(0o600)
    expect(readFileSync(join(dir, 'signoff.pub'), 'utf8')).toMatch(/BEGIN PUBLIC KEY/)
    await close()
  })

  it('request → confirm yields a consent and consumes the nonce', async () => {
    const { signoff, keys, close } = await open()
    const p = signoff.request('row-1', 'promote', { roundId: 'round-1' })
    expect(p.nonce).toMatch(/^[0-9a-f]{64}$/)
    expect(Date.parse(p.expiresAt) - Date.now()).toBeGreaterThan(PENDING_TTL_MS - 5000)
    const priv = readFileSync(keys.privateKeyPath, 'utf8')
    const proof = proofFor(priv, { nonce: p.nonce, rowId: 'row-1', roundId: 'round-1' })
    const consent = signoff.confirm(proof)
    expect(consent).toMatchObject({ challenger_id: 'row-1', action: 'promote', who: 'alice', channel: 'unix-socket', round_id: 'round-1', proof })
    expect(consent.proof_sha).toMatch(/^[0-9a-f]{64}$/)
    expect(signoff.pending()).toEqual([])
    expect(() => signoff.confirm(proof)).toThrow(expect.objectContaining({ code: 'UNKNOWN_NONCE' }))
    await close()
  })

  it('E2: a promote sign-off is bound to the round it decides; the proof must name it', async () => {
    const { signoff, keys, close } = await open()
    const priv = readFileSync(keys.privateKeyPath, 'utf8')
    expect(() => signoff.request('row-1', 'promote')).toThrow(expect.objectContaining({ code: 'BAD_REQUEST' }))
    const p = signoff.request('row-1', 'promote', { roundId: 'round-1' })
    expect(p.roundId).toBe('round-1')
    expect(() => signoff.confirm(proofFor(priv, { nonce: p.nonce, rowId: 'row-1' }))).toThrow(expect.objectContaining({ code: 'ROW_MISMATCH' }))
    expect(() => signoff.confirm(proofFor(priv, { nonce: p.nonce, rowId: 'row-1', roundId: 'round-2' }))).toThrow(expect.objectContaining({ code: 'ROW_MISMATCH' }))
    expect(signoff.confirm(proofFor(priv, { nonce: p.nonce, rowId: 'row-1', roundId: 'round-1' })).round_id).toBe('round-1')
    // Other actions are bound to the row alone.
    const d = signoff.request('row-1', 'demote')
    expect(d.roundId).toBeUndefined()
    expect(signoff.confirm(proofFor(priv, { nonce: d.nonce, rowId: 'row-1', action: 'demote' })).round_id).toBeUndefined()
    await close()
  })

  it('E2: verifyConsent re-checks a stored row — its proof, its hashes, its subject and the signature', async () => {
    const { signoff, keys, close } = await open()
    const priv = readFileSync(keys.privateKeyPath, 'utf8')
    const p = signoff.request('row-1', 'promote', { roundId: 'round-1' })
    const consent = signoff.confirm(proofFor(priv, { nonce: p.nonce, rowId: 'row-1', roundId: 'round-1' }))
    expect(() => signoff.verifyConsent(consent)).not.toThrow()
    const code = (row: Partial<ConsentRecord>) => { try { signoff.verifyConsent({ ...consent, ...row } as ConsentRecord); return undefined } catch (e) { return (e as SignoffError).code } }
    expect(code({ proof: undefined })).toBe('NO_PROOF')
    expect(code({ proof_sha: 'f'.repeat(64) })).toBe('BAD_PROOF')
    expect(code({ id: 'inserted-by-hand' })).toBe('BAD_PROOF')
    // The row's subject, action or round moved away from what was signed.
    expect(code({ challenger_id: 'row-2' })).toBe('ROW_MISMATCH')
    expect(code({ round_id: 'round-2' })).toBe('ROW_MISMATCH')
    // A consistent row signed by a key the host does not trust.
    const stranger = generateKeypair().privateKey
    const forged = { payload: consent.proof.payload, signature: sign(stranger, consent.proof.payload) }
    const forgedSha = proofSha(forged)
    expect(code({ proof: forged, proof_sha: forgedSha, id: sha256(canonicalJson(['consent', forgedSha])) })).toBe('BAD_SIGNATURE')
    await close()
  })

  it('E2: a private key beside the public key on the host refuses every confirm until it is moved', async () => {
    const { signoff, keys, dir, close } = await open()
    const priv = readFileSync(keys.privateKeyPath, 'utf8')
    const onHost = join(dir, 'signoff.key')
    copyFileSync(keys.privateKeyPath, onHost)
    const p = signoff.request('row-1', 'demote')
    expect(() => signoff.confirm(proofFor(priv, { nonce: p.nonce, rowId: 'row-1', action: 'demote' }))).toThrow(expect.objectContaining({ code: 'KEY_ON_HOST' }))
    expect(signoff.pending()).toHaveLength(1)
    rmSync(onHost)
    expect(signoff.confirm(proofFor(priv, { nonce: p.nonce, rowId: 'row-1', action: 'demote' })).challenger_id).toBe('row-1')
    await close()
  })

  it('rejects bad signature, wrong row, expired and unknown nonces with codes', async () => {
    const { signoff, keys, close } = await open()
    const priv = readFileSync(keys.privateKeyPath, 'utf8')
    const stranger = generateKeypair().privateKey
    const code = (fn: () => unknown) => {
      try { fn() } catch (e) { return (e as SignoffError).code }
      return undefined
    }

    const p = signoff.request('row-1', 'reopen')
    expect(code(() => signoff.confirm(proofFor(stranger, { nonce: p.nonce, rowId: 'row-1', action: 'reopen' })))).toBe('BAD_SIGNATURE')
    expect(code(() => signoff.confirm(proofFor(priv, { nonce: p.nonce, rowId: 'row-2', action: 'reopen' })))).toBe('ROW_MISMATCH')
    expect(code(() => signoff.confirm(proofFor(priv, { nonce: p.nonce, rowId: 'row-1', action: 'reject' })))).toBe('ROW_MISMATCH')
    expect(code(() => signoff.confirm(proofFor(priv, { nonce: 'f'.repeat(64), rowId: 'row-1', action: 'reopen' })))).toBe('UNKNOWN_NONCE')
    // a failed attempt leaves the nonce pending
    expect(signoff.pending()).toHaveLength(1)

    const t0 = Date.now()
    internals.now = () => t0 + PENDING_TTL_MS + 1
    expect(code(() => signoff.confirm(proofFor(priv, { nonce: p.nonce, rowId: 'row-1', action: 'reopen' })))).toBe('EXPIRED')
    expect(signoff.pending()).toEqual([])
    await close()
  })

  it('socket end to end: pending + confirm via the client library; dispose unlinks the socket', async () => {
    const { signoff, socketPath, keys, close } = await open()
    expect(statSync(socketPath).mode & 0o777).toBe(0o600)
    signoff.request('row-9', 'eval_config_change')
    expect(await pending(socketPath)).toMatchObject([{ rowId: 'row-9', action: 'eval_config_change' }])

    await expect(confirm({ socketPath, privateKeyPath: keys.privateKeyPath, rowId: 'row-9', action: 'promote', who: 'bob' }))
      .rejects.toMatchObject({ code: 'NOT_PENDING' })

    const consent = await confirm({ socketPath, privateKeyPath: keys.privateKeyPath, rowId: 'row-9', action: 'eval_config_change', who: 'bob' })
    expect(consent).toMatchObject({ challenger_id: 'row-9', action: 'eval_config_change', who: 'bob', channel: 'unix-socket' })
    expect(await pending(socketPath)).toEqual([])
    // the client signs the round a promote sign-off names, and the consent carries it
    signoff.request('row-11', 'promote', { roundId: 'round-11' })
    const promote = await confirm({ socketPath, privateKeyPath: keys.privateKeyPath, rowId: 'row-11', action: 'promote', who: 'bob' })
    expect(promote).toMatchObject({ challenger_id: 'row-11', action: 'promote', round_id: 'round-11', proof: { payload: { roundId: 'round-11' } } })
    expect(() => signoff.verifyConsent(promote)).not.toThrow()

    // a proof signed by a key the host does not trust is refused on the wire too
    const strangerKey = join(dirs[0]!, 'stranger.key')
    writeFileSync(strangerKey, generateKeypair().privateKey, { mode: 0o600 })
    signoff.request('row-10', 'promote', { roundId: 'round-10' })
    const err = await confirm({ socketPath, privateKeyPath: strangerKey, rowId: 'row-10', action: 'promote', who: 'mallory' }).catch(e => e)
    expect(err).toBeInstanceOf(SignoffClientError)
    expect(err.code).toBe('BAD_SIGNATURE')

    await close()
    expect(existsSync(socketPath)).toBe(false)
    await expect(pending(socketPath)).rejects.toThrow()
  })
})
