import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@oldbulb/samsara-kernel'
import { Signoff, SignoffError, PENDING_TTL_MS, internals, generateKeypair, sign, type ProofPayload } from '../src/index.ts'
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
  const keys = await keygen(dir)
  const socketPath = join(dir, 's.sock')
  const ctx = new Context()
  const fiber = ctx.plugin(Signoff, { socketPath, publicKeyPath: keys.publicKeyPath })
  await fiber
  await ctx.signoff.ready
  return { ctx, dir, socketPath, keys, signoff: ctx.signoff, close: () => fiber.dispose() }
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
    const p = signoff.request('row-1', 'promote')
    expect(p.nonce).toMatch(/^[0-9a-f]{64}$/)
    expect(Date.parse(p.expiresAt) - Date.now()).toBeGreaterThan(PENDING_TTL_MS - 5000)
    const priv = readFileSync(keys.privateKeyPath, 'utf8')
    const proof = proofFor(priv, { nonce: p.nonce, rowId: 'row-1' })
    const consent = signoff.confirm(proof)
    expect(consent).toMatchObject({ challenger_id: 'row-1', action: 'promote', who: 'alice', channel: 'unix-socket' })
    expect(consent.proof_sha).toMatch(/^[0-9a-f]{64}$/)
    expect(signoff.pending()).toEqual([])
    expect(() => signoff.confirm(proof)).toThrow(expect.objectContaining({ code: 'UNKNOWN_NONCE' }))
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

    const p = signoff.request('row-1', 'promote')
    expect(code(() => signoff.confirm(proofFor(stranger, { nonce: p.nonce, rowId: 'row-1' })))).toBe('BAD_SIGNATURE')
    expect(code(() => signoff.confirm(proofFor(priv, { nonce: p.nonce, rowId: 'row-2' })))).toBe('ROW_MISMATCH')
    expect(code(() => signoff.confirm(proofFor(priv, { nonce: p.nonce, rowId: 'row-1', action: 'reject' })))).toBe('ROW_MISMATCH')
    expect(code(() => signoff.confirm(proofFor(priv, { nonce: 'f'.repeat(64), rowId: 'row-1' })))).toBe('UNKNOWN_NONCE')
    // a failed attempt leaves the nonce pending
    expect(signoff.pending()).toHaveLength(1)

    const t0 = Date.now()
    internals.now = () => t0 + PENDING_TTL_MS + 1
    expect(code(() => signoff.confirm(proofFor(priv, { nonce: p.nonce, rowId: 'row-1' })))).toBe('EXPIRED')
    expect(signoff.pending()).toEqual([])
    await close()
  })

  it('socket end to end: pending + confirm via the client library; dispose unlinks the socket', async () => {
    const { signoff, socketPath, keys, close } = await open()
    expect(statSync(socketPath).mode & 0o777).toBe(0o600)
    signoff.request('row-9', 'scorer_bump')
    expect(await pending(socketPath)).toMatchObject([{ rowId: 'row-9', action: 'scorer_bump' }])

    await expect(confirm({ socketPath, privateKeyPath: keys.privateKeyPath, rowId: 'row-9', action: 'promote', who: 'bob' }))
      .rejects.toMatchObject({ code: 'NOT_PENDING' })

    const consent = await confirm({ socketPath, privateKeyPath: keys.privateKeyPath, rowId: 'row-9', action: 'scorer_bump', who: 'bob' })
    expect(consent).toMatchObject({ challenger_id: 'row-9', action: 'scorer_bump', who: 'bob', channel: 'unix-socket' })
    expect(await pending(socketPath)).toEqual([])

    // a proof signed by a key the host does not trust is refused on the wire too
    const strangerKey = join(dirs[0]!, 'stranger.key')
    writeFileSync(strangerKey, generateKeypair().privateKey, { mode: 0o600 })
    signoff.request('row-10', 'promote')
    const err = await confirm({ socketPath, privateKeyPath: strangerKey, rowId: 'row-10', action: 'promote', who: 'mallory' }).catch(e => e)
    expect(err).toBeInstanceOf(SignoffClientError)
    expect(err.code).toBe('BAD_SIGNATURE')

    await close()
    expect(existsSync(socketPath)).toBe(false)
    await expect(pending(socketPath)).rejects.toThrow()
  })
})
