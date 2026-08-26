import { describe, expect, it } from 'vitest'
import { Context } from '@oldbulb/samsara-kernel'
import type { ChallengerRow, RoundRow } from '@oldbulb/samsara-ledger'
import { challengerProposal, championProposal, openLifecycle, PACK } from '../../lifecycle/tests/fakes.ts'
import { ABORT_RULE, abortRound, apply, staleLine, staleRounds, type StartupLedger, type StartupLifecycle } from '../src/startup.ts'

function round(over: Partial<RoundRow>): RoundRow {
  return {
    id: 'r', eval_config_sha: 'e', champion_id: 'champ', gate: { name: 'g', version: '1', policy_sha: 's' }, opened_at: '2026-08-26T00:00:00.000Z',
    shadow_gates: [], k: 0, sibling_ids: [], status: 'open', ...over, ...(over.sibling_ids ? { k: over.sibling_ids.length } : {}),
  }
}

/** The ledger slice reconciliation reads: rows by id, and nothing it could write. */
class FakeLedger implements StartupLedger {
  statuses = new Map<string, ChallengerRow['status']>()
  challenger(id: string): ChallengerRow | undefined {
    const status = this.statuses.get(id)
    return status ? ({ id, status } as ChallengerRow) : undefined
  }
}

/** The service slice: the rounds it lists, and the one transition reconciliation asks for. */
class FakeLifecycle implements StartupLifecycle {
  aborted: string[] = []
  constructor(private readonly rounds: RoundRow[], private readonly ledger: FakeLedger) {}
  status() { return { rounds: this.rounds } as ReturnType<StartupLifecycle['status']> }
  async abortRound(id: string) {
    this.aborted.push(id)
    const r = this.rounds.find((x) => x.id === id)!
    const aborted = r.sibling_ids.filter((s) => this.ledger.statuses.get(s) === 'running')
    for (const s of aborted) this.ledger.statuses.set(s, 'judged')
    r.status = 'decided'
    return { roundId: id, aborted }
  }
}

describe('staleRounds', () => {
  it('lists the open rounds with a running sibling, the running siblings only, and leaves the rest out', () => {
    const ledger = new FakeLedger()
    ledger.statuses.set('c-run', 'running')
    ledger.statuses.set('c-judged', 'judged')
    ledger.statuses.set('c-open', 'opened')
    ledger.statuses.set('c-other', 'running')
    const rounds = [
      round({ id: 'r-stale', sibling_ids: ['c-run', 'c-judged'] }),
      round({ id: 'r-idle', sibling_ids: ['c-open'] }),
      round({ id: 'r-judged', status: 'judged', sibling_ids: ['c-other'] }),
    ]
    expect(staleRounds(new FakeLifecycle(rounds, ledger), ledger)).toEqual([{ round_id: 'r-stale', challenger_ids: ['c-run'] }])
    expect(staleRounds(new FakeLifecycle([], ledger), ledger)).toEqual([])
  })
})

describe('abortRound', () => {
  it('asks the service for the one transition and logs one line per aborted row; the ledger slice it holds cannot write', async () => {
    const ledger = new FakeLedger()
    ledger.statuses.set('c-run', 'running')
    const lifecycle = new FakeLifecycle([round({ id: 'r-stale', sibling_ids: ['c-run'] })], ledger)
    const lines: string[] = []
    await abortRound(lifecycle, { round_id: 'r-stale', challenger_ids: ['c-run'] }, (l) => lines.push(l))
    expect(lifecycle.aborted).toEqual(['r-stale'])
    expect(ledger.statuses.get('c-run')).toBe('judged')
    expect(lines).toEqual([
      `workbench-startup: challenger c-run was running in round r-stale; judged invalid (${ABORT_RULE})`,
      'workbench-startup: round r-stale closed aborted (1 running)',
    ])
    expect('setStatus' in ledger).toBe(false)
    expect('updateRound' in ledger).toBe(false)
  })

  it('through the real service: the running sibling is judged invalid by lifecycle, the round closes aborted, and the round is stale no more', async () => {
    const h = await openLifecycle()
    const opened = await h.lifecycle.openRound({ pack: PACK, champion: championProposal(), metric: 'm', nEffFloor: 1 })
    const { id } = await h.lifecycle.propose(challengerProposal(opened.champion_id, 'left running'), { roundId: opened.id })
    await h.ledger.setStatus(id, 'running', { tier_reached: 'holdin' })
    const stale = staleRounds(h.lifecycle, h.ledger)
    expect(stale).toEqual([{ round_id: opened.id, challenger_ids: [id] }])
    await abortRound(h.lifecycle, stale[0]!)
    expect(h.ledger.round(opened.id)).toMatchObject({ status: 'decided', outcome: { superseded: [], aborted: true } })
    expect(h.ledger.challenger(id)).toMatchObject({ status: 'judged', verdict: { value: 'invalid', by: 'lifecycle', rule: ABORT_RULE, round_id: opened.id } })
    expect(staleRounds(h.lifecycle, h.ledger)).toEqual([])
  })
})

describe('workbench-startup plugin', () => {
  it('writes nothing on apply: a stale round may be another host\'s live one, so it is logged with the command that closes it', async () => {
    const ledger = new FakeLedger()
    ledger.statuses.set('c1', 'running')
    const lifecycle = new FakeLifecycle([round({ id: 'r1', sibling_ids: ['c1'] })], ledger)
    const ctx = new Context()
    ctx.provide('ledger', ledger)
    ctx.provide('lifecycle', lifecycle)
    await ctx.plugin({ name: 'workbench-startup', inject: ['lifecycle', 'ledger'], apply })
    expect(lifecycle.aborted).toEqual([])
    expect(ledger.statuses.get('c1')).toBe('running')
    const line = staleLine({ round_id: 'r1', challenger_ids: ['c1'] })
    expect(line).toContain('round r1 is open with running sibling(s) c1')
    expect(line).toContain('/samsara reconcile r1')
  })
})
