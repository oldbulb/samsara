import { describe, expect, it } from 'vitest'
import { cpSync, appendFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { GATE_DEFAULT_NAME, GATE_DEFAULT_VERSION, type GatePolicyProvider } from '@oldbulb/samsara-gate'
import { catalogGate } from '@oldbulb/samsara-gate-catalog'
import { LifecycleError } from '@oldbulb/samsara-lifecycle'
import type { AttemptRow, ChallengerProposal, ScoreRow } from '@oldbulb/samsara-ledger'
import { sha256 } from '@oldbulb/samsara-ledger'
import { calibrate } from '../src/calibrate.ts'
import { challenge, challengerProposalOf, formatChallenge, scoredAttemptsOf, GATE_DEFAULT, GATE_FAST, GATE_PERMISSIVE, type ChallengeDeps, type ChallengeRequest } from '../src/challenge.ts'
import { consent, DEFAULT, MINI, MINI_SKILL, openHarness, type Harness } from './harness.ts'

const Z = sha256('')

function attempt(id: string, task: string, sample: number, over: Partial<AttemptRow> = {}): AttemptRow {
  return {
    id, challenger_id: 'c', task_id: task, sample, loop: 'null', tier: 'smoke', status: 'COMPLETED', stop_reason: 'completed',
    facts_sha: '', usage: { input_tokens: 3, output_tokens: 4 }, cost: {}, output: { source: 'file', valid: false }, artifacts: [], ...over,
  }
}

describe('scoredAttemptsOf', () => {
  const tasks = new Map([['t1', 'e1'], ['t2', 'e2']])
  const scores = (id: string): ScoreRow[] => id === 'none' ? [] : [
    { attempt_id: id, scorer_version: '1', truth_snapshot_id: 's', metric: 'm', value: id.startsWith('r2') ? 1 : 0, kind: 'reality', stratum: 'x' },
    { attempt_id: id, scorer_version: '1', truth_snapshot_id: 's', metric: 'other', value: 9, kind: 'mechanical' },
  ]
  it('keeps the latest (run ids sort by time) attempt per (task, sample), joins the primary metric, skips unknown tasks and unscored attempts', () => {
    const rows = scoredAttemptsOf([
      attempt('r1-t1-0', 't1', 0),
      attempt('r2-t1-0', 't1', 0, { cost: { usd: 0.5, tokens: 100 } }),
      attempt('r1-t2-0', 't2', 0),
      attempt('none', 't2', 1),
      attempt('x', 't9', 0),
    ], scores, tasks, 'm')
    expect(rows.map((r) => r.attemptId).sort()).toEqual(['r1-t2-0', 'r2-t1-0'])
    const t1 = rows.find((r) => r.taskId === 't1')!
    expect(t1).toMatchObject({ entityKey: 'e1', stratum: 'x', metric: 'm', value: 1, kind: 'reality', cost: { usd: 0.5, tokens: 100 }, valid: false })
    expect(rows.find((r) => r.taskId === 't2')!.cost).toEqual({ tokens: 7 })
  })
})

describe('challengerProposalOf', () => {
  const champion: ChallengerProposal = {
    parent_ids: [], patch_sha: Z, harness_sha: Z, env_sha: Z, skill_sha: Z, taskset_sha: Z,
    route: { loop: 'null', loop_adapter_version: 'null@0', model_id: 'm', model_pool_sha: Z, base_url_kind: 'direct' },
    optimizer_config_sha: Z, lineage: 'main', surface: 'skill', patch: { skill_ref: `skill:${Z}` }, intent: 'champion',
    prediction: { metric: '', direction: 'up' }, scorer_version: '1', task_version: 1, truth_snapshot_id: Z, report_rule_version: '0',
    runtime: { timeout_s: 1, step_cap: 1 }, tasksets: { smoke: Z, holdin: Z, holdout: Z }, budget: 0,
  }
  const req = {
    pack: 'p', loop: 'null', set: 'smoke' as const, repeat: 1, out: 'o', maxTurns: 1, maxMinutes: 1,
    surface: 'skill' as const, skillDir: MINI_SKILL, intent: 'i', metric: 'm', nEffFloor: 3, withChampion: false, gatePolicy: 'default' as const,
  }
  it('is the champion with the snapshot as patch, the champion as parent and the metric as prediction', () => {
    const p = challengerProposalOf(champion, 'parent', req)
    expect(p.parent_ids).toEqual(['parent'])
    expect(p.skill_sha).toMatch(/^[0-9a-f]{64}$/)
    expect(p.patch_sha).toBe(p.skill_sha)
    expect(p.skill_sha).not.toBe(Z)
    expect(p.patch).toEqual({ skill_ref: MINI_SKILL, before: `skill:${Z}` })
    expect(p.intent).toBe('i')
    expect(p.prediction).toEqual({ metric: 'm', direction: 'up' })
    expect(p.harness_sha).toBe(champion.harness_sha)
  })
})

describe('GATE_PERMISSIVE', () => {
  it('is labelled as a test policy and never the default name', () => {
    expect(`${GATE_PERMISSIVE.name}@${GATE_PERMISSIVE.version}`).toBe('gate-permissive@test')
  })
})

// ---------------------------------------------------------------- the chain

function chainReq(gatePolicy: string, over: Partial<ChallengeRequest> = {}): ChallengeRequest {
  return {
    pack: MINI, loop: 'fake', set: 'smoke', repeat: 1, out: mkdtempSync(resolve(tmpdir(), 'runner-challenge-')), maxTurns: 5, maxMinutes: 1,
    surface: 'skill', skillDir: MINI_SKILL, intent: 'i', metric: 'pass_rate', nEffFloor: 1, withChampion: false, gatePolicy, ...over,
  }
}

/** A second skill snapshot: the minipack's with one more line, so its sha differs. */
function otherSkill(): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'runner-skill-'))
  cpSync(MINI_SKILL, dir, { recursive: true })
  appendFileSync(resolve(dir, 'SKILL.md'), '\nBe brief.\n')
  return dir
}

