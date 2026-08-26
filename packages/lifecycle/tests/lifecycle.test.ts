import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HoldoutNotDisjoint } from '@oldbulb/samsara-book'
import { stateOf, stateSha, EMPTY_STATE } from '@oldbulb/samsara-champion'
import { sd, type CompareRequest } from '@oldbulb/samsara-gate'
import { loadPack, protectedPaths } from '@oldbulb/samsara-pack'
import { ScopeError, type Violation } from '@oldbulb/samsara-scope'
import { gateRefOf, roundPolicy, sameRoute, scoredAttemptsOf, ABORT_RULE, ISOLATED_SERVICES, LifecycleError, type LifecycleEvent } from '../src/index.ts'
import { challengerProposal, championProposal, consent, openLifecycle, runOptions, DEFAULT, GATE_DEFAULT, GATE_PICK, PACK, sha, type Harness } from './fakes.ts'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function out(): string {
  const d = mkdtempSync(join(tmpdir(), 'samsara-lifecycle-'))
  dirs.push(d)
  return d
}

async function openRound(h: Harness, over: Partial<Parameters<Harness['lifecycle']['openRound']>[0]> = {}) {
  return h.lifecycle.openRound({ pack: PACK, champion: championProposal(), metric: 'm', nEffFloor: 1, ...over })
}

/** propose + open + run(tier) for one challenger scoring `value` on every task. */
async function runOne(h: Harness, roundId: string, intent: string, value: number, tier: 'smoke' | 'holdin' | 'holdout' = 'holdin') {
  const round = h.ledger.round(roundId)!
  const { id } = await h.lifecycle.propose(challengerProposal(round.champion_id, intent), { roundId })
  h.executor.values.set(id, value)
  await h.lifecycle.open(id)
  await h.lifecycle.run(id, tier, runOptions(out()))
  return id
}

async function calibrate(h: Harness, reruns = 3) {
  return h.lifecycle.calibrate({ pack: PACK, champion: championProposal(), metric: 'm', set: 'holdout', reruns, run: runOptions(out()) })
}

const code = (c: LifecycleError['code']) => expect.objectContaining({ name: 'LifecycleError', code: c })

/** The paired request a re-score of `id` against its parent would be judged on, from the ledger's rows. */
function compareRequestOf(h: Harness, id: string, tier: 'holdin' | 'holdout'): CompareRequest {
  const row = h.ledger.challenger(id)!
  const scores = (attemptId: string) => h.ledger.scoresOf(attemptId)
  const entityOf = new Map<string, string>()
  return {
    challenger: scoredAttemptsOf(h.ledger.attemptsOf(id), scores, entityOf, 'm'),
    champion: scoredAttemptsOf(h.ledger.attemptsOf(row.parent_ids[0]!), scores, entityOf, 'm'),
    tier, primaryMetric: 'm', noiseFloor: { sdPaired: 0, nReruns: 0 }, policy: roundPolicy(1, 0.1), round: { k: 1, index: 0 }, seed: 0,
  }
}

// ---------------------------------------------------------------- rounds

describe('openRound', () => {
  it('pins the promotion gate with its policy sha, proposes the champion under the round metric, and dedupes by coordinates', async () => {
    const h = await openLifecycle()
    const round = await openRound(h, { openedAt: '2026-08-26T00:00:00.000Z' })
    expect(round).toMatchObject({ status: 'open', k: 0, sibling_ids: [], shadow_gates: [], gate: gateRefOf(GATE_DEFAULT, roundPolicy(1, 0.1)) })
    expect(round.noise_floor_id).toBeUndefined()
    const champion = h.ledger.challenger(round.champion_id)!
    expect(champion).toMatchObject({ pack: 'fixture', prediction: { metric: 'm', direction: 'up' }, eval_config_sha: round.eval_config_sha })
    expect(await openRound(h, { openedAt: '2026-08-26T00:00:00.000Z' })).toEqual(round)
    expect((await openRound(h, { openedAt: '2026-08-26T00:00:01.000Z' })).id).not.toBe(round.id)
  })

  it('refuses a mounted gate other than gate-default without a gate_change consent, and a pinned gate on the same terms', async () => {
    const h = await openLifecycle({ gate: [GATE_PICK] })
    await expect(openRound(h)).rejects.toEqual(code('GATE_NOT_CONSENTED'))
    h.ledger.consents.push(consent('gate-pick@test', 'gate_change'))
    expect((await openRound(h)).gate).toMatchObject({ name: 'gate-pick', version: 'test' })

    const g = await openLifecycle({ gate: [GATE_PICK, GATE_DEFAULT] })
    await expect(openRound(g, { gate: 'gate-pick@test' })).rejects.toEqual(code('GATE_NOT_CONSENTED'))
    await expect(openRound(g, { gate: 'nope@1' })).rejects.toEqual(code('GATE_MISMATCH'))
    g.ledger.consents.push(consent('gate-pick@test', 'gate_change'))
    expect((await openRound(g, { gate: 'gate-pick@test', shadowGates: [DEFAULT] })).shadow_gates).toEqual([gateRefOf(GATE_DEFAULT, roundPolicy(1, 0.1))])
    await expect(openRound(g, { shadowGates: ['nope@1'] })).rejects.toEqual(code('GATE_MISMATCH'))
  })

  it('pins the latest noise floor for the champion, loop and metric', async () => {
    const h = await openLifecycle()
    const floor = await calibrate(h)
    expect((await openRound(h)).noise_floor_id).toBe(floor.id)
    // The metric is the round's, not the row's configuration: another metric anchors on the same champion row, with no floor of its own yet.
    const other = await openRound(h, { metric: 'other', openedAt: '2026-08-26T01:00:00.000Z' })
    expect(other.champion_id).toBe(floor.champion_id)
    expect(other.noise_floor_id).toBeUndefined()
  })

  it('refuses the operator on the route the proposer declares (OPERATOR_IS_PROPOSER) before anything is written; an unknown or other route opens', async () => {
    const h = await openLifecycle()
    const operator = { session_id: 'op-1', provider: 'p', model: 'operator-model' }
    await expect(openRound(h, { operator, proposerRoute: { model: 'operator-model' } })).rejects.toEqual(code('OPERATOR_IS_PROPOSER'))
    await expect(openRound(h, { operator, proposerRoute: { provider: 'P', model: ' Operator-Model ' } })).rejects.toEqual(code('OPERATOR_IS_PROPOSER'))
    expect(h.ledger.rounds.size).toBe(0)
    expect(h.ledger.challengers.size).toBe(0)
    // another model, the same model under another provider, a route the host cannot compare, or no operator (the CLI profile): the round opens
    expect((await openRound(h, { operator, proposerRoute: { model: 'other-model' }, openedAt: '2026-08-26T00:00:00.000Z' })).operator).toEqual(operator)
    expect((await openRound(h, { operator, proposerRoute: { provider: 'q', model: 'operator-model' }, openedAt: '2026-08-26T00:00:01.000Z' })).status).toBe('open')
    expect((await openRound(h, { operator, proposerRoute: 'unknown', openedAt: '2026-08-26T00:00:02.000Z' })).status).toBe('open')
    expect((await openRound(h, { proposerRoute: { model: 'operator-model' }, openedAt: '2026-08-26T00:00:03.000Z' })).operator).toBeUndefined()
    expect((await openRound(h, { operator: { session_id: 'op-1' }, proposerRoute: { model: 'operator-model' }, openedAt: '2026-08-26T00:00:04.000Z' })).status).toBe('open')
  })

  it('sameRoute compares normalized (provider, model) pairs: both must name a model, the provider counts only when both name one', () => {
    expect(sameRoute({ provider: 'p', model: 'm' }, { model: 'm' })).toBe(true)
    expect(sameRoute({ provider: 'p', model: ' M ' }, { model: 'm', provider: 'P' })).toBe(true)
    expect(sameRoute({ provider: 'p', model: 'm' }, { model: 'm', provider: 'q' })).toBe(false)
    expect(sameRoute({ provider: 'p', model: 'm' }, { model: 'n' })).toBe(false)
    expect(sameRoute({}, { model: 'm' })).toBe(false)
    expect(sameRoute({ provider: 'p', model: 'm' }, { provider: 'p' })).toBe(false)
  })

  it('S2/S7: a pack whose held-out set shares an entity with a visible set is refused before anything opens', async () => {
    const h = await openLifecycle()
    const pack = out()
    cpSync(PACK, pack, { recursive: true })
    writeFileSync(join(pack, 'tasks', 'holdout.jsonl'), '{"task_id":"o1","entity_key":"e1"}\n{"task_id":"o2","entity_key":"e8"}\n')
    await expect(openRound(h, { pack })).rejects.toBeInstanceOf(HoldoutNotDisjoint)
    expect(h.ledger.rounds.size).toBe(0)
  })

  it('a champion row recorded under another evaluation configuration cannot anchor the round', async () => {
    const h = await openLifecycle()
    await h.ledger.propose({ ...championProposal(), pack: 'other' })
    await expect(openRound(h)).rejects.toEqual(code('NOT_COMPARABLE'))
  })
})

