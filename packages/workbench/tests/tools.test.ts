// The samsara_* tools over fakes: every read-only tool's result, every
// spending tool's happy path (approval asked with the quoted cost, a job the
// agent owns, the operator on the round) and refusal paths (no agent, budget
// exceeded, no noise floor, operator on the proposer's route, approval
// rejected or unavailable), and the stop of an owned job.

import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { Context, SessionId } from '@oldbulb/samsara-kernel'
import { canonicalJson, evalConfigSha, sha256, type AttemptRow, type CompareRow, type ExperimentRow, type RoundRow, type ScoreRow } from '@oldbulb/samsara-ledger'
import { LifecycleError } from '@oldbulb/samsara-lifecycle'
import { loadPack } from '@oldbulb/samsara-pack'
import { CLAUDE_P_NAME } from '@oldbulb/samsara-proposers'
import { challengerProposal } from '../../lifecycle/tests/fakes.ts'
import { apply as applyExecutor } from '../src/executor.ts'
import { jobTags } from '../src/jobs.ts'
import { notebookId } from '../src/notebook.ts'
import { apply as applyTools, inject as toolsInject, operatorOf, proposerRouteOf, sameRoute } from '../src/tools.ts'
import { FakeAdapter, FakeTools, OPERATOR_ROUTE, PACKS_DIR, PACK, ROUTE, fakeAgent, fakeExec, openHarness, sha, type Harness } from './fakes.ts'

beforeEach(() => { jobTags.clear() })

type Result = Record<string, any>

async function call(h: Harness, name: string, args: object, exec = fakeExec(fakeAgent())): Promise<Result> {
  const tool = h.tools.get(name)
  if (!tool) throw new Error(`no tool ${name}`)
  return (await tool.execute(args, exec)) as Result
}

function attempt(id: string, challenger_id: string, task_id: string, sample: number, tier: AttemptRow['tier'], usd?: number): AttemptRow {
  return {
    id, challenger_id, task_id, sample, loop: 'fake', tier, status: 'COMPLETED', stop_reason: 'completed', facts_sha: sha('facts'),
    usage: { input_tokens: 1, output_tokens: 1 }, cost: usd !== undefined ? { usd } : {}, output: { source: 'file', valid: true }, artifacts: [],
  }
}

function score(attempt_id: string, value: number): ScoreRow {
  return { attempt_id, scorer_version: '0', truth_snapshot_id: sha('t'), metric: 'm', value, kind: 'reality' }
}

function compare(challenger_id: string, tier: CompareRow['tier'], shadow = false): CompareRow {
  return {
    challenger_id, vs_id: 'champ', tier, truth_snapshot_id: 's', per_task: [{ task_id: 'h1', delta: 1 }], mean: 1, ci: [0, 1], method: 'm', cluster_key: 'e',
    n_eff: 1, mde: 0, rule_fired: 'r', verdict: { value: 'hold', by: 'g', rule: 'r' }, at: 'now', gate: shadow ? 'other@1' : 'gate-default@0', ...(shadow ? { shadow } : {}),
  }
}

/** The champion the tools compute for a set, as the noise floor and the attempts must be keyed. */
function champion(h: Harness, set: 'smoke' | 'holdin' | 'holdout') {
  const { id, proposal } = h.champion(set)
  return { id, eval_config_sha: evalConfigSha(proposal) }
}

async function recordFloor(h: Harness, set: 'holdin' | 'holdout'): Promise<string> {
  const c = champion(h, set)
  return h.ledger.recordNoiseFloor({
    eval_config_sha: c.eval_config_sha, champion_id: c.id, loop: 'fake', metric: 'm', measured_at: '2026-08-26T00:00:00.000Z',
    unit: 'entity', sd_paired: 0.1, n_reruns: 3, n_tasks: 4, tier: set,
  })
}

let registered = 0

/** A fresh experiment per call (the id does not hash the budget, so each pre-registration gets its own second). */
async function experiment(h: Harness, budget: ExperimentRow['budget'] = {}, spent: Partial<ExperimentRow['spent']> = {}, autoReveal = false): Promise<ExperimentRow> {
  const row = await h.ledger.createExperiment({
    hypothesis: 'h', prediction: { metric: 'm', direction: 'up' }, pack: 'fixture', gate: { name: 'gate-default', version: '0', policy_sha: sha('p') },
    budget, created_by: { channel: 'test' }, created_at: new Date(Date.UTC(2026, 7, 26, 0, 0, registered++)).toISOString(), ...(autoReveal ? { auto_reveal: true } : {}),
  })
  if (Object.keys(spent).length) return h.ledger.updateExperiment(row.id, { spent: { ...row.spent, ...spent } })
  return row
}

