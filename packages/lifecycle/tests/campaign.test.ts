import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { gateDefault, type CompareRequest, type GatePolicyProvider, type Verdict } from '@oldbulb/samsara-gate'
import { challengerId, type ChallengerProposal, type ConsentRow, type Tier } from '@oldbulb/samsara-ledger'
import { campaignHistory, gateRefOf, roundPolicy, writeHistory, LifecycleError, type CampaignEvent, type CampaignHooks, type CampaignInput, type CampaignProposal, type LifecycleEvent, type ViewInput } from '../src/index.ts'
import { championProposal, consent, openLifecycle, runOptions, PACK, sha, type Harness } from './fakes.ts'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function out(): string {
  const d = mkdtempSync(join(tmpdir(), 'samsara-campaign-'))
  dirs.push(d)
  return d
}

const code = (c: LifecycleError['code']) => expect.objectContaining({ name: 'LifecycleError', code: c })

// ----------------------------------------------------------------- fakes

/** Content hash of a directory: what the runner's hashDir stands for here. */
export function hashDirOf(dir: string): string {
  const files: string[] = []
  const walk = (d: string) => { for (const name of readdirSync(d).sort()) { const p = join(d, name); statSync(p).isDirectory() ? walk(p) : files.push(p) } }
  walk(dir)
  const h = createHash('sha256')
  for (const f of files) h.update(relative(dir, f)).update('\0').update(readFileSync(f)).update('\0')
  return h.digest('hex')
}

/** The runner's renderView, reduced to the files the campaign touches. */
export function renderView(dir: string, input: ViewInput): void {
  mkdirSync(dir, { recursive: true })
  cpSync(input.championSkillDir, resolve(dir, 'champion-skill'), { recursive: true })
  writeFileSync(resolve(dir, 'champion.json'), JSON.stringify({ challenger_id: input.championId, skill: 'champion-skill/', metric: input.metric }) + '\n')
  writeFileSync(resolve(dir, 'tasks.jsonl'), input.tasks.map((t) => JSON.stringify(t)).join('\n') + '\n')
  writeFileSync(resolve(dir, 'view.json'), JSON.stringify({ view_version: 1, champion_id: input.championId, metric: input.metric, files: ['champion.json', 'champion-skill', 'tasks.jsonl'] }, null, 2) + '\n')
}

/** Copies the champion skill and appends a line per call, so every round proposes a different skill. */
class FakeProposer {
  readonly name = 'fake'
  readonly version = '1'
  readonly configSha = sha('fake')
  calls: { viewDir: string; workDir: string; parent: string }[] = []
  predictions: string[] = []
  async propose(input: { viewDir: string; workDir: string; signal: AbortSignal; parent: string }): Promise<CampaignProposal> {
    this.calls.push({ viewDir: input.viewDir, workDir: input.workDir, parent: input.parent })
    const skill = resolve(input.workDir, 'skill')
    cpSync(resolve(input.viewDir, 'champion-skill'), skill, { recursive: true })
    writeFileSync(resolve(skill, 'SKILL.md'), `# skill ${this.calls.length}\n`)
    return {
      surface: 'skill', patch: { surface: 'skill', skill_dir: 'skill' }, intent: `try ${this.calls.length}`,
      prediction: { metric: 'm', direction: 'up', predicted_fixes: this.predictions },
      proposer: { name: this.name, version: this.version, config_sha: this.configSha },
    }
  }
}

/** gate-default's statistics with the verdict per tier taken from a script (one entry per judgement, then gate-default's own). */
function scriptedGate(script: Partial<Record<Tier, Verdict[]>>): GatePolicyProvider {
  return {
    name: 'gate-script',
    version: 'test',
    judge: (req: CompareRequest) => {
      const j = gateDefault(req)
      const v = script[req.tier]?.shift()
      if (v === undefined) return j
      return { compare: { ...j.compare, ruleFired: v === 'hold:underpowered' ? 'power:script' : v }, verdict: v }
    },
  }
}

const SCRIPT = 'gate-script@test'

interface Setup {
  h: Harness
  proposer: FakeProposer
  events: CampaignEvent[]
  controller: AbortController
  consents: { action: string; subject: string }[]
  /** What the consent hook answers; a function returning undefined pauses. */
  grant: (action: string, subject: string, roundId: string) => ConsentRow | undefined
  experimentId: string
  input: CampaignInput
  hooks: CampaignHooks
  dir: string
}

