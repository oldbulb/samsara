import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { LifecycleEvent } from '../src/index.ts'
import { challengerProposal, championProposal, consent, openLifecycle, runOptions, GATE_PICK, PACK, type Harness } from './fakes.ts'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function out(): string {
  const d = mkdtempSync(join(tmpdir(), 'samsara-lifecycle-events-'))
  dirs.push(d)
  return d
}

/** A subscribed service: `events` collects what it emits from here on. */
async function listen(over: Parameters<typeof openLifecycle>[0] = {}): Promise<Harness & { events: LifecycleEvent[]; off: () => void }> {
  const h = await openLifecycle(over)
  const events: LifecycleEvent[] = []
  const off = h.lifecycle.on('lifecycle/event', (e) => { events.push(e) })
  return { ...h, events, off }
}

async function openRound(h: Harness, over: Partial<Parameters<Harness['lifecycle']['openRound']>[0]> = {}) {
  return h.lifecycle.openRound({ pack: PACK, champion: championProposal(), metric: 'm', nEffFloor: 1, ...over })
}

async function calibrate(h: Harness) {
  return h.lifecycle.calibrate({ pack: PACK, champion: championProposal(), metric: 'm', set: 'holdout', reruns: 3, run: runOptions(out()) })
}

const kinds = (events: LifecycleEvent[]) => events.map((e) => e.kind)
const at = expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/)