describe('read-only tools', () => {
  it('samsara_status: onboarding says the noise floor and the A/A control are missing, with the calibrate quote', async () => {
    const h = openHarness()
    const r = await call(h, 'samsara_status', {})
    expect(r['onboarding']).toMatchObject({ pack: 'fixture', loop: 'fake', metric: 'm', champion_id: h.championId('holdin'), noise_floor: null, aa_control: false })
    expect(r['onboarding'].calibrate).toBe('samsara_calibrate fixture/fake on holdin x3: cost unknown (12 attempts)')
    expect(r['notes']).toHaveLength(2)
    expect(r['notes'][0]).toContain('no noise floor for fixture/fake on m')
    expect(r['notes'][1]).toContain('no A/A control')
  })

  it('samsara_status: a recorded floor, an aa control row and a cost history change the onboarding; rounds and experiments link to the evidence pages', async () => {
    const h = openHarness()
    const floor = await recordFloor(h, 'holdin')
    const c = champion(h, 'holdin')
    await h.ledger.propose(challengerProposal(c.id, 'control:aa'))
    await h.ledger.recordAttempt(attempt('a-h1-0', c.id, 'h1', 0, 'holdin', 0.5))
    await h.ledger.recordAttempt(attempt('a-h2-0', c.id, 'h2', 0, 'holdin', 0.25))
    const round: RoundRow = { id: sha('round'), eval_config_sha: c.eval_config_sha, champion_id: c.id, gate: { name: 'g', version: '1', policy_sha: sha('p') }, opened_at: 'now', shadow_gates: [], k: 0, sibling_ids: [], status: 'open' }
    h.lifecycle.statusValue = { ...h.lifecycle.statusValue, rounds: [round] }
    const r = await call(h, 'samsara_status', {})
    expect(r['onboarding']).toMatchObject({ noise_floor: floor, aa_control: true, calibrate: 'samsara_calibrate fixture/fake on holdin x3 ≈ $4.50 (12 attempts)' })
    expect(r['notes']).toEqual([])
    expect(r['rounds'][0].link).toBe(`http://127.0.0.1:8080/samsara/rounds/${round.id}`)
  })

  it('samsara_status: without a pack, loop and metric the onboarding is a note', async () => {
    const h = openHarness()
    delete (h.settings as { pack?: string }).pack
    const r = await call(h, 'samsara_status', {})
    expect(r['onboarding']).toBeUndefined()
    expect(r['notes'][0]).toContain('no pack, loop or metric')
  })

  it('samsara_packs lists the packs under the packs directory', async () => {
    const h = openHarness()
    const r = await call(h, 'samsara_packs', {})
    expect(r['packs']).toEqual([{ name: 'fixture', dir: PACK, skill_dir: loadPack(PACK).skillDir, sets: { smoke: 2, holdin: 4, holdout: 4 }, holdout: { mde: 0.1, budget: 2 } }])
  })

  it('samsara_ledger_view reads through the operator viewer, filters by id and keeps the latest rows', async () => {
    const h = openHarness()
    const viewers: string[] = []
    const read = h.ledger.read.bind(h.ledger)
    h.ledger.read = ((view, viewer) => { viewers.push(viewer); return read(view, viewer) }) as typeof h.ledger.read
    const c = champion(h, 'holdin')
    for (const i of [1, 2, 3]) {
      await h.ledger.openRound({ eval_config_sha: c.eval_config_sha, champion_id: c.id, gate: { name: 'g', version: '1', policy_sha: sha('p') }, opened_at: `2026-08-26T00:00:0${i}.000Z`, shadow_gates: [], sibling_ids: [`s${i}`] })
    }
    const all = await call(h, 'samsara_ledger_view', { view: 'rounds' })
    expect(viewers).toEqual(['operator'])
    expect(all['total']).toBe(3)
    const limited = await call(h, 'samsara_ledger_view', { view: 'rounds', limit: 2 })
    expect(limited['rows'].map((r: RoundRow) => r.sibling_ids[0])).toEqual(['s2', 's3'])
    const byChallenger = await call(h, 'samsara_ledger_view', { view: 'rounds', filter: { challenger_id: 's1' } })
    expect(byChallenger['rows'].map((r: RoundRow) => r.sibling_ids[0])).toEqual(['s1'])
    const byRound = await call(h, 'samsara_ledger_view', { view: 'rounds', filter: { round_id: limited['rows'][1].id } })
    expect(byRound['total']).toBe(1)
    await expect(call(h, 'samsara_ledger_view', { view: 'attempts' })).rejects.toThrow(/invalid arguments/)
  })

  it('samsara_compare splits the promotion and the shadow rows and links the challenger page', async () => {
    const h = openHarness()
    await h.ledger.recordCompare(compare('x', 'holdin'))
    await h.ledger.recordCompare(compare('x', 'holdin', true))
    await h.ledger.recordCompare(compare('y', 'holdin'))
    const r = await call(h, 'samsara_compare', { challenger_id: 'x' })
    expect(r['promotion']).toHaveLength(1)
    expect(r['shadow']).toHaveLength(1)
    expect(r['shadow'][0].gate).toBe('other@1')
    expect(r['link']).toBe('http://127.0.0.1:8080/samsara/challengers/x')
    const noWeb = openHarness({ webServer: false })
    expect((await call(noWeb, 'samsara_compare', { challenger_id: 'x' }))['link']).toBeUndefined()
  })

  it('a service refusal reaches the agent with the errors table\'s sentence and next action, never as a bare code; any other error unchanged', async () => {
    const h = openHarness()
    h.lifecycle.nextActions = () => { throw new LifecycleError('UNKNOWN', 'no challenger x') }
    await expect(call(h, 'samsara_next_actions', { challenger_id: 'x' })).rejects.toThrow(/^no challenger x \[UNKNOWN\]\n.+\nNext: check the id with samsara_ledger_view/)
    h.lifecycle.nextActions = () => { throw new Error('plain') }
    await expect(call(h, 'samsara_next_actions', { challenger_id: 'x' })).rejects.toThrow(/^plain$/)
  })

  it('samsara_next_actions delegates to the service', async () => {
    const h = openHarness()
    const r = await call(h, 'samsara_next_actions', { challenger_id: 'x' })
    expect(r['actions']).toEqual([{ kind: 'drop' }])
    expect(h.lifecycle.asked).toEqual(['x'])
  })

  it('samsara_bench_gates benches the champion reruns on a tier', async () => {
    const h = openHarness()
    const c = champion(h, 'holdin')
    for (const task of ['h1', 'h2', 'h3', 'h4']) {
      for (const rerun of [0, 1]) {
        const id = `r-${task}-${rerun}`
        await h.ledger.recordAttempt(attempt(id, c.id, task, rerun, 'holdin'))
        await h.ledger.appendScores([score(id, rerun === 0 ? 0.5 : 0.75)])
      }
    }
    const r = await call(h, 'samsara_bench_gates', { gates: ['default'], resamples: 5, seed: 1 })
    expect(r).toMatchObject({ champion_id: c.id, tier: 'holdin', metric: 'm', tasks: 4, reruns: 2, gates: ['gate-default@0.2.0'] })
    expect(r['cells'].length).toBeGreaterThan(0)
    await expect(call(h, 'samsara_bench_gates', { tier: 'smoke' })).rejects.toThrow(/no attempts of champion/)
  })

  it('samsara_propose_dry_run asks the person (the proposer call is a spend of unknown cost), renders the view, runs the proposer, scans the patch and writes nothing to the ledger', async () => {
    const h = openHarness()
    const before = h.ledger.challengers.size
    const agent = fakeAgent()
    const r = await call(h, 'samsara_propose_dry_run', { proposer: 'fake-proposer' }, fakeExec(agent))
    expect(r).toMatchObject({ dry_run: true, cost: 'proposer cost unknown', approval: 'allowed-once', champion_id: h.championId('holdin'), scan: { ok: true, violations: [] } })
    expect(h.approval.requests).toHaveLength(1)
    expect(h.approval.requests[0]).toMatchObject({ agent, toolName: 'samsara_propose_dry_run', reason: 'samsara_propose_dry_run fixture/fake by fake-proposer: proposer call, cost unknown' })
    expect(r['proposal'].proposer.name).toBe('fake-proposer')
    expect(existsSync(r['proposal_path'])).toBe(true)
    expect(h.adapter.proposed[0]?.viewDir).toBe(r['view_dir'])
    expect(h.ledger.challengers.size).toBe(before)
    expect(r['log'].some((l: string) => l.startsWith('view rendered at'))).toBe(true)
  })

  it('samsara_propose_dry_run never runs a path, needs an agent, and a refused approval runs no proposer', async () => {
    const h = openHarness()
    await expect(call(h, 'samsara_propose_dry_run', { proposer: './bin/proposer' })).rejects.toThrow(/is a path/)
    await expect(call(h, 'samsara_propose_dry_run', { proposer: '/usr/bin/env' })).rejects.toThrow(/is a path/)
    expect(await call(h, 'samsara_propose_dry_run', { proposer: 'fake-proposer' }, fakeExec())).toMatchObject({ refused: true, code: 'NO_AGENT' })
    expect(h.approval.requests).toEqual([])
    const refused = openHarness({ approval: 'rejected' })
    expect(await call(refused, 'samsara_propose_dry_run', { proposer: 'fake-proposer' })).toMatchObject({ refused: true, code: 'NOT_APPROVED', approval: 'rejected' })
    expect(refused.adapter.proposed).toEqual([])
    expect(h.adapter.proposed).toEqual([])
  })
})