async function setup(over: { script?: Partial<Record<Tier, Verdict[]>>; budget?: Record<string, number>; input?: Partial<CampaignInput>; calibrate?: boolean } = {}): Promise<Setup> {
  const h = await openLifecycle({ gate: [scriptedGate(over.script ?? {})] })
  h.ledger.consents.push(consent(SCRIPT, 'gate_change'))
  const dir = out()
  const nEffFloor = 1
  if (over.calibrate !== false) {
    await h.lifecycle.calibrate({ pack: PACK, champion: championProposal(), metric: 'm', set: 'holdout', reruns: 3, run: runOptions(join(dir, 'calibrate')) })
  }
  const exp = await h.lifecycle.preregister({
    hypothesis: 'h', prediction: { metric: 'm', direction: 'up' }, pack: 'fixture', gate: gateRefOf(scriptedGate({}), roundPolicy(nEffFloor, 0.1)),
    budget: over.budget ?? {}, created_by: { channel: 'test' },
  })
  const proposer = new FakeProposer()
  const events: CampaignEvent[] = []
  const controller = new AbortController()
  const consents: { action: string; subject: string }[] = []
  const s: Setup = {
    h, proposer, events, controller, consents, experimentId: exp.id, dir,
    grant: (action, subject, roundId) => {
      const row = consent(subject, action as ConsentRow['action'], `${action}-${subject.slice(0, 6)}`, action === 'promote' ? roundId : undefined)
      h.ledger.consents.push(row)
      return row
    },
    input: {
      experimentId: exp.id, pack: PACK, metric: 'm', nEffFloor, set: 'holdin', proposer,
      // The runner's championProposal for the state served: the kept skill after a promotion, the pack's before.
      champion: () => {
        const kept = h.champion.state.kept.at(-1)
        if (!kept) return { proposal: championProposal(), skillDir: resolve(PACK, 'skill') }
        const row = h.ledger.challenger(kept.challenger_id)!
        return { proposal: championProposal({ skill_sha: row.skill_sha, patch: { skill_ref: `skill:${row.skill_sha}` } }), skillDir: row.patch.skill_ref! }
      },
      tiers: { holdin: { repeat: 1 }, holdout: { repeat: 1 } },
      stop: { maxRounds: 5, maxConsecutiveHolds: 3, stopOnPromote: true },
      autoHoldout: true,
      out: join(dir, 'campaign'),
      run: { maxTurns: 5, maxMinutes: 1, route: { provider: 'p', model: 'm', credentialRef: 'cred' } },
      ...over.input,
    },
    hooks: {
      onEvent: (e) => { events.push(e) },
      signal: controller.signal,
      consent: async (action, subject, roundId) => { consents.push({ action, subject }); return s.grant(action, subject, roundId) },
      renderView,
      hashDir: hashDirOf,
    },
  }
  return s
}

const kinds = (events: CampaignEvent[]) => events.filter((e) => e.kind !== 'attempt:progress').map((e) => e.kind)

// ------------------------------------------------------------- campaign