describe('experiments', () => {
  const gate = gateRefOf(GATE_DEFAULT, roundPolicy(1, 0.1))
  const input = { hypothesis: 'h', prediction: { metric: 'm', direction: 'up' as const }, pack: 'fixture', gate, budget: { rounds: 1, attempts: 100 }, created_by: { channel: 'test' } }

  it('preregister is a ledger row; a round links to it, spends a round, and the budget binds', async () => {
    const h = await openLifecycle()
    const exp = await h.lifecycle.preregister(input)
    expect(exp).toMatchObject({ status: 'active', spent: { usd: 0, attempts: 0, rounds: 0, holdout_reveals: 0 }, round_ids: [] })
    const round = await openRound(h, { experimentId: exp.id })
    expect(round.experiment_id).toBe(exp.id)
    expect(h.ledger.experiment(exp.id)).toMatchObject({ round_ids: [round.id], spent: { rounds: 1 } })
    await expect(openRound(h, { experimentId: exp.id, openedAt: '2027-01-01T00:00:00.000Z' })).rejects.toEqual(code('BUDGET_EXCEEDED'))
    expect(await openRound(h, { experimentId: exp.id, openedAt: round.opened_at })).toEqual(round)
    await expect(openRound(h, { experimentId: 'nope' })).rejects.toEqual(code('UNKNOWN'))
  })

  it('refuses a round under a gate other than the one pre-registered, and records what a run spent', async () => {
    const h = await openLifecycle()
    const exp = await h.lifecycle.preregister({ ...input, gate: { ...gate, policy_sha: sha('other') } })
    await expect(openRound(h, { experimentId: exp.id })).rejects.toEqual(code('GATE_MISMATCH'))
    const exp2 = await h.lifecycle.preregister({ ...input, budget: { attempts: 4 } })
    const round = await openRound(h, { experimentId: exp2.id })
    const id = await runOne(h, round.id, 'a', 0.9, 'smoke')
    expect(h.ledger.experiment(exp2.id)?.spent).toEqual({ usd: 0.04, attempts: 4, rounds: 1, holdout_reveals: 0 })
    await expect(h.lifecycle.run(id, 'holdin', runOptions(out()))).rejects.toEqual(code('BUDGET_EXCEEDED'))
  })

  it('setExperimentBudget is the one budget writer: the change lands with who set it, never below what was spent, never on a closed row', async () => {
    const h = await openLifecycle()
    const exp = await h.lifecycle.preregister({ ...input, budget: { attempts: 4 } })
    const round = await openRound(h, { experimentId: exp.id })
    await runOne(h, round.id, 'a', 0.9, 'smoke')
    const raised = await h.lifecycle.setExperimentBudget(exp.id, { attempts: 8, usd: 1 }, { session_id: 's1', command_id: 'c1' })
    expect(raised.budget).toEqual({ attempts: 8, usd: 1 })
    expect(raised.budget_changes).toEqual([{ at: expect.any(String), session_id: 's1', command_id: 'c1', budget: { attempts: 8, usd: 1 } }])
    expect(h.ledger.experiment(exp.id)).toEqual(raised)
    const again = await h.lifecycle.setExperimentBudget(exp.id, { attempts: 8, usd: 2 })
    expect(again.budget_changes).toHaveLength(2)
    // 4 attempts are spent: a budget of 3 would be below them.
    await expect(h.lifecycle.setExperimentBudget(exp.id, { attempts: 3 })).rejects.toEqual(code('BUDGET_EXCEEDED'))
    expect(h.ledger.experiment(exp.id)!.budget).toEqual({ attempts: 8, usd: 2 })
    await h.ledger.updateExperiment(exp.id, { status: 'closed' })
    await expect(h.lifecycle.setExperimentBudget(exp.id, { attempts: 9 })).rejects.toEqual(code('ROUND_CLOSED'))
    await expect(h.lifecycle.setExperimentBudget('nope', { attempts: 9 })).rejects.toEqual(code('UNKNOWN'))
  })
})

// ----------------------------------------------------------- transitions

describe('propose', () => {
  it('lands the row, joins the round (k follows), and is idempotent', async () => {
    const h = await openLifecycle()
    const round = await openRound(h)
    const proposal = challengerProposal(round.champion_id, 'a')
    const first = await h.lifecycle.propose(proposal, { roundId: round.id })
    expect(first.created).toBe(true)
    expect(h.ledger.round(round.id)).toMatchObject({ sibling_ids: [first.id], k: 1 })
    expect(h.ledger.challenger(first.id)).toMatchObject({ status: 'proposed', pack: 'fixture', eval_config_sha: round.eval_config_sha })
    expect(await h.lifecycle.propose(proposal, { roundId: round.id })).toEqual({ id: first.id, created: false })
    expect(h.ledger.round(round.id)?.k).toBe(1)
    // The pack defaults to the champion's.
    const { pack: _p, ...withoutPack } = challengerProposal(round.champion_id, 'b')
    const second = await h.lifecycle.propose(withoutPack, { roundId: round.id })
    expect(h.ledger.challenger(second.id)?.pack).toBe('fixture')
  })

  it('rule 0: a coordinate that must be equal throws NOT_COMPARABLE naming it, and nothing lands', async () => {
    const h = await openLifecycle()
    const round = await openRound(h)
    const bad = challengerProposal(round.champion_id, 'a', { route: { ...championProposal().route, model_id: 'other' } })
    await expect(h.lifecycle.propose(bad, { roundId: round.id })).rejects.toEqual(expect.objectContaining({ code: 'NOT_COMPARABLE', message: expect.stringContaining('NOT_COMPARABLE:route'), detail: { coordinate: 'route' } }))
    await expect(h.lifecycle.propose(challengerProposal(round.champion_id, 'a', { scorer_version: '9' }), { roundId: round.id })).rejects.toEqual(code('NOT_COMPARABLE'))
    expect(h.ledger.challengers.size).toBe(1)
    expect(h.ledger.round(round.id)?.k).toBe(0)
  })

  it('needs the round open and the round champion as parent', async () => {
    const h = await openLifecycle()
    const round = await openRound(h)
    await expect(h.lifecycle.propose(challengerProposal(sha('other'), 'a'), { roundId: round.id })).rejects.toEqual(code('NOT_IN_ROUND'))
    await expect(h.lifecycle.propose(challengerProposal(round.champion_id, 'a'), { roundId: 'nope' })).rejects.toEqual(code('UNKNOWN'))
    await h.lifecycle.closeRound(round.id)
    expect(h.ledger.round(round.id)).toMatchObject({ status: 'decided', outcome: { superseded: [] } })
    await expect(h.lifecycle.propose(challengerProposal(round.champion_id, 'a'), { roundId: round.id })).rejects.toEqual(code('ROUND_CLOSED'))
  })

  it("Holm's k freezes at the first judgement: no sibling joins after it, re-proposing a sibling still does", async () => {
    const h = await openLifecycle()
    const round = await openRound(h)
    const a = await runOne(h, round.id, 'a', 0.9)
    const b = await runOne(h, round.id, 'b', 0.9)
    await h.lifecycle.judge(a, 'holdin')
    expect(h.ledger.comparesOf(a)[0]?.holm).toMatchObject({ m: 2 })
    await expect(h.lifecycle.propose(challengerProposal(round.champion_id, 'c'), { roundId: round.id })).rejects.toEqual(code('ROUND_CLOSED'))
    expect(h.ledger.round(round.id)).toMatchObject({ k: 2, sibling_ids: [a, b] })
    expect(await h.lifecycle.propose(challengerProposal(round.champion_id, 'b'), { roundId: round.id })).toEqual({ id: b, created: false })
    await h.lifecycle.judge(b, 'holdin')
    expect(h.ledger.comparesOf(b)[0]?.holm).toMatchObject({ m: 2 })
  })

  it('a row belongs to one open round at a time; a decided round lets it go', async () => {
    const h = await openLifecycle()
    const first = await openRound(h, { openedAt: '2026-08-26T00:00:00.000Z' })
    const second = await openRound(h, { openedAt: '2026-08-26T01:00:00.000Z' })
    const { id } = await h.lifecycle.propose(challengerProposal(first.champion_id, 'a'), { roundId: first.id })
    await expect(h.lifecycle.propose(challengerProposal(first.champion_id, 'a'), { roundId: second.id })).rejects.toEqual(code('BAD_TRANSITION'))
    expect(h.ledger.round(second.id)?.sibling_ids).toEqual([])
    await h.lifecycle.closeRound(first.id)
    expect(await h.lifecycle.propose(challengerProposal(first.champion_id, 'a'), { roundId: second.id })).toEqual({ id, created: false })
    // The row's round is the open one that lists it, not the latest.
    await h.lifecycle.open(id)
    expect(h.lifecycle.nextActions(id)).toEqual([{ kind: 'run', tier: 'smoke' }])
  })
})