describe('spending tools', () => {
  it('refuse without an agent on the call, before anything is asked', async () => {
    const h = openHarness()
    for (const [name, args] of [
      ['samsara_calibrate', { set: 'holdin', reruns: 3 }],
      ['samsara_campaign_start', { experiment_id: 'e', proposer: 'fake-proposer', rounds: 1 }],
      ['samsara_round', { experiment_id: 'e', proposer: 'fake-proposer' }],
      ['samsara_control', { kind: 'aa' }],
      ['samsara_campaign_stop', { job_id: 'samsara-campaign-1' }],
    ] as const) {
      expect(await call(h, name, args, fakeExec())).toMatchObject({ refused: true, code: 'NO_AGENT' })
    }
    expect(h.approval.requests).toEqual([])
    expect(h.jobs.started).toEqual([])
  })

  describe('samsara_calibrate', () => {
    it('quotes the cost, asks the person, and runs the calibration as a job the agent owns', async () => {
      const h = openHarness()
      const c = champion(h, 'holdin')
      await h.ledger.recordAttempt(attempt('a-h1-0', c.id, 'h1', 0, 'holdin', 0.5))
      const agent = fakeAgent()
      const exec = fakeExec(agent)
      const r = await call(h, 'samsara_calibrate', { set: 'holdin', reruns: 3 }, exec)
      expect(r).toMatchObject({ job_id: 'samsara-calibrate-1', champion_id: c.id, approval: 'allowed-once', quote: 'calibrate fixture/fake on holdin x3 ≈ $6.00 (12 attempts)' })
      expect(h.approval.requests).toEqual([{ agent, toolName: 'samsara_calibrate', callId: 'call-1', reason: r['quote'], signal: exec.signal }])
      const job = h.jobs.started[0]!
      expect(job.spec).toMatchObject({ kind: 'samsara-calibrate', owner: agent, label: r['quote'] })
      const done = await job.hooks.done
      expect(done).toEqual({ status: 'completed', detail: `noise floor ${sha('floor')}: sd_paired 0.1234 (3 reruns x 4 tasks on holdin)` })
      expect(job.hooks.readOutput!()).toBe('calibrating\n')
      expect(job.hooks.readOutput!()).toBe('')
      expect(h.lifecycle.calibrated[0]).toMatchObject({ pack: PACK, metric: 'm', set: 'holdin', reruns: 3, run: { maxTurns: 50, maxMinutes: 20, route: ROUTE } })
      // the settled outcome (the sd the agent reports) is on the notebook, bound to the session and the quote; the tag is gone with the job
      expect(h.ledger.notebook).toHaveLength(1)
      const row = h.ledger.notebook[0]!
      expect(row).toMatchObject({
        kind: 'job/done', name: 'samsara-calibrate', session_id: 'op-1', seq: 0, args_sha: sha256(canonicalJson(r['quote'])),
        result_sha: sha256(canonicalJson({ status: 'completed', detail: done.detail })), operator: { provider: 'p', model: 'operator-model' },
      })
      expect(row.round_id).toBeUndefined()
      expect(row.experiment_id).toBeUndefined()
      expect(row.id).toBe(notebookId(row))
      expect(jobTags.has(job.id)).toBe(false)
    })

    it('refuses when the person rejects, or nobody can answer; nothing starts', async () => {
      for (const outcome of ['rejected', 'unavailable', 'cancelled'] as const) {
        const h = openHarness({ approval: outcome })
        const r = await call(h, 'samsara_calibrate', { set: 'holdin', reruns: 3 })
        expect(r).toMatchObject({ refused: true, code: 'NOT_APPROVED', approval: outcome })
        expect(h.jobs.started).toEqual([])
        expect(h.lifecycle.calibrated).toEqual([])
      }
    })

    it('refuses fewer than 3 reruns before asking (S1)', async () => {
      const h = openHarness()
      await expect(call(h, 'samsara_calibrate', { set: 'holdin', reruns: 2 })).rejects.toThrow(/at least 3 reruns/)
      expect(h.approval.requests).toEqual([])
    })

    it('withdraws the question with the call\'s signal: a grant that lands after the turn was cancelled starts nothing', async () => {
      const h = openHarness()
      const ac = new AbortController()
      h.approval.pending = (req) => { expect(req.signal).toBe(ac.signal); ac.abort('turn cancelled') }
      const r = await call(h, 'samsara_calibrate', { set: 'holdin', reruns: 3 }, fakeExec(fakeAgent(), ac.signal))
      expect(r).toMatchObject({ refused: true, code: 'NOT_APPROVED', approval: 'cancelled' })
      expect(r['message']).toContain('cancelled')
      expect(h.jobs.started).toEqual([])
      expect(h.lifecycle.calibrated).toEqual([])
    })
  })

  describe('samsara_campaign_start', () => {
    it('starts the campaign as a job with the operator on the round, the events as output and the consent to ask for as the completion notice', async () => {
      const h = openHarness()
      await recordFloor(h, 'holdin')
      const e = await experiment(h, { rounds: 3 })
      h.lifecycle.campaignResult = { paused: 'consent', action: 'promote', roundId: sha('round'), candidate: 'cand', rounds: [], promoted: [] }
      const agent = fakeAgent()
      const r = await call(h, 'samsara_campaign_start', { experiment_id: e.id, proposer: 'fake-proposer', rounds: 2, shadow_gates: ['other@1'] }, fakeExec(agent))
      expect(r).toMatchObject({ job_id: 'samsara-campaign-1', experiment_id: e.id, champion_id: h.championId('holdin'), approval: 'allowed-once', link: `http://127.0.0.1:8080/samsara/experiments/${e.id}` })
      // the person confirms the shadow gates too
      expect(r['quote']).toBe(`2 round(s) on experiment ${e.id.slice(0, 12)}: fixture/fake by fake-proposer shadow other@1: cost unknown (20 attempts)`)
      const job = h.jobs.started[0]!
      expect(job.spec).toMatchObject({ kind: 'samsara-campaign', owner: agent })
      const done = await job.hooks.done
      expect(done.status).toBe('completed')
      expect(done.detail).toContain('paused: a promote consent is needed for cand')
      expect(done.detail).toContain('/samsara approve cand')
      expect(job.hooks.readOutput!()).toMatch(/^round [0-9a-f]{12} opened: champion /)
      // the job/done row names the experiment and the round the job opened; the tag (for /samsara stop <round-id>) is gone with the job
      expect(h.ledger.notebook).toMatchObject([{ kind: 'job/done', name: 'samsara-campaign', session_id: 'op-1', experiment_id: e.id, round_id: sha('round'), result_sha: sha256(canonicalJson({ status: 'completed', detail: done.detail })) }])
      expect(jobTags.has(job.id)).toBe(false)
      const { input } = h.lifecycle.campaigns[0]!
      expect(input).toMatchObject({
        experimentId: e.id, pack: PACK, metric: 'm', set: 'holdin', autoHoldout: false, nEffFloor: 3, shadowGates: ['other@1'],
        tiers: { holdin: { repeat: 1 }, holdout: { repeat: 1 } }, stop: { maxRounds: 2, maxConsecutiveHolds: 2, stopOnPromote: false },
        proposer: { name: 'fake-proposer', version: '1', configSha: h.adapter.configSha },
        operator: { session_id: 'op-1', provider: 'p', model: 'operator-model' },
        // a proposer that declares no route (command, human) is 'unknown' to the service's own check
        proposerRoute: 'unknown',
      })
      expect(input.champion().proposal.parent_ids).toEqual([])
    })

    it('passes the route the proposer declares to the service, which refuses every round the operator would propose for itself', async () => {
      const h = openHarness({ adapterModel: 'another-model', adapterProvider: 'q' })
      await recordFloor(h, 'holdin')
      const e = await experiment(h)
      await call(h, 'samsara_campaign_start', { experiment_id: e.id, proposer: 'fake-proposer', rounds: 1 })
      expect(h.lifecycle.campaigns[0]!.input.proposerRoute).toEqual({ model: 'another-model', provider: 'q' })
      // the service's refusal settles the job with the sentence and the next action
      h.lifecycle.campaign = async () => { throw new LifecycleError('OPERATOR_IS_PROPOSER', 'the operator session runs on another-model') }
      await call(h, 'samsara_campaign_start', { experiment_id: e.id, proposer: 'fake-proposer', rounds: 1 })
      const done = await h.jobs.started[1]!.hooks.done
      expect(done.status).toBe('failed')
      expect(done.detail).toMatch(/^the operator session runs on another-model \[OPERATOR_IS_PROPOSER\]\n.+\nNext: choose a proposer on another model/)
    })

    it('the approval states a pre-registered auto_reveal: the person confirms that no /samsara reveal is asked per round', async () => {
      const h = openHarness()
      await recordFloor(h, 'holdin')
      const plain = await experiment(h)
      const auto = await experiment(h, {}, {}, true)
      expect(auto.id).not.toBe(plain.id)
      await call(h, 'samsara_campaign_start', { experiment_id: auto.id, proposer: 'fake-proposer', rounds: 2 })
      await call(h, 'samsara_round', { experiment_id: plain.id, proposer: 'fake-proposer' })
      expect(h.approval.requests.map((r) => r.reason)).toEqual([
        `2 round(s) on experiment ${auto.id.slice(0, 12)}: fixture/fake by fake-proposer, held-out reveal pre-registered (auto_reveal: no /samsara reveal per round): cost unknown (20 attempts)`,
        `one round on experiment ${plain.id.slice(0, 12)}: fixture/fake by fake-proposer: cost unknown (10 attempts)`,
      ])
      // the reveal stays the person's either way: never an argument of the agent's
      expect(h.lifecycle.campaigns.map((c) => c.input.autoHoldout)).toEqual([false, false])
    })

    it('while it runs the job is tagged with its experiment and rounds; killed, it settles on the notebook and the tag goes', async () => {
      const h = openHarness()
      await recordFloor(h, 'holdin')
      const e = await experiment(h, { rounds: 3 })
      h.lifecycle.campaignWaits = true
      const agent = fakeAgent(OPERATOR_ROUTE, 'op-1', 7)
      await call(h, 'samsara_campaign_start', { experiment_id: e.id, proposer: 'fake-proposer', rounds: 2 }, fakeExec(agent))
      const job = h.jobs.started[0]!
      expect(jobTags.get(job.id)).toEqual({ experiment_id: e.id, round_ids: [sha('round')] })
      expect(h.ledger.notebook).toEqual([])
      h.jobs.kill(job.id, agent, 'enough')
      const done = await job.hooks.done
      expect(done.detail).toContain('stopped: aborted')
      expect(h.ledger.notebook).toMatchObject([{ kind: 'job/done', name: 'samsara-campaign', seq: 7, experiment_id: e.id, round_id: sha('round'), result_sha: sha256(canonicalJson({ status: done.status, detail: done.detail })) }])
      expect(jobTags.has(job.id)).toBe(false)
    })

    it('the agent cannot waive the holdout_reveal consent: auto_holdout is no argument, and the campaign never runs with it', async () => {
      const h = openHarness()
      await recordFloor(h, 'holdin')
      const e = await experiment(h)
      for (const name of ['samsara_campaign_start', 'samsara_round']) {
        expect(Object.keys((h.tools.get(name)!.parameters as { properties: object }).properties)).not.toContain('auto_holdout')
      }
      await call(h, 'samsara_campaign_start', { experiment_id: e.id, proposer: 'fake-proposer', rounds: 1, auto_holdout: true })
      await call(h, 'samsara_round', { experiment_id: e.id, proposer: 'fake-proposer', auto_holdout: true })
      expect(h.lifecycle.campaigns.map((c) => c.input.autoHoldout)).toEqual([false, false])
    })

    it('a holdout_reveal pause names the reveal command with the candidate, the subject the campaign reads the consent under', async () => {
      const h = openHarness()
      await recordFloor(h, 'holdin')
      const e = await experiment(h)
      h.lifecycle.campaignResult = { paused: 'consent', action: 'holdout_reveal', roundId: 'r1', candidate: 'cand', rounds: [], promoted: [] }
      await call(h, 'samsara_campaign_start', { experiment_id: e.id, proposer: 'fake-proposer', rounds: 1 })
      const detail = (await h.jobs.started[0]!.hooks.done).detail!
      expect(detail).toContain('/samsara reveal cand')
      expect(detail).not.toContain('/samsara reveal r1')
    })

    it('refuses over the experiment budget before asking', async () => {
      const h = openHarness()
      await recordFloor(h, 'holdin')
      const spentRounds = await experiment(h, { rounds: 1 }, { rounds: 1 })
      expect(await call(h, 'samsara_campaign_start', { experiment_id: spentRounds.id, proposer: 'fake-proposer', rounds: 1 })).toMatchObject({ refused: true, code: 'BUDGET_EXCEEDED' })
      // the quote exceeds what is left in usd
      const c = champion(h, 'holdin')
      await h.ledger.recordAttempt(attempt('a-h1-0', c.id, 'h1', 0, 'holdin', 1))
      const tight = await experiment(h, { usd: 5 }, { usd: 1 })
      const r = await call(h, 'samsara_campaign_start', { experiment_id: tight.id, proposer: 'fake-proposer', rounds: 1 })
      expect(r).toMatchObject({ refused: true, code: 'BUDGET_EXCEEDED' })
      expect(r['message']).toContain('4.00 usd left of 5')
      expect(h.approval.requests).toEqual([])
      expect(h.jobs.started).toEqual([])
    })

    it('refuses without a noise floor, quoting the calibration', async () => {
      const h = openHarness()
      const e = await experiment(h)
      const r = await call(h, 'samsara_campaign_start', { experiment_id: e.id, proposer: 'fake-proposer', rounds: 1 })
      expect(r).toMatchObject({ refused: true, code: 'NO_NOISE_FLOOR' })
      expect(r['message']).toContain('samsara_calibrate fixture/fake on holdin x3')
      expect(r['message']).toMatch(/\[NO_NOISE_FLOOR\]\n.+\nNext: calibrate first: samsara_calibrate fixture\/fake on holdin x3/)
      expect(h.approval.requests).toEqual([])
    })

    it('refuses when the operator runs on the model the proposer declares', async () => {
      const h = openHarness({ adapterModel: OPERATOR_ROUTE.model })
      await recordFloor(h, 'holdin')
      const e = await experiment(h)
      const r = await call(h, 'samsara_campaign_start', { experiment_id: e.id, proposer: 'fake-proposer', rounds: 1 })
      expect(r).toMatchObject({ refused: true, code: 'OPERATOR_IS_PROPOSER' })
      expect(h.approval.requests).toEqual([])
      // the same model under another provider passes; the same model spelled differently does not
      const provider = openHarness({ adapterModel: OPERATOR_ROUTE.model, adapterProvider: 'other-provider' })
      await recordFloor(provider, 'holdin')
      const e3 = await experiment(provider)
      expect(await call(provider, 'samsara_campaign_start', { experiment_id: e3.id, proposer: 'fake-proposer', rounds: 1 })).toMatchObject({ job_id: 'samsara-campaign-1' })
      const spelled = openHarness({ adapterModel: ` ${OPERATOR_ROUTE.model.toUpperCase()} ` })
      await recordFloor(spelled, 'holdin')
      const e4 = await experiment(spelled)
      expect(await call(spelled, 'samsara_campaign_start', { experiment_id: e4.id, proposer: 'fake-proposer', rounds: 1 })).toMatchObject({ refused: true, code: 'OPERATOR_IS_PROPOSER' })
      // another model, or an adapter that declares nothing (command, human), passes
      const other = openHarness({ adapterModel: 'another-model' })
      await recordFloor(other, 'holdin')
      const e2 = await experiment(other)
      expect(await call(other, 'samsara_campaign_start', { experiment_id: e2.id, proposer: 'fake-proposer', rounds: 1 })).toMatchObject({ job_id: 'samsara-campaign-1' })
    })

    it('refuses the model proposer that declares no model, and an operator whose route is unknown: a check that cannot run is not a pass', async () => {
      const undeclared = openHarness({ adapterName: CLAUDE_P_NAME })
      await recordFloor(undeclared, 'holdin')
      const e = await experiment(undeclared)
      const r = await call(undeclared, 'samsara_campaign_start', { experiment_id: e.id, proposer: CLAUDE_P_NAME, rounds: 1 })
      expect(r).toMatchObject({ refused: true, code: 'OPERATOR_IS_PROPOSER' })
      expect(r['message']).toContain('declares no model')
      expect(undeclared.approval.requests).toEqual([])
      const blind = openHarness({ adapterModel: 'another-model' })
      await recordFloor(blind, 'holdin')
      const e2 = await experiment(blind)
      const noRoute = { id: SessionId('op-1'), session: { requestContext: () => undefined } } as never
      const r2 = await call(blind, 'samsara_campaign_start', { experiment_id: e2.id, proposer: 'fake-proposer', rounds: 1 }, fakeExec(noRoute))
      expect(r2).toMatchObject({ refused: true, code: 'OPERATOR_IS_PROPOSER' })
      expect(r2['message']).toContain('route is unknown')
      expect(blind.jobs.started).toEqual([])
    })

    it('refuses an unknown experiment or proposer as an error', async () => {
      const h = openHarness()
      await expect(call(h, 'samsara_campaign_start', { experiment_id: 'nope', proposer: 'fake-proposer', rounds: 1 })).rejects.toThrow(/no experiment nope/)
      const e = await experiment(h)
      await expect(call(h, 'samsara_campaign_start', { experiment_id: e.id, proposer: 'nope', rounds: 1 })).rejects.toThrow(/no proposer named "nope"/)
    })

    it('a rejected approval starts nothing', async () => {
      const h = openHarness({ approval: 'rejected' })
      await recordFloor(h, 'holdin')
      const e = await experiment(h)
      expect(await call(h, 'samsara_campaign_start', { experiment_id: e.id, proposer: 'fake-proposer', rounds: 1 })).toMatchObject({ refused: true, code: 'NOT_APPROVED', approval: 'rejected' })
      expect(h.jobs.started).toEqual([])
      expect(h.lifecycle.campaigns).toEqual([])
    })
  })

  it('samsara_round is one round that stops on a promotion', async () => {
    const h = openHarness()
    await recordFloor(h, 'holdin')
    const e = await experiment(h)
    const r = await call(h, 'samsara_round', { experiment_id: e.id, proposer: 'fake-proposer' })
    expect(r).toMatchObject({ job_id: 'samsara-round-1', experiment_id: e.id })
    expect(r['quote']).toMatch(/^one round on experiment /)
    expect((await h.jobs.started[0]!.hooks.done).detail).toBe('stopped: max_rounds; 0 round(s); promoted (none)')
    expect(h.lifecycle.campaigns[0]!.input.stop).toEqual({ maxRounds: 1, maxConsecutiveHolds: 1, stopOnPromote: true })
  })

  describe('samsara_control', () => {
    it('runs an A/A control as a job with the operator on the round', async () => {
      const h = openHarness()
      await recordFloor(h, 'holdout')
      const agent = fakeAgent()
      const r = await call(h, 'samsara_control', { kind: 'aa' }, fakeExec(agent))
      expect(r).toMatchObject({ job_id: 'samsara-control-1', champion_id: h.championId('holdout'), approval: 'allowed-once', quote: 'control aa on fixture/fake at holdout x1: cost unknown (4 attempts)' })
      expect(h.approval.requests[0]).toMatchObject({ agent, toolName: 'samsara_control', reason: r['quote'] })
      const job = h.jobs.started[0]!
      expect(job.spec).toMatchObject({ kind: 'samsara-control', owner: agent })
      expect((await job.hooks.done).detail).toBe(`control aa: hold (hold:ci) mean 0.010 ci [-0.100, 0.120] n_eff 4; challenger ${sha('control')} round ${sha('round')}`)
      expect(h.lifecycle.controls[0]!.input).toMatchObject({ kind: 'aa', pack: PACK, metric: 'm', repeat: 1, operator: { session_id: 'op-1', provider: 'p', model: 'operator-model' } })
      expect(h.lifecycle.controls[0]!.input.skillDir).toBeUndefined()
    })

    it('inject needs a skill directory; charged to an experiment it checks the budget; without a floor it refuses', async () => {
      const h = openHarness()
      await expect(call(h, 'samsara_control', { kind: 'inject' })).rejects.toThrow(/skill_dir/)
      expect(await call(h, 'samsara_control', { kind: 'aa' })).toMatchObject({ refused: true, code: 'NO_NOISE_FLOOR' })
      await recordFloor(h, 'holdout')
      const spent = await experiment(h, { holdout_reveals: 1 }, { holdout_reveals: 1 })
      expect(await call(h, 'samsara_control', { kind: 'aa', experiment_id: spent.id })).toMatchObject({ refused: true, code: 'BUDGET_EXCEEDED' })
      expect(h.approval.requests).toEqual([])
      const open = await experiment(h, { holdout_reveals: 2 })
      const r = await call(h, 'samsara_control', { kind: 'inject', skill_dir: loadPack(PACK).skillDir, experiment_id: open.id })
      expect(r).toMatchObject({ job_id: 'samsara-control-1', experiment_id: open.id })
      // the person confirms the directory that is judged on the held-out set
      expect(r['quote']).toBe(`control inject of ${loadPack(PACK).skillDir} on fixture/fake at holdout x1: cost unknown (4 attempts)`)
      expect(h.lifecycle.controls[0]!.input).toMatchObject({ kind: 'inject', skillDir: loadPack(PACK).skillDir, experimentId: open.id })
      await h.jobs.started[0]!.hooks.done
      expect(h.ledger.notebook).toMatchObject([{ kind: 'job/done', name: 'samsara-control', experiment_id: open.id, round_id: sha('round') }])
    })

    it('inject runs a directory under the pack only: a run\'s output (a dry-run proposal) is refused before anyone is asked', async () => {
      const h = openHarness()
      await recordFloor(h, 'holdout')
      const outside = mkdtempSync(join(tmpdir(), 'samsara-inject-'))
      await expect(call(h, 'samsara_control', { kind: 'inject', skill_dir: outside })).rejects.toThrow(/under the pack/)
      await expect(call(h, 'samsara_control', { kind: 'inject', skill_dir: join(PACK, '..', 'elsewhere') })).rejects.toThrow(/under the pack/)
      expect(h.approval.requests).toEqual([])
      expect(h.jobs.started).toEqual([])
    })
  })

  describe('samsara_campaign_stop', () => {
    it('kills a job the session owns and refuses another session\'s', async () => {
      const h = openHarness()
      await recordFloor(h, 'holdin')
      const e = await experiment(h)
      h.lifecycle.campaignWaits = true
      const agent = fakeAgent()
      const started = await call(h, 'samsara_campaign_start', { experiment_id: e.id, proposer: 'fake-proposer', rounds: 1 }, fakeExec(agent))
      const other = fakeAgent(OPERATOR_ROUTE, 'op-2')
      expect(await call(h, 'samsara_campaign_stop', { job_id: started['job_id'] }, fakeExec(other))).toMatchObject({ refused: true, code: 'NOT_OWNER' })
      expect(await call(h, 'samsara_campaign_stop', { job_id: 'nope' }, fakeExec(agent))).toMatchObject({ refused: true, code: 'NOT_OWNER' })
      expect(await call(h, 'samsara_campaign_stop', { job_id: started['job_id'] }, fakeExec(agent))).toEqual({ job_id: started['job_id'], result: 'requested' })
      expect(h.jobs.killed).toEqual([{ id: started['job_id'], reason: 'stopped by the operator' }])
      expect(await h.jobs.started[0]!.hooks.done).toEqual({ status: 'completed', detail: 'stopped: aborted; 0 round(s); promoted (none)' })
      expect(h.approval.requests).toHaveLength(1)
    })
  })
})