describe('campaign', () => {
  it('promotes in round 1 and stops on the promotion: the view, the history, the proposal, the round and the spend are on disk and on the ledger', async () => {
    const s = await setup({ script: { holdin: ['hold'], holdout: ['promote'] } })
    const result = await s.h.lifecycle.campaign(s.input, s.hooks)
    expect(result).toMatchObject({ stopped: 'promoted', promoted: [expect.any(String)] })
    if (result.paused) throw new Error('paused')
    const [round] = result.rounds
    expect(round).toMatchObject({ tier: 'holdout', verdict: 'promote', promoted: result.promoted[0], challengerId: result.promoted[0] })
    expect(kinds(s.events)).toEqual(['round:opened', 'judged', 'judged', 'judged', 'decided', 'stopped'])
    expect(s.events.filter((e) => e.kind === 'judged').map((e) => e.kind === 'judged' && e.tier)).toEqual(['smoke', 'holdin', 'holdout'])
    expect(s.consents).toEqual([{ action: 'promote', subject: result.promoted[0] }])
    expect(s.h.champion.promoted).toEqual([[result.promoted[0], `promote-${result.promoted[0]!.slice(0, 6)}`]])

    // The round row, the challenger row and the experiment's accounting.
    const row = s.h.ledger.round(round!.roundId)!
    expect(row).toMatchObject({ status: 'decided', experiment_id: s.experimentId, k: 1, outcome: { promoted: result.promoted[0] } })
    const challenger = s.h.ledger.challenger(result.promoted[0]!)!
    expect(challenger).toMatchObject({ status: 'decided', intent: 'try 1', parent_ids: [row.champion_id], optimizer_config_sha: sha('fake'), prediction: { metric: 'm' } })
    expect(challenger.skill_sha).toBe(hashDirOf(challenger.patch.skill_ref!))
    const experiment = s.h.ledger.experiment(s.experimentId)!
    expect(experiment.round_ids).toEqual([row.id])
    // smoke 2 + holdin 4 + holdout 4 challenger attempts, and the champion's smoke 2 + holdin 4 (its holdout ones came from the calibration).
    expect(experiment.spent).toEqual({ usd: expect.closeTo(0.16, 9), attempts: 16, rounds: 1, holdout_reveals: 1 })
    expect(s.events.at(-1)).toMatchObject({ kind: 'stopped', reason: 'promoted', spent: experiment.spent })

    // The view the proposer saw: the runner's files plus an empty history listed in view.json; its proposal beside it.
    const roundOut = join(s.input.out, row.id.slice(0, 12))
    const [call] = s.proposer.calls
    expect(call).toMatchObject({ viewDir: join(roundOut, 'view'), workDir: join(roundOut, 'proposer'), parent: row.champion_id })
    expect(readFileSync(join(call!.viewDir, 'history.jsonl'), 'utf8')).toBe('')
    expect(JSON.parse(readFileSync(join(call!.viewDir, 'view.json'), 'utf8')).files).toEqual(['champion.json', 'champion-skill', 'tasks.jsonl', 'history.jsonl'])
    expect(JSON.parse(readFileSync(join(roundOut, 'proposal.json'), 'utf8'))).toMatchObject({ intent: 'try 1' })
    expect(s.h.executor.calls.map((c) => c.req.out)).toEqual([
      join(s.dir, 'calibrate', 'calibrate-0'), join(s.dir, 'calibrate', 'calibrate-1'), join(s.dir, 'calibrate', 'calibrate-2'),
      join(roundOut, 'smoke-x1', 'champion'), join(roundOut, 'smoke-x1', 'challenger'),
      join(roundOut, 'holdin-x1', 'champion'), join(roundOut, 'holdin-x1', 'challenger'),
      join(roundOut, 'holdout-x1', 'challenger'),
    ])
  })

  it('forwards every hook event on lifecycle/event under the experiment, and announces the consent the hook records', async () => {
    const s = await setup({ script: { holdin: ['hold'], holdout: ['promote'] } })
    const events: LifecycleEvent[] = []
    s.h.lifecycle.on('lifecycle/event', (e) => { events.push(e) })
    const result = await s.h.lifecycle.campaign(s.input, s.hooks)
    if (result.paused) throw new Error('paused')
    const forwarded = events.filter((e) => e.kind === 'campaign')
    expect(forwarded.map((e) => e.kind === 'campaign' && e.event)).toEqual(s.events)
    const roundId = result.rounds[0]!.roundId
    for (const e of forwarded) {
      expect(e).toMatchObject({ experimentId: s.experimentId, at: expect.stringMatching(/^\d{4}-/), ...(e.event.kind === 'stopped' ? {} : { roundId }) })
    }
    expect(forwarded.at(-1)).not.toHaveProperty('roundId')
    const [promoted] = result.promoted
    expect(events.filter((e) => e.kind === 'consent/recorded')).toEqual([{ kind: 'consent/recorded', id: `promote-${promoted!.slice(0, 6)}`, action: 'promote', at: expect.any(String) }])
    // The consent lands before the decision it unlocks.
    expect(events.findIndex((e) => e.kind === 'consent/recorded')).toBeLessThan(events.findIndex((e) => e.kind === 'round/decided'))
  })

  it('continues past a promotion when stopOnPromote is off: the next round anchors on the new champion, which has no noise floor yet', async () => {
    const s = await setup({ script: { holdin: ['hold', 'hold'], holdout: ['promote'] }, input: { stop: { maxRounds: 3, maxConsecutiveHolds: 3, stopOnPromote: false } } })
    const result = await s.h.lifecycle.campaign(s.input, s.hooks)
    expect(result).toMatchObject({ stopped: 'no_noise_floor', promoted: [expect.any(String)] })
    if (result.paused) throw new Error('paused')
    expect(result.rounds).toHaveLength(1)
    // Nothing opened for the second round: the stop came before a round was spent.
    expect(s.h.ledger.experiment(s.experimentId)!.round_ids).toHaveLength(1)
    expect(s.h.lifecycle.status().rounds).toEqual([])
  })

  it('three consecutive holds stop the campaign; every round is decided, and each view carried the rounds before it', async () => {
    // Held-in only: the fixture pack's holdout budget is two reveals, which the budget test below exercises.
    const s = await setup({ script: { holdin: ['hold', 'hold', 'hold'] }, input: { tiers: { holdin: { repeat: 1 } } } })
    const result = await s.h.lifecycle.campaign(s.input, s.hooks)
    expect(result).toMatchObject({ stopped: 'consecutive_holds', promoted: [] })
    if (result.paused) throw new Error('paused')
    expect(result.rounds.map((r) => [r.tier, r.verdict])).toEqual([['holdin', 'hold'], ['holdin', 'hold'], ['holdin', 'hold']])
    expect(new Set(result.rounds.map((r) => r.challengerId)).size).toBe(3)
    for (const r of result.rounds) expect(s.h.ledger.round(r.roundId)).toMatchObject({ status: 'decided', outcome: { superseded: [] } })
    expect(s.h.champion.promoted).toEqual([])
    expect(s.consents).toEqual([])
    const histories = s.proposer.calls.map((c) => readFileSync(join(c.viewDir, 'history.jsonl'), 'utf8').trim().split('\n').filter(Boolean).length)
    expect(histories).toEqual([0, 1, 2])
    expect(kinds(s.events).filter((k) => k === 'decided')).toHaveLength(3)
  })

  it('a hold at holdin without a holdout tier ends the round; the max-rounds rule stops the campaign', async () => {
    const s = await setup({ script: { holdin: ['hold', 'hold'] }, input: { tiers: { holdin: { repeat: 1 } }, stop: { maxRounds: 2, maxConsecutiveHolds: 5, stopOnPromote: true } } })
    const result = await s.h.lifecycle.campaign(s.input, s.hooks)
    expect(result).toMatchObject({ stopped: 'max_rounds' })
    if (result.paused) throw new Error('paused')
    expect(result.rounds.map((r) => [r.tier, r.verdict])).toEqual([['holdin', 'hold'], ['holdin', 'hold']])
    expect(s.h.executor.calls.filter((c) => c.req.set === 'holdout')).toHaveLength(3)
  })

  it('a drop at holdin decides the round and does not count as a hold', async () => {
    const s = await setup({ script: { holdin: ['drop', 'drop', 'drop'] }, input: { stop: { maxRounds: 3, maxConsecutiveHolds: 1, stopOnPromote: true } } })
    const result = await s.h.lifecycle.campaign(s.input, s.hooks)
    expect(result).toMatchObject({ stopped: 'max_rounds' })
    if (result.paused) throw new Error('paused')
    expect(result.rounds.map((r) => r.verdict)).toEqual(['drop', 'drop', 'drop'])
    for (const r of result.rounds) expect(s.h.ledger.challenger(r.challengerId!)?.status).toBe('decided')
  })

  it('the experiment budget stops the campaign before a round is spent', async () => {
    const s = await setup({ script: { holdin: ['hold', 'hold'], holdout: ['hold', 'hold'] }, budget: { rounds: 1 } })
    const result = await s.h.lifecycle.campaign(s.input, s.hooks)
    expect(result).toMatchObject({ stopped: 'budget' })
    if (result.paused) throw new Error('paused')
    expect(result.rounds).toHaveLength(1)
    expect(s.h.ledger.experiment(s.experimentId)!.round_ids).toHaveLength(1)
    expect(s.proposer.calls).toHaveLength(1)
    expect(s.events.at(-1)).toMatchObject({ kind: 'stopped', reason: 'budget' })
  })

  it('the pack holdout budget stops the campaign at the held-out run once its reveals are spent', async () => {
    const s = await setup({ script: { holdin: ['hold', 'hold', 'hold'], holdout: ['hold', 'hold', 'hold'] }, input: { stop: { maxRounds: 5, maxConsecutiveHolds: 5, stopOnPromote: true } } })
    const result = await s.h.lifecycle.campaign(s.input, s.hooks)
    expect(result).toMatchObject({ stopped: 'budget' })
    if (result.paused) throw new Error('paused')
    expect(result.rounds.map((r) => [r.tier, r.verdict])).toEqual([['holdout', 'hold'], ['holdout', 'hold']])
    // The third round is open at its held-in hold; its held-out run never started.
    const third = s.h.ledger.round(s.h.ledger.experiment(s.experimentId)!.round_ids[2]!)!
    expect(third.status).toBe('open')
    expect(s.h.ledger.challenger(third.sibling_ids[0]!)).toMatchObject({ status: 'judged', tier_reached: 'holdin' })
    expect(s.h.executor.calls.filter((c) => c.req.set === 'holdout')).toHaveLength(5)
  })

  it('the campaign usd budget is checked before each round; an attempt budget stops a round before its run', async () => {
    const s = await setup({ script: { holdin: ['hold', 'hold'], holdout: ['hold', 'hold'] }, input: { stop: { maxRounds: 5, maxConsecutiveHolds: 5, budgetUsd: 0.1, stopOnPromote: true } } })
    const result = await s.h.lifecycle.campaign(s.input, s.hooks)
    expect(result).toMatchObject({ stopped: 'budget' })
    if (result.paused) throw new Error('paused')
    expect(result.rounds).toHaveLength(1)
    expect(s.h.ledger.experiment(s.experimentId)!.spent.usd).toBeGreaterThanOrEqual(0.1)

    const t = await setup({ script: { holdin: ['hold'] }, budget: { attempts: 4 } })
    const r2 = await t.h.lifecycle.campaign(t.input, t.hooks)
    expect(r2).toMatchObject({ stopped: 'budget', rounds: [] })
    // The smoke run spent the 4 attempts; the holdin run was refused and nothing ran.
    expect(t.h.executor.calls.filter((c) => c.req.set === 'holdin')).toHaveLength(0)
    expect(t.h.ledger.round(t.h.ledger.experiment(t.experimentId)!.round_ids[0]!)?.status).toBe('open')
  })

  it('a promote without a consent pauses; the same experiment resumes from the open round and promotes once the consent is on the ledger', async () => {
    const s = await setup({ script: { holdin: ['hold'], holdout: ['promote'] } })
    s.grant = () => undefined
    const paused = await s.h.lifecycle.campaign(s.input, s.hooks)
    expect(paused).toMatchObject({ paused: 'consent', action: 'promote', rounds: [], promoted: [] })
    if (!paused.paused) throw new Error('not paused')
    expect(s.h.ledger.round(paused.roundId)).toMatchObject({ status: 'open', sibling_ids: [paused.candidate] })
    expect(s.h.ledger.challenger(paused.candidate)).toMatchObject({ status: 'judged', tier_reached: 'holdout', verdict: { value: 'promote' } })
    expect(s.h.lifecycle.status().pending).toEqual([{ roundId: paused.roundId, candidate: paused.candidate, action: 'promote' }])
    expect(s.events.at(-1)).toEqual({ kind: 'paused', roundId: paused.roundId, action: 'promote', candidate: paused.candidate })
    const calls = s.h.executor.calls.length

    // Resume: nothing is re-proposed or re-run; the consent hook is asked again, this time answered.
    s.grant = (action, subject, roundId) => { const row = consent(subject, action as ConsentRow['action'], undefined, action === 'promote' ? roundId : undefined); s.h.ledger.consents.push(row); return row }
    const resumed = await s.h.lifecycle.campaign(s.input, s.hooks)
    expect(resumed).toMatchObject({ stopped: 'promoted', promoted: [paused.candidate], rounds: [{ roundId: paused.roundId, promoted: paused.candidate, verdict: 'promote' }] })
    expect(s.proposer.calls).toHaveLength(1)
    expect(s.h.executor.calls).toHaveLength(calls)
    expect(s.events.filter((e) => e.kind === 'round:opened').map((e) => e.kind === 'round:opened' && e.resumed)).toEqual([false, true])
    expect(s.h.ledger.round(paused.roundId)).toMatchObject({ status: 'decided', outcome: { promoted: paused.candidate } })
  })

  it('a consent already on the ledger is used without asking', async () => {
    const s = await setup({ script: { holdin: ['hold'], holdout: ['promote'] } })
    s.grant = () => undefined
    const paused = await s.h.lifecycle.campaign(s.input, s.hooks)
    if (!paused.paused) throw new Error('not paused')
    s.h.ledger.consents.push(consent(paused.candidate, 'promote', 'signed', paused.roundId))
    const resumed = await s.h.lifecycle.campaign(s.input, s.hooks)
    expect(resumed).toMatchObject({ stopped: 'promoted', promoted: [paused.candidate] })
    expect(s.consents).toEqual([{ action: 'promote', subject: paused.candidate }])
    expect(s.h.champion.promoted).toEqual([[paused.candidate, 'signed']])
  })

  it('without autoHoldout a holdout_reveal consent is asked for; refused, the campaign pauses before the held-out run', async () => {
    const s = await setup({ script: { holdin: ['hold'], holdout: ['promote'] }, input: { autoHoldout: false } })
    const grant = s.grant
    s.grant = (action, subject, roundId) => (action === 'holdout_reveal' ? undefined : grant(action, subject, roundId))
    const paused = await s.h.lifecycle.campaign(s.input, s.hooks)
    expect(paused).toMatchObject({ paused: 'consent', action: 'holdout_reveal' })
    if (!paused.paused) throw new Error('not paused')
    expect(s.h.executor.calls.filter((c) => c.req.set === 'holdout')).toHaveLength(3)
    expect(s.h.ledger.challenger(paused.candidate)).toMatchObject({ status: 'judged', tier_reached: 'holdin' })

    // Granted on resume: the held-out run follows, then the promotion.
    s.grant = (action, subject, roundId) => { const row = consent(subject, action as ConsentRow['action'], `${action}-x`, action === 'promote' ? roundId : undefined); s.h.ledger.consents.push(row); return row }
    const resumed = await s.h.lifecycle.campaign(s.input, s.hooks)
    expect(resumed).toMatchObject({ stopped: 'promoted', promoted: [paused.candidate] })
    expect(s.consents.map((c) => c.action)).toEqual(['holdout_reveal', 'holdout_reveal', 'promote'])
    expect(s.h.executor.calls.filter((c) => c.req.set === 'holdout')).toHaveLength(4)
  })

  it('a pre-registered auto_reveal runs the held-out tier without a holdout_reveal consent: the person said so in /samsara predict', async () => {
    const s = await setup({ script: { holdin: ['hold'], holdout: ['promote'] }, input: { autoHoldout: false } })
    const before = s.h.ledger.experiment(s.experimentId)!
    const exp = await s.h.lifecycle.preregister({
      hypothesis: before.hypothesis, prediction: before.prediction, pack: before.pack, gate: before.gate, budget: {}, created_by: before.created_by, auto_reveal: true,
    })
    expect(exp.id).not.toBe(before.id)
    expect(exp.auto_reveal).toBe(true)
    const result = await s.h.lifecycle.campaign({ ...s.input, experimentId: exp.id }, s.hooks)
    expect(result).toMatchObject({ stopped: 'promoted' })
    expect(s.consents.map((c) => c.action)).toEqual(['promote'])
    expect(s.h.executor.calls.filter((c) => c.req.set === 'holdout')).toHaveLength(4)
    expect(s.h.ledger.experiment(exp.id)?.spent.holdout_reveals).toBe(1)
  })

  it('the proposer route reaches every openRound: the operator on the proposer\'s route is refused before the proposer runs or anything is spent', async () => {
    const s = await setup({ input: { operator: { session_id: 'op', provider: 'p', model: 'shared-model' }, proposerRoute: { model: 'shared-model' } } })
    await expect(s.h.lifecycle.campaign(s.input, s.hooks)).rejects.toEqual(code('OPERATOR_IS_PROPOSER'))
    expect(s.proposer.calls).toEqual([])
    expect(s.h.ledger.experiment(s.experimentId)?.round_ids).toEqual([])
    expect(s.events).toEqual([])
    // 'unknown' (a command proposer) and another model open as before
    const other = await setup({ input: { operator: { session_id: 'op', provider: 'p', model: 'shared-model' }, proposerRoute: 'unknown' } })
    expect((await other.h.lifecycle.campaign(other.input, other.hooks)).rounds.length).toBeGreaterThan(0)
  })

  it('an abort mid-round leaves the round open and the row at its last status', async () => {
    const s = await setup({ script: { holdin: ['hold'], holdout: ['promote'] } })
    const runSet = s.h.executor.runSet.bind(s.h.executor)
    s.h.executor.runSet = async (req, deps) => {
      if (req.set === 'holdin' && deps.challengerId !== undefined && req.skillDir !== undefined) {
        s.controller.abort()
        throw new Error('aborted')
      }
      return runSet(req, deps)
    }
    const result = await s.h.lifecycle.campaign(s.input, s.hooks)
    expect(result).toMatchObject({ stopped: 'aborted', rounds: [], promoted: [] })
    const [roundId] = s.h.ledger.experiment(s.experimentId)!.round_ids
    const round = s.h.ledger.round(roundId!)!
    expect(round.status).toBe('open')
    expect(s.h.ledger.challenger(round.sibling_ids[0]!)).toMatchObject({ status: 'running', tier_reached: 'holdin' })
    expect(s.h.ledger.compares.size).toBe(1)
    expect(s.events.at(-1)).toMatchObject({ kind: 'stopped', reason: 'aborted' })
    // With the signal still aborted nothing more happens.
    expect(await s.h.lifecycle.campaign(s.input, s.hooks)).toMatchObject({ stopped: 'aborted', rounds: [] })
  })

  it('a run that completed before the abort is judged, not decided; the resume neither reruns it nor reveals the held-out set again', async () => {
    const s = await setup({ script: { holdin: ['hold'], holdout: ['promote'] } })
    const runSet = s.h.executor.runSet.bind(s.h.executor)
    s.h.executor.runSet = async (req, deps) => {
      const result = await runSet(req, deps)
      if (req.set === 'holdout') s.controller.abort()
      return result
    }
    expect(await s.h.lifecycle.campaign(s.input, s.hooks)).toMatchObject({ stopped: 'aborted', rounds: [] })
    const [roundId] = s.h.ledger.experiment(s.experimentId)!.round_ids
    const id = s.h.ledger.round(roundId!)!.sibling_ids[0]!
    expect(s.h.ledger.challenger(id)).toMatchObject({ status: 'judged', tier_reached: 'holdout', verdict: { value: 'promote' } })
    expect(s.h.ledger.round(roundId!)?.status).toBe('open')
    expect(s.consents).toEqual([])
    const holdout = s.h.executor.calls.filter((c) => c.req.set === 'holdout').length
    expect(s.h.ledger.experiment(s.experimentId)!.spent).toMatchObject({ attempts: 16, holdout_reveals: 1 })

    const resumed = await s.h.lifecycle.campaign(s.input, { ...s.hooks, signal: new AbortController().signal })
    expect(resumed).toMatchObject({ stopped: 'promoted', promoted: [id], rounds: [{ roundId, verdict: 'promote', promoted: id }] })
    expect(s.h.executor.calls.filter((c) => c.req.set === 'holdout')).toHaveLength(holdout)
    expect(s.h.ledger.experiment(s.experimentId)!.spent).toMatchObject({ attempts: 16, holdout_reveals: 1 })
  })

  it('a run the executor cut short is not judged: the attempts it recorded are the experiment\'s spend, the row stays running', async () => {
    const s = await setup({ script: { holdin: ['hold'], holdout: ['promote'] } })
    const runSet = s.h.executor.runSet.bind(s.h.executor)
    s.h.executor.runSet = async (req, deps) => {
      const result = await runSet(req, deps)
      if (req.set === 'holdin' && req.skillDir !== undefined && !s.controller.signal.aborted) {
        s.controller.abort()
        throw new Error('aborted')
      }
      return result
    }
    expect(await s.h.lifecycle.campaign(s.input, s.hooks)).toMatchObject({ stopped: 'aborted', rounds: [] })
    const [roundId] = s.h.ledger.experiment(s.experimentId)!.round_ids
    const id = s.h.ledger.round(roundId!)!.sibling_ids[0]!
    expect(s.h.ledger.challenger(id)).toMatchObject({ status: 'running', tier_reached: 'holdin' })
    // Recorded before the throw: the champion's held-in run and the challenger's, beside the two smoke runs.
    const recorded = [...s.h.ledger.attempts.values()].filter((a) => a.tier !== 'holdout')
    expect(recorded).toHaveLength(12)
    expect(s.h.ledger.experiment(s.experimentId)!.spent).toEqual({ usd: expect.closeTo(0.12, 9), attempts: 12, rounds: 1, holdout_reveals: 0 })

    // Resumed, the tier runs again and only that run is added.
    const resumed = await s.h.lifecycle.campaign(s.input, { ...s.hooks, signal: new AbortController().signal })
    expect(resumed).toMatchObject({ stopped: 'promoted', promoted: [id] })
    expect(s.h.ledger.experiment(s.experimentId)!.spent).toMatchObject({ attempts: 12 + 4 + 4, holdout_reveals: 1 })
  })

  it('a paused round\'s own held-in hold is not a prior consecutive hold: the resume drives it instead of stopping', async () => {
    const s = await setup({ script: { holdin: ['hold'], holdout: ['promote'] }, input: { autoHoldout: false, stop: { maxRounds: 5, maxConsecutiveHolds: 1, stopOnPromote: true } } })
    const grant = s.grant
    s.grant = (action, subject) => (action === 'holdout_reveal' ? undefined : grant(action, subject))
    const paused = await s.h.lifecycle.campaign(s.input, s.hooks)
    expect(paused).toMatchObject({ paused: 'consent', action: 'holdout_reveal' })
    if (!paused.paused) throw new Error('not paused')

    s.grant = grant
    const resumed = await s.h.lifecycle.campaign(s.input, s.hooks)
    expect(resumed).toMatchObject({ stopped: 'promoted', promoted: [paused.candidate], rounds: [{ roundId: paused.roundId, verdict: 'promote' }] })
    expect(s.consents.map((c) => c.action)).toEqual(['holdout_reveal', 'holdout_reveal', 'promote'])
    expect(s.h.ledger.round(paused.roundId)?.status).toBe('decided')
  })

  it('the pack holdout budget survives a restart: a second service over the same ledger stops the campaign before another reveal', async () => {
    const s = await setup({ script: { holdin: ['hold', 'hold', 'hold'], holdout: ['hold', 'hold', 'hold'] }, input: { stop: { maxRounds: 2, maxConsecutiveHolds: 5, stopOnPromote: true } } })
    expect(await s.h.lifecycle.campaign(s.input, s.hooks)).toMatchObject({ stopped: 'max_rounds' })
    const again = await openLifecycle({ gate: s.h.gate.policies, ledger: s.h.ledger })
    const resumed = await again.lifecycle.campaign({ ...s.input, stop: { maxRounds: 5, maxConsecutiveHolds: 5, stopOnPromote: true } }, s.hooks)
    expect(resumed).toMatchObject({ stopped: 'budget', rounds: [] })
    expect(again.executor.calls.filter((c) => c.req.set === 'holdout')).toHaveLength(0)
    const third = s.h.ledger.round(s.h.ledger.experiment(s.experimentId)!.round_ids[2]!)!
    expect(s.h.ledger.challenger(third.sibling_ids[0]!)).toMatchObject({ status: 'judged', tier_reached: 'holdin' })
  })

  it('an underpowered hold at holdin doubles the replicates on both sides up to maxRepeat, then goes to holdout', async () => {
    const s = await setup({ script: { holdin: ['hold:underpowered', 'hold:underpowered', 'hold'], holdout: ['promote'] }, input: { tiers: { holdin: { repeat: 1, maxRepeat: 4 }, holdout: { repeat: 2 } } } })
    const result = await s.h.lifecycle.campaign(s.input, s.hooks)
    expect(result).toMatchObject({ stopped: 'promoted' })
    const holdin = s.h.executor.calls.filter((c) => c.req.set === 'holdin').map((c) => [c.req.repeat, c.req.skillDir !== undefined])
    expect(holdin).toEqual([[1, false], [1, true], [2, false], [2, true], [4, false], [4, true]])
    // the floor's reruns cover sample 0 only: at two replicates the champion runs again beside the challenger
    expect(s.h.executor.calls.filter((c) => c.req.set === 'holdout').map((c) => [c.req.repeat, c.req.skillDir !== undefined])).toEqual([[1, false], [1, false], [1, false], [2, false], [2, true]])
    expect(s.events.filter((e) => e.kind === 'judged').map((e) => e.kind === 'judged' && e.tier)).toEqual(['smoke', 'holdin', 'holdin', 'holdin', 'holdout'])

    // The escalated judgement is the row's verdict, on the ledger and in the history: a drop after the replicates decides the round as a drop.
    const u = await setup({ script: { holdin: ['hold:underpowered', 'drop'] }, input: { tiers: { holdin: { repeat: 1, maxRepeat: 2 } }, stop: { maxRounds: 1, maxConsecutiveHolds: 1, stopOnPromote: true } } })
    const r3 = await u.h.lifecycle.campaign(u.input, u.hooks)
    if (r3.paused) throw new Error('paused')
    expect(r3).toMatchObject({ stopped: 'max_rounds', rounds: [{ tier: 'holdin', verdict: 'drop' }] })
    const dropped = r3.rounds[0]!.challengerId!
    expect(u.h.ledger.challenger(dropped)).toMatchObject({ status: 'decided', verdict: { value: 'drop', rule: 'drop' } })
    expect(u.events.filter((e) => e.kind === 'decided')).toEqual([expect.objectContaining({ challengerId: dropped, verdict: 'drop' })])
    expect(campaignHistory(u.h.ledger.experiment(u.experimentId)!, u.h.ledger)).toEqual([expect.objectContaining({ challenger_id: dropped, verdict: 'drop' })])
    expect(u.h.scopes.disposed).toEqual([dropped])

    // Paused after the escalation, the resume continues at the replicates the ledger holds: nothing at held-in runs again.
    const v = await setup({ script: { holdin: ['hold:underpowered', 'hold'], holdout: ['promote'] }, input: { autoHoldout: false, tiers: { holdin: { repeat: 1, maxRepeat: 2 }, holdout: { repeat: 1 } } } })
    const grant = v.grant
    v.grant = (action, subject) => (action === 'holdout_reveal' ? undefined : grant(action, subject))
    const paused = await v.h.lifecycle.campaign(v.input, v.hooks)
    expect(paused).toMatchObject({ paused: 'consent', action: 'holdout_reveal' })
    if (!paused.paused) throw new Error('not paused')
    expect(v.h.ledger.challenger(paused.candidate)).toMatchObject({ status: 'judged', tier_reached: 'holdin', verdict: { value: 'hold', rule: 'hold' } })
    expect(v.h.executor.calls.filter((c) => c.req.set === 'holdin').map((c) => c.req.repeat)).toEqual([1, 1, 2, 2])
    v.grant = grant
    expect(await v.h.lifecycle.campaign(v.input, v.hooks)).toMatchObject({ stopped: 'promoted', promoted: [paused.candidate] })
    expect(v.h.executor.calls.filter((c) => c.req.set === 'holdin').map((c) => c.req.repeat)).toEqual([1, 1, 2, 2])
    expect(v.h.executor.calls.filter((c) => c.req.set === 'holdout').map((c) => c.req.repeat)).toEqual([1, 1, 1, 1])

    // At maxRepeat the design stays underpowered: the row goes to holdout as a hold anyway.
    const t = await setup({ script: { holdin: ['hold:underpowered', 'hold:underpowered'], holdout: ['hold'] }, input: { tiers: { holdin: { repeat: 1, maxRepeat: 2 }, holdout: { repeat: 1 } }, stop: { maxRounds: 1, maxConsecutiveHolds: 3, stopOnPromote: true } } })
    const r2 = await t.h.lifecycle.campaign(t.input, t.hooks)
    if (r2.paused) throw new Error('paused')
    expect(r2.rounds[0]).toMatchObject({ tier: 'holdout', verdict: 'hold' })
    expect(t.h.executor.calls.filter((c) => c.req.set === 'holdin').map((c) => c.req.repeat)).toEqual([1, 1, 2, 2])
  })

  it('a proposal off the contract is refused before anything is spent', async () => {
    const s = await setup({ script: { holdin: ['hold'] } })
    s.proposer.predictions = ['o1']
    await expect(s.h.lifecycle.campaign(s.input, s.hooks)).rejects.toEqual(code('BAD_TRANSITION'))
    expect(s.h.executor.calls).toHaveLength(3)
    // The metric is the round's, not the champion row's configuration: a campaign on another metric anchors on the same row, and its proposal must predict that metric.
    const t = await setup({ script: { holdin: ['hold'] }, input: { metric: 'other', tiers: { holdin: { repeat: 1 } } } })
    await expect(t.h.lifecycle.campaign(t.input, t.hooks)).rejects.toEqual(code('BAD_TRANSITION'))
    expect(t.h.ledger.round(t.h.ledger.experiment(t.experimentId)!.round_ids[0]!)?.champion_id).toBe(challengerId(championProposal()))
  })

  it('a champion that moved while a round was open closes that round and opens a fresh one', async () => {
    const s = await setup({ script: { holdin: ['hold'], holdout: ['promote'] } })
    s.grant = () => undefined
    const paused = await s.h.lifecycle.campaign(s.input, s.hooks)
    if (!paused.paused) throw new Error('not paused')
    const other: ChallengerProposal = championProposal({ skill_sha: sha('moved'), patch: { skill_ref: 'skill:moved' } })
    const champion = () => ({ proposal: other, skillDir: resolve(PACK, 'skill') })
    const result = await s.h.lifecycle.campaign({ ...s.input, champion, tiers: { holdin: { repeat: 1 } }, stop: { maxRounds: 1, maxConsecutiveHolds: 3, stopOnPromote: true } }, s.hooks)
    expect(result).toMatchObject({ stopped: 'max_rounds' })
    expect(s.h.ledger.round(paused.roundId)?.status).toBe('decided')
    expect(s.h.ledger.experiment(s.experimentId)!.round_ids).toHaveLength(2)
  })
})