describe('lifecycle/event', () => {
  it('openRound emits round/opened once per created round, with the experiment it opened under', async () => {
    const h = await listen()
    const round = await openRound(h, { openedAt: '2026-08-26T00:00:00.000Z' })
    expect(h.events).toEqual([{ kind: 'round/opened', roundId: round.id, championId: round.champion_id, at }])
    await openRound(h, { openedAt: '2026-08-26T00:00:00.000Z' })
    expect(h.events).toHaveLength(1)
    const exp = await h.lifecycle.preregister({ hypothesis: 'h', prediction: { metric: 'm', direction: 'up' }, pack: 'fixture', gate: round.gate, budget: {}, created_by: { channel: 'test' } })
    const under = await openRound(h, { experimentId: exp.id, openedAt: '2026-08-26T00:00:01.000Z' })
    expect(h.events[1]).toEqual({ kind: 'round/opened', roundId: under.id, championId: round.champion_id, experimentId: exp.id, at })
  })

  it('closeRound emits round/closed for the round it closed, not for one already decided', async () => {
    const h = await listen()
    const round = await openRound(h)
    await h.lifecycle.closeRound(round.id)
    await h.lifecycle.closeRound(round.id)
    expect(kinds(h.events)).toEqual(['round/opened', 'round/closed'])
    expect(h.events[1]).toEqual({ kind: 'round/closed', roundId: round.id, at })
  })

  it('propose emits the proposed transition for a created row only', async () => {
    const h = await listen()
    const round = await openRound(h)
    const proposal = challengerProposal(round.champion_id, 'a')
    const { id } = await h.lifecycle.propose(proposal, { roundId: round.id })
    await h.lifecycle.propose(proposal, { roundId: round.id })
    expect(h.events.slice(1)).toEqual([{ kind: 'challenger/transition', challengerId: id, roundId: round.id, status: 'proposed', at }])
  })

  it('open emits the opened transition in its round', async () => {
    const h = await listen()
    const round = await openRound(h)
    const { id } = await h.lifecycle.propose(challengerProposal(round.champion_id, 'a'), { roundId: round.id })
    await h.lifecycle.open(id)
    expect(h.events.at(-1)).toEqual({ kind: 'challenger/transition', challengerId: id, roundId: round.id, status: 'opened', at })
  })

  it('run emits running with the tier, and attempt/progress per finished executor run for the champion and the challenger', async () => {
    const h = await listen()
    const round = await openRound(h)
    const { id } = await h.lifecycle.propose(challengerProposal(round.champion_id, 'a'), { roundId: round.id })
    await h.lifecycle.open(id)
    await h.lifecycle.run(id, 'holdin', runOptions(out(), { repeat: 2 }))
    expect(h.events.slice(3)).toEqual([
      { kind: 'attempt/progress', challengerId: round.champion_id, roundId: round.id, tier: 'holdin', done: 8, total: 8, at },
      { kind: 'challenger/transition', challengerId: id, roundId: round.id, status: 'running', tier: 'holdin', at },
      { kind: 'attempt/progress', challengerId: id, roundId: round.id, tier: 'holdin', done: 8, total: 8, at },
    ])
  })

  it('judge emits the judged transition with the tier', async () => {
    const h = await listen()
    const round = await openRound(h)
    const { id } = await h.lifecycle.propose(challengerProposal(round.champion_id, 'a'), { roundId: round.id })
    await h.lifecycle.open(id)
    await h.lifecycle.run(id, 'holdin', runOptions(out()))
    await h.lifecycle.judge(id, 'holdin')
    expect(h.events.at(-1)).toEqual({ kind: 'challenger/transition', challengerId: id, roundId: round.id, status: 'judged', tier: 'holdin', at })
  })

  it('decide emits the siblings\' transitions and round/decided with the outcome', async () => {
    const h = await listen({ gate: [GATE_PICK] })
    h.ledger.consents.push(consent('gate-pick@test', 'gate_change'))
    await calibrate(h)
    const round = await openRound(h)
    const ids: string[] = []
    for (const [intent, value] of [['a', 0.9], ['b', 0.7]] as const) {
      const { id } = await h.lifecycle.propose(challengerProposal(round.champion_id, intent), { roundId: round.id })
      h.executor.values.set(id, value)
      await h.lifecycle.open(id)
      await h.lifecycle.run(id, 'holdout', runOptions(out()))
      ids.push(id)
    }
    for (const id of ids) await h.lifecycle.judge(id, 'holdout')
    const [a, b] = ids
    h.ledger.consents.push(consent(a!, 'promote', 'consent-a', round.id))
    h.events.length = 0
    await h.lifecycle.decide(round.id)
    expect(h.events).toEqual([
      { kind: 'challenger/transition', challengerId: a, roundId: round.id, status: 'decided', tier: 'holdout', at },
      { kind: 'challenger/transition', challengerId: b, roundId: round.id, status: 'judged', tier: 'holdout', at },
      { kind: 'round/decided', roundId: round.id, promoted: a, superseded: [b], consentId: 'consent-a', at },
    ])
  })

  it('demote emits the decided transition of the reversed row, in no round', async () => {
    const h = await listen({ gate: [GATE_PICK] })
    h.ledger.consents.push(consent('gate-pick@test', 'gate_change'))
    await calibrate(h)
    const round = await openRound(h)
    const { id } = await h.lifecycle.propose(challengerProposal(round.champion_id, 'a'), { roundId: round.id })
    await h.lifecycle.open(id)
    await h.lifecycle.run(id, 'holdout', runOptions(out()))
    await h.lifecycle.judge(id, 'holdout')
    h.ledger.consents.push(consent(id, 'promote', undefined, round.id))
    await h.lifecycle.decide(round.id)
    h.ledger.consents.push(consent(id, 'demote', 'demote-a'))
    h.events.length = 0
    await h.lifecycle.demote(id, 'regressed', 'demote-a')
    expect(h.events).toEqual([{ kind: 'challenger/transition', challengerId: id, status: 'decided', tier: 'holdout', at }])
  })

  it('calibrate emits noise_floor/recorded with the row id', async () => {
    const h = await listen()
    const floor = await calibrate(h)
    expect(h.events).toEqual([{ kind: 'noise_floor/recorded', id: floor.id, at }])
  })

  it('on returns the unsubscribe', async () => {
    const h = await listen()
    h.off()
    await openRound(h)
    expect(h.events).toEqual([])
  })
})