describe('operator and proposer routes', () => {
  it('operatorOf reads the session id and the route the session runs on', () => {
    expect(operatorOf(fakeAgent())).toEqual({ session_id: 'op-1', provider: 'p', model: 'operator-model' })
    expect(operatorOf({ id: SessionId('op-1'), session: { requestContext: () => undefined } } as never)).toEqual({ session_id: 'op-1' })
  })

  it('proposerRouteOf reads the route an adapter configures, and "unknown" from any adapter that declares none (the model proposer without a model, a command proposer)', () => {
    expect(proposerRouteOf(new FakeAdapter({ model: 'x' }))).toEqual({ model: 'x' })
    expect(proposerRouteOf(new FakeAdapter({ model: 'x', provider: 'p' }))).toEqual({ model: 'x', provider: 'p' })
    expect(proposerRouteOf(new FakeAdapter({}, CLAUDE_P_NAME))).toBe('unknown')
    expect(proposerRouteOf(new FakeAdapter())).toBe('unknown')
  })

  it('sameRoute is the service\'s: normalized (provider, model) pairs, the provider only when both name one', () => {
    expect(sameRoute({ provider: 'p', model: 'm' }, { model: 'm' })).toBe(true)
    expect(sameRoute({ provider: 'p', model: ' M ' }, { model: 'm', provider: 'P' })).toBe(true)
    expect(sameRoute({ provider: 'p', model: 'm' }, { model: 'm', provider: 'q' })).toBe(false)
    expect(sameRoute({ provider: 'p', model: 'm' }, { model: 'n' })).toBe(false)
    expect(sameRoute({}, { model: 'm' })).toBe(false)
  })
})

describe('the attempt executor', () => {
  it('is the host plane\'s: it survives the disposal of an operator session\'s tools row', async () => {
    const ctx = new Context()
    const h = openHarness()
    ctx.provide('tools', new FakeTools())
    for (const key of ['lifecycle', 'ledger', 'jobs', 'approval', 'loops', 'proposers'] as const) ctx.provide(key, h.deps[key])
    const config = { packsDir: PACKS_DIR, out: h.out }
    // a session's tools row provides no executor of its own
    const first = ctx.plugin({ name: 'workbench-tools', inject: toolsInject, apply: applyTools }, config)
    await first
    expect(ctx.get('executor')).toBeUndefined()
    await ctx.plugin({ name: 'workbench-executor', apply: applyExecutor })
    expect(ctx.get('executor')).toMatchObject({ runSet: expect.any(Function) })
    const second = ctx.plugin({ name: 'workbench-tools', inject: toolsInject, apply: applyTools }, config)
    await second
    await first.dispose()
    expect(ctx.get('executor')).toMatchObject({ runSet: expect.any(Function) })
    await second.dispose()
    expect(ctx.get('executor')).toMatchObject({ runSet: expect.any(Function) })
  })
})
