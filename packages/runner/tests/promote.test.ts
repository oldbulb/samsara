// `promote` and `demote` as the plugin runs them: the consent from the ledger,
// then the service's decide / demote; the champion and the servings follow.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Context } from '@oldbulb/samsara-kernel'
import { calibrate } from '../src/calibrate.ts'
import { challenge, GATE_DEFAULT, GATE_PERMISSIVE } from '../src/challenge.ts'
import { demote, promote, type Io } from '../src/index.ts'
import { consent, MINI, MINI_SKILL, openHarness, type Harness } from './harness.ts'

const PERMISSIVE = `${GATE_PERMISSIVE.name}@${GATE_PERMISSIVE.version}`

function io(): Io & { out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return { out, err, stdout: { write: (s: string) => out.push(s) }, stderr: { write: (s: string) => err.push(s) }, exit() {} }
}

/** ctx as the commands read it: the ledger, the service, and ctx.champion with a replay check. */
function ctxOf(h: Harness): Context {
  const champion = { current: () => h.champion.current(), replayCheck: () => ({ equal: true }) }
  return { ledger: h.ledger, lifecycle: h.lifecycle, get: (key: string) => (key === 'champion' ? champion : undefined) } as unknown as Context
}

/** A holdout promote verdict, the only kind a round ranks: the noise floor first (S1), then the chain on the held-out set under the permissive gate. */
async function promoteVerdict(h: Harness) {
  h.ledger.consents.push(consent(PERMISSIVE, 'gate_change'))
  await calibrate({ pack: MINI, loop: 'fake', set: 'holdout', out: mkdtempSync(resolve(tmpdir(), 'runner-promote-')), maxTurns: 5, maxMinutes: 1, metric: 'pass_rate', reruns: 3 }, h.deps())
  return challenge({
    pack: MINI, loop: 'fake', set: 'holdout', repeat: 1, out: mkdtempSync(resolve(tmpdir(), 'runner-promote-')), maxTurns: 5, maxMinutes: 1,
    surface: 'skill', skillDir: MINI_SKILL, intent: 'i', metric: 'pass_rate', nEffFloor: 1, withChampion: false, gatePolicy: 'default',
  }, h.deps())
}

describe('promote / demote', () => {
  it('promote decides the open round with the consent; demote needs its own consent; servings follow', async () => {
    const h = await openHarness({ gate: [GATE_DEFAULT, GATE_PERMISSIVE] })
    const r = await promoteVerdict(h)
    expect(r.outcome).toMatchObject({ pending: 'consent', candidate: r.challengerId })
    const ctx = ctxOf(h)
    await expect(promote(ctx, { challengerId: r.challengerId }, io())).rejects.toThrow(`no promote consent on the ledger for ${r.challengerId}; run \`promote ${r.challengerId} --wait <seconds>\``)
    expect(h.champion.promoted).toEqual([])

    // E2: a promote consent from another round is not this round's.
    h.ledger.consents.push(consent(r.challengerId, 'promote', 'elsewhere', 'another-round'))
    await expect(promote(ctx, { challengerId: r.challengerId }, io())).rejects.toThrow(`no promote consent on the ledger for ${r.challengerId}`)
    const c = consent(r.challengerId, 'promote', undefined, r.roundId)
    h.ledger.consents.push(c)
    const o = io()
    await promote(ctx, { challengerId: r.challengerId }, o)
    expect(o.out.join('')).toBe(`promoted ${r.challengerId} with consent ${c.id} (round ${r.roundId})\nkept: skill:${h.ledger.challenger(r.challengerId)!.skill_sha}\nreplay check: ok\n`)
    expect(h.champion.promoted).toEqual([[r.challengerId, c.id]])
    expect(h.ledger.round(r.roundId)).toMatchObject({ status: 'decided', outcome: { promoted: r.challengerId, consent_id: c.id, superseded: [] } })
    expect(h.ledger.servings().map((s) => [s.champion_id, s.by, s.to === undefined])).toEqual([[r.challengerId, 'promote', true]])
    // a second promote finds the round decided
    await expect(promote(ctx, { challengerId: r.challengerId }, io())).rejects.toThrow(`round ${r.roundId} is decided`)

    await expect(demote(ctx, { challengerId: r.challengerId, reason: 'regressed' }, io())).rejects.toThrow(`no demote consent on the ledger for ${r.challengerId}; run \`demote ${r.challengerId} --reason "regressed" --wait <seconds>\``)
    const d = consent(r.challengerId, 'demote')
    h.ledger.consents.push(d)
    const o2 = io()
    await demote(ctx, { challengerId: r.challengerId, reason: 'regressed' }, o2)
    expect(o2.out.join('')).toBe(`demoted ${r.challengerId} with consent ${d.id}\nkept: (none)\n`)
    expect(h.champion.demoted).toEqual([r.challengerId])
    expect(h.ledger.servings().map((s) => [s.by, s.consent_id, s.to !== undefined])).toEqual([['promote', c.id, true], ['demote', d.id, true]])
  })

  it('promote refuses a row whose verdict is not promote, and --round names the round', async () => {
    const h = await openHarness({ gate: [GATE_DEFAULT, GATE_PERMISSIVE] })
    const r = await promoteVerdict(h)
    const ctx = ctxOf(h)
    await expect(promote(ctx, { challengerId: r.championId }, io())).rejects.toThrow(`challenger ${r.championId} has verdict none, not promote`)
    h.ledger.consents.push(consent(r.challengerId, 'promote', undefined, r.roundId))
    await expect(promote(ctx, { challengerId: r.challengerId, round: 'nope' }, io())).rejects.toThrow('no round nope')
    await promote(ctx, { challengerId: r.challengerId, round: r.roundId }, io())
    expect(h.champion.promoted.map(([id]) => id)).toEqual([r.challengerId])
  })
})