describe('open', () => {
  it('opens the scope on the skill patch, writes the evidence and the status, and is idempotent while the scope is open', async () => {
    const h = await openLifecycle()
    const round = await openRound(h)
    const { id } = await h.lifecycle.propose(challengerProposal(round.champion_id, 'a'), { roundId: round.id })
    const scope = await h.lifecycle.open(id)
    expect(h.scopes.opened[0]).toMatchObject({ id, patch: { surface: 'skill', skill_dir: '/skills/a', mount: 'skill' }, boundaries: { skill: { globs: ['skill/**'], config_keys: [] } } })
    // S5: every task id, every entity key and the task set file names reach the diff scan.
    const def = loadPack(PACK)
    const sets = ['smoke', 'holdin', 'holdout'] as const
    expect(h.scopes.opened[0]?.taskIds).toEqual(sets.flatMap((set) => def.taskSets[set].tasks.map((t) => t.task_id)))
    expect(h.scopes.opened[0]?.literals).toEqual([...new Set(sets.flatMap((set) => def.taskSets[set].tasks.map((t) => t.entity_key))), 'smoke.jsonl', 'holdin.jsonl', 'holdout.jsonl'])
    expect(h.scopes.opened[0]?.taskIds).toEqual(['s1', 's2', 'h1', 'h2', 'h3', 'h4', 'o1', 'o2', 'o3', 'o4'])
    // What the pack declares is what the scan forbids; the fixed points and their writers are isolated from the scope's tree.
    expect(h.scopes.opened[0]?.forbiddenPaths).toEqual(protectedPaths(loadPack(PACK)))
    expect(h.scopes.opened[0]?.forbiddenPaths).toContain('pack.yaml')
    expect(h.scopes.opened[0]?.isolate).toEqual({ ledger: true, gate: true, signoff: true, champion: true, lifecycle: true })
    expect(Object.keys(h.scopes.opened[0]?.isolate ?? {})).toEqual([...ISOLATED_SERVICES])
    expect(h.ledger.challenger(id)).toMatchObject({ status: 'opened', opened: { harness_sha: sha('harness'), env_sha: sha('env'), profile_sha: stateSha(EMPTY_STATE) } })
    expect(await h.lifecycle.open(id)).toBe(scope)
    expect(h.scopes.opened).toHaveLength(1)
  })

  it('a rejected patch is a decided row (invalid by diffscan) and the error carries the violations', async () => {
    const h = await openLifecycle()
    const round = await openRound(h)
    const { id } = await h.lifecycle.propose(challengerProposal(round.champion_id, 'a'), { roundId: round.id })
    const violations: Violation[] = [{ code: 'FORBIDDEN_PATH', where: 'x', detail: 'd' }]
    h.scopes.reject = violations
    await expect(h.lifecycle.open(id)).rejects.toSatisfy((e) => e instanceof ScopeError && e.code === 'PATCH_REJECTED' && e.violations === violations)
    expect(h.ledger.challenger(id)).toMatchObject({ status: 'decided', verdict: { value: 'invalid', by: 'diffscan', rule: 'FORBIDDEN_PATH:x', round_id: round.id } })
    h.scopes.reject = undefined
    await expect(h.lifecycle.open(id)).rejects.toEqual(code('BAD_TRANSITION'))
  })

  it('E1: a profile that changed while the scope opened is refused and the scope disposed', async () => {
    const h = await openLifecycle()
    const round = await openRound(h)
    const { id } = await h.lifecycle.propose(challengerProposal(round.champion_id, 'a'), { roundId: round.id })
    h.scopes.onOpen = () => { h.champion.state = stateOf([{ challenger_id: sha('x'), surface: 'skill', ref: 'skill:x', rows: [], consent_id: 'c', promoted_at: 'now' }]) }
    await expect(h.lifecycle.open(id)).rejects.toEqual(code('PROFILE_CHANGED'))
    expect(h.scopes.disposed).toEqual([id])
    expect(h.ledger.challenger(id)?.status).toBe('proposed')
  })

  it('E4 (v1): a challenger on a surface other than skill is refused at open — a scope carries no runtime', async () => {
    const h = await openLifecycle()
    const champion = championProposal({ surface: 'prompt', patch: { cordis: [] } })
    const round = await openRound(h, { champion })
    const { id } = await h.lifecycle.propose(challengerProposal(round.champion_id, 'p', { surface: 'prompt', skill_sha: sha('s'), patch: { cordis: [{ id: 'r1', config: { x: 1 } }] } }), { roundId: round.id })
    await expect(h.lifecycle.open(id)).rejects.toEqual(code('BAD_TRANSITION'))
    expect(h.scopes.opened).toEqual([])
    expect(h.ledger.challenger(id)?.status).toBe('proposed')
  })

  it('refuses a row in no round', async () => {
    const h = await openLifecycle()
    const round = await openRound(h)
    const id = await h.ledger.propose(challengerProposal(round.champion_id, 'a'))
    await expect(h.lifecycle.open(id)).rejects.toEqual(code('NOT_IN_ROUND'))
    await expect(h.lifecycle.open('nope')).rejects.toEqual(code('UNKNOWN'))
  })
})

