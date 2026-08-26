import { describe, expect, it } from 'vitest'
import type { Context } from '@oldbulb/samsara-kernel'
import type { ConsentRow } from '@oldbulb/samsara-ledger'
import type { ConsentRecord, PendingSignoff, SignoffAction } from '@oldbulb/samsara-signoff'
import { gateChange, type Io } from '../src/index.ts'

/** The two ledger calls the command makes. */
class MemLedger {
  consents: ConsentRow[] = []
  consentsOf(subject: string) { return this.consents.filter((c) => c.challenger_id === subject) }
  async recordConsent(row: ConsentRow) { if (!this.consents.some((c) => c.id === row.id)) this.consents.push(row); return row.id }
}

/** ctx.signoff without a socket: `request` opens a pending row, `answer` plays the proof the human would submit. */
class FakeSignoff {
  ready = Promise.resolve()
  config = { socketPath: '/tmp/fake.sock', publicKeyPath: '/tmp/fake.pub' }
  requested: PendingSignoff[] = []
  private listeners = new Set<(c: ConsentRecord) => void>()
  request(rowId: string, action: SignoffAction): PendingSignoff {
    const p = { nonce: 'n', rowId, action, expiresAt: 'later' }
    this.requested.push(p)
    return p
  }
  onConfirm(l: (c: ConsentRecord) => void) { this.listeners.add(l); return () => { this.listeners.delete(l) } }
  answer(rowId: string, action: SignoffAction, id: string) {
    const c: ConsentRecord = { id, challenger_id: rowId, action, who: 'me', channel: 'unix-socket', proof_sha: 'p', at: 't' }
    for (const l of this.listeners) l(c)
  }
}

function fakeCtx(ledger: MemLedger, signoff?: FakeSignoff): Context {
  return { ledger, get: (key: string) => (key === 'signoff' ? signoff : undefined) } as unknown as Context
}

function io(): Io & { out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return { out, err, stdout: { write: (s: string) => out.push(s) }, stderr: { write: (s: string) => err.push(s) }, exit() {} }
}

const GATE = 'keep-better@0.1.0'

describe('gate change', () => {
  it('with --wait, opens a gate_change sign-off on the name@version and the confirming proof becomes the consents row', async () => {
    const ledger = new MemLedger()
    const signoff = new FakeSignoff()
    const o = io()
    const done = gateChange(fakeCtx(ledger, signoff), { gate: GATE, wait: 5 }, o)
    await new Promise((r) => setTimeout(r, 0))
    expect(signoff.requested).toEqual([{ nonce: 'n', rowId: GATE, action: 'gate_change', expiresAt: 'later' }])
    // a promote on some challenger and a gate_change on another gate are not the answer
    signoff.answer('c1', 'promote', 'x')
    signoff.answer('gate-fast@0.1.0', 'gate_change', 'y')
    signoff.answer(GATE, 'gate_change', 'k')
    const consent = await done
    expect(consent).toMatchObject({ id: 'k', challenger_id: GATE, action: 'gate_change' })
    expect(ledger.consentsOf(GATE)).toEqual([consent])
    expect(o.out.join('')).toBe(`gate_change consent k names ${GATE} (by me at t)\n`)
    expect(o.err.join('')).toContain('sign-off pending on /tmp/fake.sock')
  })

  it('without --wait, reports the consent already on the ledger or refuses with the command that opens one', async () => {
    const ledger = new MemLedger()
    const o = io()
    await expect(gateChange(fakeCtx(ledger), { gate: GATE }, o)).rejects.toThrow(`no gate_change consent on the ledger for ${GATE}; run \`gate change ${GATE} --wait <seconds>\``)
    ledger.consents.push({ id: 'old', challenger_id: GATE, action: 'gate_change', who: 'me', channel: 'unix-socket', proof_sha: 'p', at: '1' })
    ledger.consents.push({ id: 'new', challenger_id: GATE, action: 'gate_change', who: 'me', channel: 'unix-socket', proof_sha: 'p', at: '2' })
    ledger.consents.push({ id: 'other', challenger_id: GATE, action: 'promote', who: 'me', channel: 'unix-socket', proof_sha: 'p', at: '3' })
    const consent = await gateChange(fakeCtx(ledger), { gate: GATE }, o)
    expect(consent.id).toBe('new')
    expect(o.out.join('')).toBe(`gate_change consent new names ${GATE} (by me at 2)\n`)
  })

  it('times out when no proof answers within --wait', async () => {
    const signoff = new FakeSignoff()
    await expect(gateChange(fakeCtx(new MemLedger(), signoff), { gate: GATE, wait: 0.01 }, io())).rejects.toThrow(`no gate_change consent for ${GATE} arrived within 0.01s`)
  })
})