// -------------------------------------------------------------- history

describe('history', () => {
  it('never contains a held-out number: a holdout-judged round shows its tier and verdict with the held-in compare only', async () => {
    const s = await setup({ script: { holdin: ['hold', 'hold'], holdout: ['hold', 'hold'] }, input: { stop: { maxRounds: 2, maxConsecutiveHolds: 5, stopOnPromote: true } } })
    // Held-in tasks score 0.9 for a challenger, held-out ones 0.7; the champion 0.5 everywhere: the two tiers' means differ.
    s.h.executor.value = (id, task) => (s.h.ledger.challenger(id)?.parent_ids.length === 0 ? 0.5 : task.startsWith('o') ? 0.7 : 0.9)
    const result = await s.h.lifecycle.campaign(s.input, s.hooks)
    if (result.paused) throw new Error('paused')
    const [first] = result.rounds
    const holdin = s.h.ledger.comparesOf(first!.challengerId!).find((c) => c.tier === 'holdin')!
    const holdout = s.h.ledger.comparesOf(first!.challengerId!).find((c) => c.tier === 'holdout')!
    expect(holdin.mean).toBeCloseTo(0.4, 9)
    expect(holdout.mean).toBeCloseTo(0.2, 9)

    const history = campaignHistory(s.h.ledger.experiment(s.experimentId)!, s.h.ledger)
    expect(history).toHaveLength(2)
    expect(history[0]).toEqual({ round_id: first!.roundId, challenger_id: first!.challengerId, tier: 'holdout', verdict: 'hold', mean: holdin.mean, ci: holdin.ci, n_eff: holdin.n_eff, mde: holdin.mde })
    const text = readFileSync(join(s.proposer.calls[1]!.viewDir, 'history.jsonl'), 'utf8')
    const lines = text.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(lines).toEqual([history[0]])
    for (const key of ['mean', 'ci', 'n_eff', 'mde'] as const) expect(JSON.stringify(lines[0]![key])).toBe(JSON.stringify(holdin[key]))
    expect(text).not.toContain(String(holdout.mean))
    expect(text).not.toContain(JSON.stringify(holdout.ci))
    expect(text).not.toContain(JSON.stringify(holdout.per_task))
    expect(JSON.parse(readFileSync(join(s.proposer.calls[1]!.viewDir, 'view.json'), 'utf8')).files).toContain('history.jsonl')
  })

  it('writeHistory lists the file in an existing view.json once, or writes a manifest of its own', async () => {
    const dir = join(out(), 'view')
    writeHistory(dir, [])
    expect(JSON.parse(readFileSync(join(dir, 'view.json'), 'utf8'))).toEqual({ files: ['history.jsonl'] })
    writeHistory(dir, [{ round_id: 'r', challenger_id: 'c' }])
    expect(JSON.parse(readFileSync(join(dir, 'view.json'), 'utf8'))).toEqual({ files: ['history.jsonl'] })
    expect(readFileSync(join(dir, 'history.jsonl'), 'utf8')).toBe('{"round_id":"r","challenger_id":"c"}\n')
    expect(existsSync(join(dir, 'history.jsonl'))).toBe(true)
  })
})