describe('run', () => {
  it('ensures the champion attempts, runs the challenger in its scope, and moves the row to running with the tier', async () => {
    const h = await openLifecycle()
    const round = await openRound(h)
    const { id } = await h.lifecycle.propose(challengerProposal(round.champion_id, 'a'), { roundId: round.id })
    await expect(h.lifecycle.run(id, 'smoke', runOptions(out()))).rejects.toEqual(code('BAD_TRANSITION'))
    await h.lifecycle.open(id)
    const dir = out()
    const summary = await h.lifecycle.run(id, 'smoke', runOptions(dir, { runId: 'r1', championSkillDir: '/kept' }))
    expect(summary).toMatchObject({ challengerId: id, championId: round.champion_id, tier: 'smoke' })
    expect(summary.invalid).toBeUndefined()
    expect(summary.champion?.rows).toHaveLength(2)
    expect(h.executor.calls.map((c) => [c.challengerId, c.runId, c.req.set, c.req.skillDir, c.req.out])).toEqual([
      [round.champion_id, `r1-champion-${round.champion_id.slice(0, 12)}`, 'smoke', undefined, join(dir, 'champion')],
      [id, `r1-challenger-${id.slice(0, 12)}`, 'smoke', '/skills/a', join(dir, 'challenger')],
    ])
    expect(h.ledger.challenger(id)).toMatchObject({ status: 'running', tier_reached: 'smoke' })
    // The champion's smoke attempts are reused; a new tier runs it again.
    await h.lifecycle.run(id, 'smoke', runOptions(out()))
    expect(h.executor.calls).toHaveLength(3)
    await h.lifecycle.run(id, 'holdin', runOptions(out()))
    expect(h.executor.calls).toHaveLength(5)
    await h.lifecycle.run(id, 'holdin', runOptions(out(), { withChampion: true }))
    expect(h.executor.calls).toHaveLength(7)
    await expect(h.lifecycle.run(id, 'live', runOptions(out()))).rejects.toEqual(code('BAD_TRANSITION'))
  })

  it('two runs in the same second keep their own attempts: the run id is unique per call and names the row', async () => {
    const h = await openLifecycle()
    const round = await openRound(h)
    vi.useFakeTimers({ now: new Date('2026-08-26T12:00:00.000Z'), toFake: ['Date'] })
    try {
      const a = await runOne(h, round.id, 'a', 0.9)
      const b = await runOne(h, round.id, 'b', 0.7)
      const runIds = h.executor.calls.map((c) => c.runId!)
      const prefix = (runId: string) => runId.replace(/-(champion|challenger)-[0-9a-f]{12}$/, '')
      // One run id per call, shared by the champion and the challenger of that call; the clock alone tells no two calls apart.
      expect(runIds.map(prefix)).toEqual([prefix(runIds[0]!), prefix(runIds[0]!), expect.not.stringMatching(prefix(runIds[0]!))])
      for (const runId of runIds) expect(prefix(runId)).toMatch(/^run-20260826T120000\.000Z-\d+$/)
      expect(runIds).toEqual([
        `${prefix(runIds[0]!)}-champion-${round.champion_id.slice(0, 12)}`, `${prefix(runIds[0]!)}-challenger-${a.slice(0, 12)}`, `${prefix(runIds[2]!)}-challenger-${b.slice(0, 12)}`,
      ])
      expect(h.ledger.attemptsOf(a)).toHaveLength(4)
      expect(h.ledger.attemptsOf(b)).toHaveLength(4)
      expect((await h.lifecycle.judge(a, 'holdin')).verdict.value).not.toBe('invalid')
    } finally {
      vi.useRealTimers()
    }
  })

  it('the run invariant: attempts under another harness make the row invalid on coordinates:facts, with no statistics', async () => {
    const h = await openLifecycle()
    const round = await openRound(h)
    const { id } = await h.lifecycle.propose(challengerProposal(round.champion_id, 'a'), { roundId: round.id })
    await h.lifecycle.open(id)
    h.executor.facts = (c) => (c === id ? sha('other') : sha('facts'))
    const summary = await h.lifecycle.run(id, 'holdin', runOptions(out()))
    expect(summary.invalid).toBe('coordinates:facts')
    expect(h.ledger.challenger(id)).toMatchObject({ status: 'judged', tier_reached: 'holdin', verdict: { value: 'invalid', by: 'lifecycle', rule: 'coordinates:facts', round_id: round.id } })
    expect(h.scopes.disposed).toEqual([id])
    expect(h.ledger.compares.size).toBe(0)
  })

  it('the run invariant holds pair by pair: facts that differ per task (a task row with its own environment) agree between the arms; one pair apart is invalid', async () => {
    const h = await openLifecycle()
    const round = await openRound(h)
    h.executor.facts = (_c, taskId) => sha(taskId)
    const a = await runOne(h, round.id, 'a', 0.9)
    expect(h.ledger.challenger(a)?.status).toBe('running')
    expect(new Set(h.ledger.attemptsOf(a).map((x) => x.facts_sha)).size).toBe(4)
    const { id: b } = await h.lifecycle.propose(challengerProposal(round.champion_id, 'b'), { roundId: round.id })
    await h.lifecycle.open(b)
    h.executor.facts = (c, taskId) => (c === b && taskId === 'h2' ? sha('other') : sha(taskId))
    expect((await h.lifecycle.run(b, 'holdin', runOptions(out()))).invalid).toBe('coordinates:facts')
    expect(h.ledger.challenger(b)).toMatchObject({ status: 'judged', verdict: { value: 'invalid', by: 'lifecycle', rule: 'coordinates:facts' } })
    // the same check at judge time: the pairs agree, the gate gets no single facts sha
    expect((await h.lifecycle.judge(a, 'holdin')).verdict.value).not.toBe('invalid')
  })

  it('the holdout budget the pack declares is debited per reveal and refused once spent', async () => {
    const h = await openLifecycle()
    await calibrate(h)
    const round = await openRound(h)
    await runOne(h, round.id, 'a', 0.9, 'holdout')
    await runOne(h, round.id, 'b', 0.9, 'holdout')
    await expect(runOne(h, round.id, 'c', 0.9, 'holdout')).rejects.toEqual(code('BUDGET_EXCEEDED'))
    // The three calibration reruns, then one challenger run each: the champion's held-out attempts are reused.
    expect(h.executor.calls.filter((c) => c.req.set === 'holdout')).toHaveLength(5)
  })

  it('the holdout budget is what the ledger shows spent: a rerun of a revealed row is no reveal, and a second service over the same rows starts from it', async () => {
    const h = await openLifecycle()
    await calibrate(h)
    const round = await openRound(h)
    const a = await runOne(h, round.id, 'a', 0.9, 'holdout')
    await h.lifecycle.run(a, 'holdout', runOptions(out(), { repeat: 2 }))
    expect((await h.lifecycle.judge(a, 'holdout')).holdout_budget_remaining).toBe(1)
    expect(h.lifecycle.nextActions(a).find((n) => n.kind === 'holdout')).toBeUndefined()

    const again = await openLifecycle({ ledger: h.ledger })
    const reopened = await again.lifecycle.openRound({ pack: PACK, champion: championProposal(), metric: 'm', nEffFloor: 1, openedAt: round.opened_at })
    expect(reopened.id).toBe(round.id)
    const b = await again.lifecycle.propose(challengerProposal(round.champion_id, 'b'), { roundId: round.id }).catch((e: LifecycleError) => e.code)
    expect(b).toBe('ROUND_CLOSED')
    const later = await again.lifecycle.openRound({ pack: PACK, champion: championProposal(), metric: 'm', nEffFloor: 1, openedAt: '2026-08-26T02:00:00.000Z' })
    const { id: c } = await again.lifecycle.propose(challengerProposal(round.champion_id, 'c'), { roundId: later.id })
    const { id: d } = await again.lifecycle.propose(challengerProposal(round.champion_id, 'd'), { roundId: later.id })
    await again.lifecycle.open(c)
    await again.lifecycle.open(d)
    await again.lifecycle.run(c, 'holdout', runOptions(out()))
    expect((await again.lifecycle.judge(c, 'holdout')).holdout_budget_remaining).toBe(0)
    await expect(again.lifecycle.run(d, 'holdout', runOptions(out()))).rejects.toEqual(code('BUDGET_EXCEEDED'))
  })
})