const PERMISSIVE = `${GATE_PERMISSIVE.name}@${GATE_PERMISSIVE.version}`

/** The harness deps with `closeRound` observed: the rounds the command closed without a decision. */
function closing(h: Harness): { deps: ChallengeDeps; closed: string[] } {
  const closed: string[] = []
  const { lifecycle } = h
  const deps = h.deps({
    lifecycle: {
      openRound: (i) => lifecycle.openRound(i), propose: (p, o) => lifecycle.propose(p, o), open: (id) => lifecycle.open(id),
      run: (id, t, o) => lifecycle.run(id, t, o), judge: (id, t) => lifecycle.judge(id, t), decide: (id) => lifecycle.decide(id),
      closeRound: (id) => { closed.push(id); return lifecycle.closeRound(id) },
    },
  })
  return { deps, closed }
}

/** The noise floor a holdout judgement needs (S1): the champion rerun on the held-out set. */
function calibrateHoldout(h: Harness) {
  return calibrate({ pack: MINI, loop: 'fake', set: 'holdout', out: mkdtempSync(resolve(tmpdir(), 'runner-calibrate-')), maxTurns: 5, maxMinutes: 1, metric: 'pass_rate', reruns: 3 }, h.deps())
}

describe('challenge: the chain through ctx.lifecycle', () => {
  it('the mounted policy judges for real, the row names it, and the round sits on the ledger beside the rows', async () => {
    const h = await openHarness()
    const r = await challenge(chainReq('default'), h.deps())
    expect(r).toMatchObject({ promotionGate: DEFAULT, shadow: false, compare: { gate: DEFAULT, shadow: false, round_id: r.roundId, tier: 'smoke' } })
    expect(r.verdictExists).toBeUndefined()
    expect(h.ledger.challenger(r.challengerId)).toMatchObject({
      status: 'judged', tier_reached: 'smoke', pack: 'minipack', verdict: { by: DEFAULT, rule: 'validity', round_id: r.roundId }, opened: { at: expect.any(String) },
    })
    // the champion ran first (the ledger held nothing on the task), then the challenger; each under its own row
    expect(r.champion?.rows).toHaveLength(1)
    expect(r.challenger?.rows).toHaveLength(1)
    expect(h.ledger.attemptsOf(r.championId)).toHaveLength(1)
    expect(h.ledger.attemptsOf(r.challengerId)).toHaveLength(1)
    expect(h.ledger.compares.size).toBe(1)
    // the round: this champion, this sibling, the promotion gate pinned, decided by the hold
    expect(h.ledger.round(r.roundId)).toMatchObject({
      champion_id: r.championId, sibling_ids: [r.challengerId], k: 1, gate: { name: GATE_DEFAULT_NAME, version: GATE_DEFAULT_VERSION }, shadow_gates: [],
      status: 'decided', outcome: { superseded: [] },
    })
    expect(r.outcome).toEqual({ roundId: r.roundId, superseded: [] })
    expect(h.scopes.disposed).toEqual([r.challengerId])
    const text = formatChallenge(r)
    expect(text).toContain(`round      ${r.roundId}`)
    expect(text).toContain(`verdict    hold  rule validity  by ${DEFAULT}`)
    expect(text).toContain('decision   round decided')
    expect(text).not.toContain('shadow')
  })

  it('a mounted catalog rule that is not the promotion gate judges as a shadow beside the promotion verdict', async () => {
    const h = await openHarness({ gate: [catalogGate('keep-better')!, GATE_DEFAULT] })
    const r = await challenge(chainReq('keep-better'), h.deps())
    expect(r).toMatchObject({ promotionGate: DEFAULT, shadow: true, compare: { gate: 'keep-better@0.1.0', shadow: true, verdict: { by: 'keep-better@0.1.0' } } })
    const rows = h.ledger.comparesOf(r.challengerId)
    expect(rows.map((c) => [c.gate, c.shadow])).toEqual([['keep-better@0.1.0', true], [DEFAULT, false]])
    // the row's verdict is the promotion gate's; the shadow sets none
    expect(h.ledger.challenger(r.challengerId)).toMatchObject({ status: 'judged', tier_reached: 'smoke', verdict: { by: DEFAULT } })
    expect(h.ledger.round(r.roundId)).toMatchObject({ gate: { name: GATE_DEFAULT_NAME }, shadow_gates: [{ name: 'keep-better', version: '0.1.0' }] })
    expect(formatChallenge(r)).toContain(`(shadow: not the promotion gate ${DEFAULT} and no gate_change consent`)
  })

  it('a preset is a non-default gate too, and the host must have mounted it', async () => {
    const mounted = await openHarness({ gate: [GATE_FAST, GATE_DEFAULT] })
    const r = await challenge(chainReq('fast'), mounted.deps())
    expect(r).toMatchObject({ shadow: true, compare: { gate: 'gate-fast@0.1.0', shadow: true } })
    expect(mounted.ledger.challenger(r.challengerId)?.verdict?.by).toBe(DEFAULT)
    const bare = await openHarness()
    await expect(challenge(chainReq('fast'), bare.deps())).rejects.toThrow('gate policy gate-fast@0.1.0 is not mounted on ctx.gate')
    expect(bare.ledger.rounds.size).toBe(0)
  })

  it('with a gate_change consent naming the gate, the round pins it and it judges for real', async () => {
    const h = await openHarness({ gate: [catalogGate('keep-better')!, GATE_DEFAULT] })
    h.ledger.consents.push(consent('keep-better@0.1.0', 'gate_change'))
    const r = await challenge(chainReq('keep-better'), h.deps())
    expect(r).toMatchObject({ promotionGate: DEFAULT, shadow: false, compare: { gate: 'keep-better@0.1.0', shadow: false } })
    expect(h.ledger.compares.size).toBe(1)
    expect(h.ledger.challenger(r.challengerId)).toMatchObject({ status: 'judged', verdict: { by: 'keep-better@0.1.0' } })
    expect(h.ledger.round(r.roundId)).toMatchObject({ gate: { name: 'keep-better', version: '0.1.0' }, shadow_gates: [] })
    expect(formatChallenge(r)).not.toContain('shadow')
  })

  it('a mounted gate other than gate-default opens nothing until a gate_change consent names it; then it is the promotion gate', async () => {
    const h = await openHarness({ gate: [GATE_DEFAULT, { name: 'gate-fast', version: '0.1.0', judge: GATE_DEFAULT.judge }] })
    const refused = challenge(chainReq('default'), h.deps())
    await expect(refused).rejects.toThrow(`the mounted gate gate-fast@0.1.0 is not ${DEFAULT} and no gate_change consent names it`)
    await expect(refused).rejects.toBeInstanceOf(LifecycleError)
    // only the champion row landed: no challenger, no round, no attempt
    expect([...h.ledger.challengers.values()].every((c) => c.parent_ids.length === 0)).toBe(true)
    expect(h.ledger.rounds.size).toBe(0)
    expect(h.ledger.attempts.size).toBe(0)
    h.ledger.consents.push(consent('gate-fast@0.1.0', 'gate_change'))
    const r = await challenge(chainReq('fast'), h.deps())
    expect(r).toMatchObject({ promotionGate: 'gate-fast@0.1.0', shadow: false, compare: { gate: 'gate-fast@0.1.0', shadow: false } })
    expect(h.ledger.challenger(r.challengerId)).toMatchObject({ status: 'judged', verdict: { by: 'gate-fast@0.1.0' } })
    // `default` names the mounted policy, whichever it is
    const s = await challenge(chainReq('default'), h.deps())
    expect(s).toMatchObject({ promotionGate: 'gate-fast@0.1.0', shadow: false, compare: { gate: 'gate-fast@0.1.0' } })
  })

  it('a verdict that already exists for the coordinates leaves the row judged with that verdict', async () => {
    const h = await openHarness()
    const first = await challenge(chainReq('default'), h.deps())
    expect(h.ledger.challenger(first.challengerId)).toMatchObject({ status: 'judged', verdict: { by: DEFAULT, round_id: first.roundId } })
    const again = await challenge(chainReq('default'), h.deps())
    expect(again.challengerId).toBe(first.challengerId)
    expect(again.verdictExists).toBe(true)
    expect(h.ledger.compares.size).toBe(1)
    expect(h.ledger.challenger(again.challengerId)).toMatchObject({ status: 'judged', tier_reached: 'smoke', verdict: { by: DEFAULT, round_id: first.roundId } })
    expect(again.roundId).not.toBe(first.roundId)
    expect([...h.ledger.rounds.values()].map((r) => r.status)).toEqual(['decided', 'decided'])
    expect(formatChallenge(again)).toContain('a verdict already existed; not recorded')
  })

  it('a diff-scan rejection is a decided row and nothing runs; the round is closed, and a re-run renders the verdict', async () => {
    const h = await openHarness()
    const { deps, closed } = closing(h)
    h.scopes.reject = [{ code: 'OUTSIDE_SURFACE', where: 'x', detail: 'd' }]
    const r = await challenge(chainReq('default'), deps)
    expect(r.rejected).toEqual([{ code: 'OUTSIDE_SURFACE', where: 'x', detail: 'd' }])
    expect(h.ledger.challenger(r.challengerId)).toMatchObject({ status: 'decided', verdict: { value: 'invalid', by: 'diffscan', rule: 'OUTSIDE_SURFACE:x', round_id: r.roundId } })
    expect(h.ledger.attempts.size).toBe(0)
    expect(formatChallenge(r)).toContain('PATCH_REJECTED before any attempt')
    // the round does not stay open on the ledger: closed without a decision
    expect(closed).toEqual([r.roundId])
    expect(r.outcome).toEqual({ roundId: r.roundId, superseded: [] })
    expect(h.ledger.round(r.roundId)).toMatchObject({ status: 'decided', closed_at: expect.any(String), outcome: { superseded: [] } })
    expect(formatChallenge(r)).toContain('decision   round decided')
    // the same challenger again: the decided row is rendered, nothing scans or runs, its round is closed too
    const logs: string[] = []
    const again = await challenge(chainReq('default'), { ...deps, log: (l) => logs.push(l) })
    expect(again.challengerId).toBe(r.challengerId)
    expect(again.rejected).toBeUndefined()
    expect(again.decided).toEqual({ value: 'invalid', by: 'diffscan', rule: 'OUTSIDE_SURFACE:x', round_id: r.roundId })
    expect(again.compare).toBeUndefined()
    expect(h.ledger.attempts.size).toBe(0)
    expect(closed).toEqual([r.roundId, again.roundId])
    expect([...h.ledger.rounds.values()].map((x) => x.status)).toEqual(['decided', 'decided'])
    expect(logs).toContain(`challenger ${r.challengerId} is already decided (invalid by diffscan, rule OUTSIDE_SURFACE:x); nothing runs, round ${again.roundId} closes`)
    expect(formatChallenge(again)).toContain('verdict    invalid  rule OUTSIDE_SURFACE:x  by diffscan  (decided before this command; nothing ran)')
  })

  it('a challenger the gate dropped is decided; a re-run renders that verdict with its compare row, runs nothing and closes its round', async () => {
    const drop: GatePolicyProvider = { ...GATE_DEFAULT, judge: async (r) => ({ ...(await GATE_DEFAULT.judge(r)), verdict: 'drop' }) }
    const h = await openHarness({ gate: [drop] })
    const { deps, closed } = closing(h)
    const first = await challenge(chainReq('default'), deps)
    expect(first.compare?.verdict.value).toBe('drop')
    expect(h.ledger.challenger(first.challengerId)?.status).toBe('decided')
    expect(closed).toEqual([])
    const attempts = h.ledger.attempts.size
    const again = await challenge(chainReq('default'), deps)
    expect(again.challengerId).toBe(first.challengerId)
    expect(again.decided).toMatchObject({ value: 'drop', by: DEFAULT, round_id: first.roundId })
    expect(again.compare).toEqual(first.compare)
    expect(again.verdictExists).toBeUndefined()
    expect(h.ledger.attempts.size).toBe(attempts)
    expect(h.ledger.compares.size).toBe(1)
    expect(closed).toEqual([again.roundId])
    expect(again.outcome).toEqual({ roundId: again.roundId, superseded: [] })
    expect([...h.ledger.rounds.values()].map((x) => x.status)).toEqual(['decided', 'decided'])
    expect(formatChallenge(again)).toContain(`verdict    drop  rule validity  by ${DEFAULT}  (decided before this command; nothing ran)`)
    expect(formatChallenge(again)).toContain('compare    mean')
  })

  it('a run invariant failure (coordinates:facts) is judged invalid and its round is closed', async () => {
    const h = await openHarness()
    const { deps, closed } = closing(h)
    const first = await challenge(chainReq('default'), deps)
    // the champion's recorded attempts no longer carry the facts the loop reports now
    for (const a of h.ledger.attemptsOf(first.championId)) h.ledger.attempts.set(a.id, { ...a, facts_sha: 'stale' })
    const r = await challenge(chainReq('default', { skillDir: otherSkill() }), deps)
    expect(r.invalid).toBe('coordinates:facts')
    expect(r.compare).toBeUndefined()
    expect(h.ledger.challenger(r.challengerId)).toMatchObject({ verdict: { value: 'invalid', rule: 'coordinates:facts', round_id: r.roundId } })
    expect(closed).toEqual([r.roundId])
    expect(r.outcome).toEqual({ roundId: r.roundId, superseded: [] })
    expect(h.ledger.round(r.roundId)).toMatchObject({ status: 'decided', closed_at: expect.any(String) })
    expect(formatChallenge(r)).toContain('decision   round decided')
  })

  it('a promote verdict below holdout ranks no candidate: the round is decided without one', async () => {
    const h = await openHarness({ gate: [GATE_DEFAULT, GATE_PERMISSIVE] })
    h.ledger.consents.push(consent(PERMISSIVE, 'gate_change'))
    const r = await challenge(chainReq('default'), h.deps())
    expect(r.compare).toMatchObject({ tier: 'smoke', verdict: { value: 'promote' } })
    expect(h.ledger.challenger(r.challengerId)).toMatchObject({ status: 'judged', tier_reached: 'smoke', verdict: { value: 'promote', round_id: r.roundId } })
    expect(r.outcome).toEqual({ roundId: r.roundId, superseded: [] })
    expect(h.ledger.round(r.roundId)).toMatchObject({ status: 'decided', outcome: { superseded: [] } })
    expect(formatChallenge(r)).toContain('decision   round decided')
  })

  it('a holdout promote verdict leaves the round open for its consent, --round refuses a sibling after that judgement, and an unknown round refuses', async () => {
    const h = await openHarness({ gate: [GATE_DEFAULT, GATE_PERMISSIVE] })
    h.ledger.consents.push(consent(PERMISSIVE, 'gate_change'))
    await calibrateHoldout(h)
    const a = await challenge(chainReq('default', { set: 'holdout' }), h.deps())
    expect(a.compare).toMatchObject({ tier: 'holdout', round_id: a.roundId, verdict: { value: 'promote' } })
    expect(a.outcome).toEqual({ pending: 'consent', roundId: a.roundId, candidate: a.challengerId })
    expect(h.ledger.round(a.roundId)?.status).toBe('open')
    expect(formatChallenge(a)).toContain(`decision   pending: promote consent for ${a.challengerId}`)

    // Holm's k froze at a's judgement (S4): no sibling joins; the round stays open for its candidate
    const b = challenge(chainReq('default', { set: 'holdout', skillDir: otherSkill(), round: a.roundId }), h.deps())
    await expect(b).rejects.toThrow(`round ${a.roundId} already judged a sibling at Holm's k = 1; a new sibling needs a new round`)
    await expect(b).rejects.toBeInstanceOf(LifecycleError)
    expect(h.ledger.round(a.roundId)).toMatchObject({ sibling_ids: [a.challengerId], k: 1, status: 'open' })
    expect(h.ledger.attemptsOf(a.challengerId)).toHaveLength(1)

    await expect(challenge(chainReq('default', { round: 'nope' }), h.deps())).rejects.toThrow('no round nope on the ledger')
  })

  it('with nothing mounted on ctx.gate, nothing opens', async () => {
    const h = await openHarness({ gate: [] })
    await expect(challenge(chainReq('default'), h.deps())).rejects.toThrow('no gate policy is mounted on ctx.gate')
  })
})