describe('judge', () => {
  it('records the compare row under the round with its numbers and sets the verdict from the promotion gate', async () => {
    const h = await openLifecycle()
    const round = await openRound(h)
    const id = await runOne(h, round.id, 'a', 0.9, 'smoke')
    await expect(h.lifecycle.judge(id, 'holdin')).rejects.toEqual(code('BAD_TRANSITION'))
    const smoke = await h.lifecycle.judge(id, 'smoke')
    expect(smoke).toMatchObject({ challenger_id: id, vs_id: round.champion_id, tier: 'smoke', round_id: round.id, replicates: 1, min_effect: 0.1, sd_source: 'comparison', holm: { m: 1, rank: 0 }, gate: DEFAULT, shadow: false, verdict: { value: 'hold', rule: 'validity' } })
    expect(h.ledger.challenger(id)).toMatchObject({ status: 'judged', tier_reached: 'smoke', verdict: { value: 'hold', by: DEFAULT, rule: 'validity', round_id: round.id } })

    await h.lifecycle.run(id, 'holdin', runOptions(out()))
    const holdin = await h.lifecycle.judge(id, 'holdin')
    expect(holdin).toMatchObject({ tier: 'holdin', mean: expect.closeTo(0.4, 6), n_eff: 4, verdict: { value: 'hold', rule: 'screen' } })
    expect(h.ledger.compares.size).toBe(2)
    // First verdict wins: judging again leaves the row judged with the same verdict.
    await h.lifecycle.judge(id, 'holdin')
    expect(h.ledger.compares.size).toBe(2)
    expect(h.ledger.challenger(id)?.verdict).toMatchObject({ value: 'hold', rule: 'screen' })
  })

  it('a row the run left invalid on the facts is not judged; the facts are checked again at judge time and reach the gate', async () => {
    const h = await openLifecycle({ gate: [GATE_PICK] })
    h.ledger.consents.push(consent('gate-pick@test', 'gate_change'))
    await calibrate(h)
    const round = await openRound(h)
    const { id } = await h.lifecycle.propose(challengerProposal(round.champion_id, 'a'), { roundId: round.id })
    await h.lifecycle.open(id)
    h.executor.facts = (c) => (c === id ? sha('other') : sha('facts'))
    expect((await h.lifecycle.run(id, 'holdout', runOptions(out()))).invalid).toBe('coordinates:facts')
    await expect(h.lifecycle.judge(id, 'holdout')).rejects.toEqual(code('BAD_TRANSITION'))
    expect(h.ledger.challenger(id)).toMatchObject({ status: 'judged', verdict: { value: 'invalid', by: 'lifecycle', rule: 'coordinates:facts' } })
    expect(h.ledger.compares.size).toBe(0)
    expect(await h.lifecycle.decide(round.id)).toEqual({ roundId: round.id, superseded: [] })

    // A run whose rows drift after it: judge finds the mismatch itself, and the gate would too (factsSha on the request).
    const later = await openRound(h, { openedAt: '2026-08-26T01:00:00.000Z' })
    h.executor.facts = () => sha('facts')
    const b = await runOne(h, later.id, 'b', 0.9)
    const c = await runOne(h, later.id, 'c', 0.9)
    for (const a of h.ledger.attemptsOf(b)) h.ledger.attempts.set(a.id, { ...a, facts_sha: sha('drift') })
    const seen: CompareRequest[] = []
    const spy = { ...GATE_PICK, judge: (req: CompareRequest) => { seen.push(req); return GATE_PICK.judge(req) } }
    h.gate.policies = [spy]
    await expect(h.lifecycle.judge(b, 'holdin')).rejects.toEqual(expect.objectContaining({ code: 'NOT_COMPARABLE', detail: { coordinate: 'facts' } }))
    expect(h.ledger.challenger(b)).toMatchObject({ status: 'judged', verdict: { value: 'invalid', by: 'lifecycle', rule: 'coordinates:facts', round_id: later.id } })
    expect(seen).toEqual([])
    expect(h.ledger.compares.size).toBe(0)
    await h.lifecycle.judge(c, 'holdin')
    expect(seen[0]?.factsSha).toEqual({ challenger: sha('facts'), champion: sha('facts') })
  })

  it('nextActions after a hold on holdin: replicate, go to holdout with the budget, drop — with the rule numbers and cost', async () => {
    const h = await openLifecycle()
    const floor = await calibrate(h)
    const round = await openRound(h)
    const id = await runOne(h, round.id, 'a', 0.9)
    expect(h.lifecycle.nextActions(id)).toEqual([{ kind: 'judge', tier: 'holdin' }])
    await h.lifecycle.judge(id, 'holdin')
    const numbers = { rule: 'screen', mde: 0, n_eff: 4, replicates: 1, min_effect: 0.1, sd: floor.sd_paired }
    expect(h.lifecycle.nextActions(id)).toEqual([
      { kind: 'replicate', tier: 'holdin', estimate: { attempts: 4, usd: expect.closeTo(0.04, 9) }, numbers },
      { kind: 'holdout', tier: 'holdout', estimate: { attempts: 4, usd: expect.closeTo(0.04, 9) }, numbers, budget: { remaining: 2, spent: 0 } },
      { kind: 'drop' },
    ])
  })

  it('rule 0 again on the rows: a coordinate that drifted is invalid:coordinates:<name>', async () => {
    const h = await openLifecycle()
    const round = await openRound(h)
    const id = await runOne(h, round.id, 'a', 0.9)
    h.ledger.challengers.set(id, { ...h.ledger.challenger(id)!, env_sha: sha('drift') })
    await expect(h.lifecycle.judge(id, 'holdin')).rejects.toEqual(code('NOT_COMPARABLE'))
    expect(h.ledger.challenger(id)).toMatchObject({ status: 'judged', verdict: { value: 'invalid', by: 'lifecycle', rule: 'coordinates:env_sha', round_id: round.id } })
    expect(h.ledger.compares.size).toBe(0)
  })

  it('S5: the prediction is scored against the paired deltas and recorded beside the verdict', async () => {
    const h = await openLifecycle()
    const round = await openRound(h)
    const { id } = await h.lifecycle.propose(challengerProposal(round.champion_id, 'a', { prediction: { metric: 'm', direction: 'up', predicted_fixes: ['h1', 'h2'], at_risk: ['h3'] } }), { roundId: round.id })
    h.executor.value = (challengerId, taskId) => (challengerId === id ? (taskId === 'h1' ? 0.9 : taskId === 'h3' ? 0.1 : 0.5) : 0.5)
    await h.lifecycle.open(id)
    await h.lifecycle.run(id, 'holdin', runOptions(out()))
    const compare = await h.lifecycle.judge(id, 'holdin')
    // h1 rose (a hit), h2 stayed (a miss): 1/2; h3 fell as predicted: 1/1.
    expect(compare.predicted_vs_observed).toEqual({ fixes_hit: 0.5, at_risk_hit: 1 })
    // A row that predicted nothing per task records nothing.
    const later = await openRound(h, { openedAt: '2026-08-26T01:00:00.000Z' })
    const b = await runOne(h, later.id, 'b', 0.9)
    expect((await h.lifecycle.judge(b, 'holdin')).predicted_vs_observed).toBeUndefined()
  })

  it('S6: a pair settled on two truth snapshots is not judged; the row is invalid on truth_snapshot', async () => {
    const h = await openLifecycle()
    const round = await openRound(h)
    const id = await runOne(h, round.id, 'a', 0.9)
    const championScore = [...h.ledger.scores.values()].find((s) => h.ledger.attempts.get(s.attempt_id)?.challenger_id === round.champion_id && h.ledger.attempts.get(s.attempt_id)?.task_id === 'h1')!
    championScore.truth_snapshot_id = sha('revised')
    await expect(h.lifecycle.judge(id, 'holdin')).rejects.toEqual(code('NOT_COMPARABLE'))
    expect(h.ledger.challenger(id)).toMatchObject({ status: 'judged', verdict: { value: 'invalid', rule: 'truth_snapshot' } })
    expect(h.ledger.compares.size).toBe(0)
  })

  it('S4: one pre-registered held-out test per round — the same judgement is idempotent, only an underpowered one escalates', async () => {
    const h = await openLifecycle()
    await calibrate(h)
    const round = await openRound(h)
    const a = await runOne(h, round.id, 'a', 0.9, 'holdout')
    expect((await h.lifecycle.judge(a, 'holdout')).verdict.value).toBe('promote')
    await h.lifecycle.judge(a, 'holdout')
    expect(h.ledger.comparesOf(a)).toHaveLength(1)
    await h.lifecycle.run(a, 'holdout', runOptions(out(), { repeat: 2 }))
    await expect(h.lifecycle.judge(a, 'holdout')).rejects.toEqual(code('BAD_TRANSITION'))
    expect(h.ledger.comparesOf(a)).toHaveLength(1)
    expect(h.ledger.challenger(a)?.verdict).toMatchObject({ value: 'promote', rule: 'holdout' })

    // Underpowered on the entity floor: the escalation over more replicates is a new row and the row's verdict.
    const under = await openRound(h, { nEffFloor: 5, openedAt: '2026-08-26T01:00:00.000Z' })
    const b = await runOne(h, under.id, 'b', 0.9, 'holdout')
    expect((await h.lifecycle.judge(b, 'holdout')).rule_fired).toBe('power:nEff')
    await h.lifecycle.run(b, 'holdout', runOptions(out(), { repeat: 2 }))
    expect((await h.lifecycle.judge(b, 'holdout')).replicates).toBe(2)
    expect(h.ledger.comparesOf(b)).toHaveLength(2)
  })

  it('holdout needs the noise floor the round pinned; with one, the row carries sd_source noise_floor', async () => {
    const h = await openLifecycle()
    const round = await openRound(h)
    const id = await runOne(h, round.id, 'a', 0.9, 'holdout')
    await expect(h.lifecycle.judge(id, 'holdout')).rejects.toEqual(code('NO_NOISE_FLOOR'))
    expect(h.ledger.challenger(id)).toMatchObject({ status: 'judged', verdict: { value: 'invalid', rule: 'noise_floor' } })

    const floor = await calibrate(h)
    const pinned = await openRound(h, { openedAt: '2026-08-26T01:00:00.000Z' })
    expect(pinned.noise_floor_id).toBe(floor.id)
    const b = await runOne(h, pinned.id, 'b', 0.9, 'holdout')
    const compare = await h.lifecycle.judge(b, 'holdout')
    expect(compare).toMatchObject({ tier: 'holdout', sd_source: 'noise_floor', mde: 0, verdict: { value: 'promote', rule: 'holdout' } })
    expect(h.ledger.round(pinned.id)?.best_so_far).toBeCloseTo(0.4, 6)
  })

  it('judges with the round gate only: an unmounted round gate refuses, shadows are recorded beside the verdict', async () => {
    const h = await openLifecycle({ gate: [GATE_PICK, GATE_DEFAULT] })
    h.ledger.consents.push(consent('gate-pick@test', 'gate_change'))
    const round = await openRound(h, { shadowGates: ['gate-pick@test'] })
    const id = await runOne(h, round.id, 'a', 0.9)
    h.gate.policies = [GATE_PICK]
    await expect(h.lifecycle.judge(id, 'holdin')).rejects.toEqual(code('GATE_MISMATCH'))
    h.gate.policies = [GATE_PICK, GATE_DEFAULT]
    await h.lifecycle.judge(id, 'holdin')
    const rows = h.ledger.comparesOf(id)
    expect(rows.map((c) => [c.gate, c.shadow, c.round_id])).toEqual([['gate-pick@test', true, round.id], [DEFAULT, false, round.id]])
    expect(h.ledger.challenger(id)?.verdict?.by).toBe(DEFAULT)
  })
})

describe('decide', () => {
  async function twoPromotes(h: Harness) {
    h.ledger.consents.push(consent('gate-pick@test', 'gate_change'))
    await calibrate(h)
    const round = await openRound(h)
    const a = await runOne(h, round.id, 'a', 0.9, 'holdout')
    const b = await runOne(h, round.id, 'b', 0.7, 'holdout')
    expect((await h.lifecycle.judge(a, 'holdout')).verdict.value).toBe('promote')
    expect((await h.lifecycle.judge(b, 'holdout')).verdict.value).toBe('promote')
    expect(h.ledger.round(round.id)?.k).toBe(2)
    return { round, a, b }
  }

  it('k=2: the larger lower bound is the candidate; without a consent nothing changes; with one it is promoted and the other superseded', async () => {
    const h = await openLifecycle({ gate: [GATE_PICK] })
    const { round, a, b } = await twoPromotes(h)
    expect(await h.lifecycle.decide(round.id)).toEqual({ pending: 'consent', roundId: round.id, candidate: a })
    expect(h.lifecycle.status().pending).toEqual([{ roundId: round.id, candidate: a, action: 'promote' }])
    expect(h.champion.promoted).toEqual([])
    expect(h.ledger.round(round.id)?.status).toBe('open')

    // E2: a promote consent decides one round — one bound elsewhere leaves the candidate pending.
    h.ledger.consents.push(consent(a, 'promote', 'consent-elsewhere', 'another-round'))
    expect(await h.lifecycle.decide(round.id)).toEqual({ pending: 'consent', roundId: round.id, candidate: a })
    h.ledger.consents.push(consent(a, 'promote', 'consent-a', round.id))
    expect(await h.lifecycle.decide(round.id)).toEqual({ roundId: round.id, promoted: a, superseded: [b], consentId: 'consent-a' })
    expect(h.champion.promoted).toEqual([[a, 'consent-a']])
    expect(h.ledger.challenger(a)).toMatchObject({ status: 'decided', verdict: { value: 'promote', consent_id: 'consent-a' } })
    expect(h.ledger.challenger(b)).toMatchObject({ status: 'judged', verdict: { value: 'hold:superseded', round_id: round.id } })
    expect(h.ledger.round(round.id)).toMatchObject({ status: 'decided', outcome: { promoted: a, superseded: [b], consent_id: 'consent-a' } })
    expect(h.ledger.round(round.id)?.closed_at).toBeDefined()
    expect(h.scopes.disposed).toEqual([a, b])
    const servings = h.ledger.servings()
    expect(servings).toHaveLength(1)
    expect(servings[0]).toMatchObject({ champion_id: a, by: 'promote', consent_id: 'consent-a', profile_sha: stateSha(h.champion.state) })
    expect(servings[0]?.to).toBeUndefined()
    await expect(h.lifecycle.decide(round.id)).rejects.toEqual(code('ROUND_CLOSED'))
    expect(h.lifecycle.status().rounds).toEqual([])
  })

  it('ties on the lower bound go to the earliest proposed', async () => {
    const h = await openLifecycle({ gate: [GATE_PICK] })
    h.ledger.consents.push(consent('gate-pick@test', 'gate_change'))
    await calibrate(h)
    const round = await openRound(h)
    const late = await runOne(h, round.id, 'z', 0.9, 'holdout')
    const early = await runOne(h, round.id, 'a', 0.9, 'holdout')
    await h.lifecycle.judge(late, 'holdout')
    await h.lifecycle.judge(early, 'holdout')
    expect(await h.lifecycle.decide(round.id)).toMatchObject({ pending: 'consent', candidate: early })
  })

  it('a round with no promote closes with drops decided and holds still open', async () => {
    const h = await openLifecycle()
    const round = await openRound(h)
    const held = await runOne(h, round.id, 'a', 0.9)
    const dropped = await runOne(h, round.id, 'b', 0.9)
    await h.lifecycle.judge(held, 'holdin')
    h.ledger.challengers.set(dropped, { ...h.ledger.challenger(dropped)!, env_sha: sha('drift') })
    await h.lifecycle.judge(dropped, 'holdin').catch(() => {})
    expect(await h.lifecycle.decide(round.id)).toEqual({ roundId: round.id, superseded: [] })
    expect(h.ledger.challenger(held)?.status).toBe('judged')
    expect(h.ledger.challenger(dropped)?.status).toBe('decided')
    expect(h.champion.promoted).toEqual([])
  })

  it('a promote verdict from another round, under another gate, is no candidate of this one and is left alone', async () => {
    const h = await openLifecycle({ gate: [GATE_PICK, GATE_DEFAULT] })
    h.ledger.consents.push(consent('gate-pick@test', 'gate_change'))
    await calibrate(h)
    const first = await openRound(h, { gate: 'gate-pick@test', openedAt: '2026-08-26T00:00:00.000Z' })
    const a = await runOne(h, first.id, 'a', 0.9, 'holdout')
    expect((await h.lifecycle.judge(a, 'holdout')).verdict.value).toBe('promote')
    await h.lifecycle.closeRound(first.id)
    const second = await openRound(h, { openedAt: '2026-08-26T01:00:00.000Z' })
    expect(second.gate.name).toBe(GATE_DEFAULT.name)
    expect(await h.lifecycle.propose(challengerProposal(first.champion_id, 'a'), { roundId: second.id })).toEqual({ id: a, created: false })
    h.ledger.consents.push(consent(a, 'promote', 'consent-a', second.id))
    expect(await h.lifecycle.decide(second.id)).toEqual({ roundId: second.id, superseded: [] })
    expect(h.champion.promoted).toEqual([])
    expect(h.ledger.challenger(a)).toMatchObject({ status: 'judged', verdict: { value: 'promote', by: 'gate-pick@test', round_id: first.id } })
    expect(h.lifecycle.status().pending).toEqual([])
  })

  it('a promote verdict below holdout is no candidate: the one pre-registered test is the held-out one', async () => {
    const eager = { ...GATE_PICK, judge: async (req: CompareRequest) => ({ ...(await GATE_PICK.judge(req)), verdict: 'promote' as const }) }
    const h = await openLifecycle({ gate: [eager] })
    h.ledger.consents.push(consent('gate-pick@test', 'gate_change'))
    const round = await openRound(h)
    const a = await runOne(h, round.id, 'a', 0.9)
    expect((await h.lifecycle.judge(a, 'holdin')).verdict.value).toBe('promote')
    h.ledger.consents.push(consent(a, 'promote', 'consent-a', round.id))
    expect(await h.lifecycle.decide(round.id)).toEqual({ roundId: round.id, superseded: [] })
    expect(h.champion.promoted).toEqual([])
    expect(h.ledger.challenger(a)).toMatchObject({ status: 'judged', tier_reached: 'holdin', verdict: { value: 'promote' } })
  })

  it('a round decides only against the champion state it opened on: after a promotion the other open round is refused', async () => {
    const h = await openLifecycle({ gate: [GATE_PICK] })
    h.ledger.consents.push(consent('gate-pick@test', 'gate_change'))
    await calibrate(h)
    const first = await openRound(h, { openedAt: '2026-08-26T00:00:00.000Z' })
    const second = await openRound(h, { openedAt: '2026-08-26T01:00:00.000Z' })
    expect(first.profile_sha).toBe(stateSha(EMPTY_STATE))
    const a = await runOne(h, first.id, 'a', 0.9, 'holdout')
    const b = await runOne(h, second.id, 'b', 0.9, 'holdout')
    await h.lifecycle.judge(a, 'holdout')
    await h.lifecycle.judge(b, 'holdout')
    h.ledger.consents.push(consent(a, 'promote', 'consent-a', first.id), consent(b, 'promote', 'consent-b', second.id))
    expect(await h.lifecycle.decide(first.id)).toMatchObject({ promoted: a })
    await expect(h.lifecycle.decide(second.id)).rejects.toEqual(code('PROFILE_CHANGED'))
    expect(h.champion.promoted).toEqual([[a, 'consent-a']])
    expect(h.ledger.challenger(a)).toMatchObject({ status: 'decided', verdict: { value: 'promote' } })
    expect(h.ledger.challenger(b)).toMatchObject({ status: 'judged', verdict: { value: 'promote' } })
    expect(h.ledger.round(second.id)?.status).toBe('open')
    await h.lifecycle.closeRound(second.id)
  })
})

describe('abortRound', () => {
  it('judges the running siblings invalid under the abort rule, disposes every scope, closes the round aborted, and refuses twice', async () => {
    const h = await openLifecycle()
    const round = await openRound(h)
    const events: LifecycleEvent[] = []
    h.lifecycle.on('lifecycle/event', (e) => { events.push(e) })
    const running = await runOne(h, round.id, 'a', 0.9)
    const judged = await runOne(h, round.id, 'b', 0.8)
    await h.lifecycle.judge(judged, 'holdin')
    expect(h.ledger.challenger(running)!.status).toBe('running')
    expect(await h.lifecycle.abortRound(round.id)).toEqual({ roundId: round.id, aborted: [running] })
    expect(h.ledger.challenger(running)).toMatchObject({ status: 'judged', verdict: { value: 'invalid', by: 'lifecycle', rule: ABORT_RULE, round_id: round.id } })
    expect(h.ledger.challenger(judged)!.verdict?.rule).not.toBe(ABORT_RULE)
    expect(h.ledger.round(round.id)).toMatchObject({ status: 'decided', outcome: { superseded: [], aborted: true } })
    expect(h.ledger.round(round.id)!.closed_at).toMatch(/^\d{4}-/)
    expect(h.scopes.disposed).toEqual([running, judged])
    expect(events.filter((e) => e.kind === 'round/closed')).toEqual([{ kind: 'round/closed', roundId: round.id, at: expect.any(String) }])
    expect(events.filter((e) => e.kind === 'challenger/transition' && e.challengerId === running).at(-1)).toMatchObject({ status: 'judged', roundId: round.id })
    await expect(h.lifecycle.abortRound(round.id)).rejects.toEqual(code('ROUND_CLOSED'))
    expect(h.lifecycle.status().rounds).toEqual([])
  })

  it('refuses a round with no running sibling and an unknown round', async () => {
    const h = await openLifecycle()
    const round = await openRound(h)
    await expect(h.lifecycle.abortRound(round.id)).rejects.toEqual(code('BAD_TRANSITION'))
    const id = await runOne(h, round.id, 'a', 0.9)
    await h.lifecycle.judge(id, 'holdin')
    await expect(h.lifecycle.abortRound(round.id)).rejects.toEqual(code('BAD_TRANSITION'))
    expect(h.ledger.round(round.id)!.status).toBe('open')
    await expect(h.lifecycle.abortRound('nope')).rejects.toEqual(code('UNKNOWN'))
  })
})

describe('demote and settle', () => {
  async function promoted(h: Harness) {
    h.ledger.consents.push(consent('gate-pick@test', 'gate_change'))
    await calibrate(h)
    const round = await openRound(h)
    const a = await runOne(h, round.id, 'a', 0.9, 'holdout')
    await h.lifecycle.judge(a, 'holdout')
    h.ledger.consents.push(consent(a, 'promote', 'consent-a', round.id))
    await h.lifecycle.decide(round.id)
    return a
  }

  it('demote needs a demote consent and writes the serving rows', async () => {
    const h = await openLifecycle({ gate: [GATE_PICK] })
    const a = await promoted(h)
    await expect(h.lifecycle.demote(a, 'operator')).rejects.toEqual(code('NO_CONSENT'))
    await expect(h.lifecycle.demote(a, 'operator', 'consent-a')).rejects.toEqual(code('NO_CONSENT'))
    expect(h.champion.demoted).toEqual([])
    h.ledger.consents.push(consent(a, 'demote', 'demote-a'))
    await h.lifecycle.demote(a, 'operator', 'demote-a')
    expect(h.champion.demoted).toEqual([a])
    // The reversed verdict is the service's write, after the champion dropped the row; the promotion's consent stays on it.
    expect(h.ledger.challenger(a)).toMatchObject({ status: 'decided', verdict: { value: 'reversed', by: 'champion', rule: 'demote:operator', consent_id: 'consent-a' } })
    expect(h.ledger.statusLog.at(-1)).toEqual({ id: a, status: 'decided', verdict: 'reversed' })
    await expect(h.lifecycle.demote(a, 'again', 'demote-a')).rejects.toThrow('is not kept')
    const servings = h.ledger.servings()
    expect(servings).toHaveLength(2)
    expect(servings[0]).toMatchObject({ champion_id: a, by: 'promote', to: expect.any(String) })
    expect(servings[1]).toMatchObject({ champion_id: a, by: 'demote', consent_id: 'demote-a' })
    expect(servings[1]?.from).toBe(servings[1]?.to)
  })

  it('rescore: a kept row that no longer promotes is reversed, demoted, and lands as a serving row by reversed', async () => {
    const h = await openLifecycle({ gate: [GATE_PICK] })
    const a = await promoted(h)
    // Every settlement is a new truth snapshot: a re-score is judged on it, never on the truth the promotion was judged on.
    const coords = { vs_id: h.ledger.challenger(a)!.parent_ids[0]!, tier: 'holdout' as const, truth_snapshot_id: sha('t2'), at: 'later' }
    const confirmed = await h.lifecycle.rescore(a, { ...(await GATE_PICK.judge(compareRequestOf(h, a, 'holdout'))), gateMethod: 'gate-pick@test' }, coords)
    expect(confirmed.verdict.value).toBe('confirmed')
    expect(h.champion.demoted).toEqual([])
    expect(h.ledger.challenger(a)).toMatchObject({ status: 'decided', verdict: { value: 'promote' } })

    const reversed = await h.lifecycle.rescore(a, { ...(await GATE_DEFAULT.judge(compareRequestOf(h, a, 'holdout'))), verdict: 'drop', gateMethod: DEFAULT }, { ...coords, truth_snapshot_id: sha('t3'), at: 'latest' })
    expect(reversed).toMatchObject({ challenger_id: a, verdict: { value: 'reversed' }, gate: DEFAULT, shadow: false })
    expect([...h.ledger.compares.values()].filter((c) => c.challenger_id === a && c.at === 'latest')).toEqual([reversed])
    expect(h.champion.demoted).toEqual([a])
    expect(h.ledger.challenger(a)).toMatchObject({ status: 'decided', verdict: { value: 'reversed', by: 'champion', rule: `demote:reversed on ${sha('t3')}: ${reversed.rule_fired}`, consent_id: 'consent-a' } })
    const servings = h.ledger.servings()
    expect(servings).toHaveLength(2)
    expect(servings[1]).toMatchObject({ champion_id: a, by: 'reversed' })
    expect(servings[1]?.consent_id).toBeUndefined()
  })

  it('rescore: an unkept row takes the gate value and stays judged', async () => {
    const h = await openLifecycle()
    const round = await openRound(h)
    const b = await runOne(h, round.id, 'b', 0.9)
    await h.lifecycle.judge(b, 'holdin')
    const coords = { vs_id: round.champion_id, tier: 'holdin' as const, truth_snapshot_id: sha('t2'), at: 'later' }
    const held = await h.lifecycle.rescore(b, { ...(await GATE_DEFAULT.judge(compareRequestOf(h, b, 'holdin'))), verdict: 'hold:underpowered', gateMethod: DEFAULT }, coords)
    expect(held.verdict.value).toBe('hold')
    expect(h.ledger.challenger(b)).toMatchObject({ status: 'judged', verdict: { value: 'hold', by: DEFAULT } })
    expect(h.champion.demoted).toEqual([])
    await expect(h.lifecycle.rescore('nope', held as never, coords)).rejects.toEqual(code('UNKNOWN'))
  })

  it('settle plans through the champion and debits the holdout budget when a kept row reveals held-out attempts', async () => {
    const h = await openLifecycle({ gate: [GATE_PICK] })
    const a = await promoted(h)
    const event = { id: 'settle-1', kind: 'truth' as const, taskset_sha: sha('t'), as_of: 'now', truth_snapshot_id: 'ts1', n_settled: 1, n_pending: 0, task_ids: ['o1'] }
    const holdoutAttempts = h.ledger.attemptsOf(a).filter((x) => x.tier === 'holdout').map((x) => x.id)
    h.champion.plan = [{ settlement_id: 'settle-1', challenger_id: a, attempt_ids: holdoutAttempts, truth_snapshot_id: 'ts1' }]
    expect(await h.lifecycle.settle(event)).toEqual(h.champion.plan)
    expect(h.champion.settled).toEqual([event])
    expect(h.lifecycle.nextActions(a)).toEqual([])
    // One reveal was spent by the holdout run, one by the settlement: the third is refused.
    await expect(h.lifecycle.settle({ ...event, id: 'settle-2' })).rejects.toEqual(code('BUDGET_EXCEEDED'))
    h.champion.plan = []
    expect(await h.lifecycle.settle({ ...event, id: 'settle-3' })).toEqual([])

    // S7: a second service over the same rows replays the settlement debit too — the budget does not grow across restarts.
    const again = await openLifecycle({ ledger: h.ledger, gate: [GATE_PICK] })
    again.champion.state = h.champion.state
    const round = h.ledger.roundsOf(h.ledger.challenger(a)!.parent_ids[0]!)[0]!
    await again.lifecycle.openRound({ pack: PACK, champion: championProposal(), metric: 'm', nEffFloor: 1, openedAt: round.opened_at })
    again.champion.plan = [{ settlement_id: 'settle-4', challenger_id: a, attempt_ids: holdoutAttempts, truth_snapshot_id: 'ts1' }]
    await expect(again.lifecycle.settle({ ...event, id: 'settle-4' })).rejects.toEqual(code('BUDGET_EXCEEDED'))
  })
})

// ------------------------------------------------------------- calibrate

describe('calibrate', () => {
  it('reruns the champion with the null diff and records the paired spread per entity across reruns', async () => {
    const h = await openLifecycle()
    const step: Record<string, number> = { h1: 0.1, h2: 0.2, h3: 0.1, h4: 0.2 }
    // Every rerun is the set again at sample 0; the executor's call count tells the reruns apart.
    h.executor.value = (_id, task) => 0.5 + h.executor.calls.length * (step[task] ?? 0)
    // S1: fewer than 3 reruns is no noise floor.
    for (const reruns of [1, 2]) {
      await expect(h.lifecycle.calibrate({ pack: PACK, champion: championProposal(), metric: 'm', set: 'holdin', reruns, run: runOptions(out()) })).rejects.toEqual(code('BAD_TRANSITION'))
    }
    expect(h.executor.calls).toEqual([])
    const floor = await h.lifecycle.calibrate({ pack: PACK, champion: championProposal(), metric: 'm', set: 'holdin', reruns: 3, run: runOptions(out(), { runId: 'cal' }) })
    const diffs = Object.values(step).flatMap((s) => [s, 2 * s, s])
    expect(floor).toMatchObject({ unit: 'entity', n_reruns: 3, n_tasks: 4, tier: 'holdin', loop: 'fake', metric: 'm', sd_paired: expect.closeTo(sd(diffs), 9) })
    expect(h.ledger.floors.get(floor.id)).toEqual(floor)
    expect(h.executor.calls.map((c) => c.runId)).toEqual(['cal-calibrate-0', 'cal-calibrate-1', 'cal-calibrate-2'])
    expect(h.executor.calls[0]).toMatchObject({ challengerId: floor.champion_id, req: { set: 'holdin', repeat: 1 } })
    expect(h.executor.calls[0]?.req.skillDir).toBeUndefined()
    expect(h.ledger.attemptsOf(floor.champion_id).every((a) => a.sample === 0)).toBe(true)
    expect(h.ledger.challenger(floor.champion_id)).toMatchObject({ eval_config_sha: floor.eval_config_sha, status: 'proposed' })
    expect(h.ledger.noiseFloorFor(floor.eval_config_sha, floor.champion_id, 'fake', 'm')).toEqual(floor)
    expect(h.lifecycle.status().noiseFloors).toEqual([floor])
  })
})

describe('status', () => {
  it('lists the champion, the open rounds, the pending consents, the latest noise floors and the experiments', async () => {
    const h = await openLifecycle()
    expect(h.lifecycle.status()).toEqual({ champion: EMPTY_STATE, rounds: [], pending: [], noiseFloors: [], experiments: [] })
    const exp = await h.lifecycle.preregister({ hypothesis: 'h', prediction: { metric: 'm', direction: 'up' }, pack: 'fixture', gate: gateRefOf(GATE_DEFAULT, roundPolicy(1, 0.1)), budget: {}, created_by: { channel: 'test' } })
    const round = await openRound(h, { experimentId: exp.id })
    const status = h.lifecycle.status()
    expect(status.rounds.map((r) => r.id)).toEqual([round.id])
    expect(status.experiments.map((e) => e.id)).toEqual([exp.id])
  })
})
