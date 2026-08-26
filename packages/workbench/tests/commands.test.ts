import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context, DomainFacility, JobId, JsonStorageBackend, Storage, storageBackendServiceKey, type CommandDefinition, type CommandInvocation } from '@oldbulb/samsara-kernel'
import Ledger, { experimentRowSchema, type ChallengerRow, type ConsentRow, type ExperimentRow, type RoundRow, type ServingRow } from '@oldbulb/samsara-ledger'
import { gateRefOf, roundPolicy, LifecycleError, type ExperimentInput, type LifecycleStatus, type RoundOutcome } from '@oldbulb/samsara-lifecycle'
import type { ConsentRecord, PendingSignoff, SignoffAction } from '@oldbulb/samsara-signoff'
import { apply, execute, parseCommand, tokenize, USAGE, type CommandResult } from '../src/commands.ts'
import { jobTags } from '../src/jobs.ts'
import { ABORT_RULE } from '../src/startup.ts'

beforeEach(() => { jobTags.clear() })

const MINI = resolve(import.meta.dirname, '..', '..', 'pack', 'tests', 'fixtures', 'minipack')
const GATE = { name: 'gate-default', version: '0.2.0', judge: () => { throw new Error('not judged here') } }
const FAST = { name: 'gate-fast', version: '0.1.0', judge: () => { throw new Error('not judged here') } }

const EXPERIMENT: ExperimentRow = {
  id: 'e1', hypothesis: 'shorter skill helps', prediction: { metric: 'pass_rate', direction: 'up', magnitude: 0.05 }, pack: 'minipack',
  gate: { name: 'gate-default', version: '0.2.0', policy_sha: 'p' }, budget: { rounds: 3 }, created_by: { channel: 'command' },
  created_at: '2026-01-01T00:00:00.000Z', spent: { usd: 0, attempts: 0, rounds: 0, holdout_reveals: 0 }, status: 'active', round_ids: [],
}

const STATUS: LifecycleStatus = { champion: { rows: ['skill:abc'], profilePatchRows: [], kept: [] }, rounds: [], pending: [], noiseFloors: [], experiments: [] }

function challenger(over: Partial<ChallengerRow>): ChallengerRow {
  return { id: 'c1', parent_ids: ['c0'], status: 'judged', verdict: { value: 'promote', by: 'gate', rule: 'r', round_id: 'r1' }, ...over } as ChallengerRow
}

function round(over: Partial<RoundRow>): RoundRow {
  return { id: 'r1', champion_id: 'c0', sibling_ids: ['c1'], status: 'open', ...over } as RoundRow
}

/** The ledger slice the commands read and write. */
class MemLedger {
  challengers = new Map<string, ChallengerRow>()
  consents: ConsentRow[] = []
  rounds: RoundRow[] = []
  experiments = new Map<string, ExperimentRow>()
  servingRows: ServingRow[] = []
  patches: [string, unknown][] = []
  challenger(id: string) { return this.challengers.get(id) }
  consentsOf(subject: string) { return this.consents.filter((c) => c.challenger_id === subject) }
  async recordConsent(row: ConsentRow) { if (!this.consents.some((c) => c.id === row.id)) this.consents.push(row); return row.id }
  round(id: string) { return this.rounds.find((r) => r.id === id) }
  roundsOf(championId: string) { return this.rounds.filter((r) => r.champion_id === championId) }
  experiment(id: string) { return this.experiments.get(id) }
  /** As the ledger does: the row re-parsed by its schema, which keeps no field the schema does not name (the fixture ids are not shas). */
  async updateExperiment(id: string, patch: Partial<ExperimentRow>) {
    this.patches.push([id, patch])
    const next = { ...experimentRowSchema.omit({ id: true }).parse({ ...this.experiments.get(id)!, ...patch }), id }
    this.experiments.set(id, next)
    return next
  }
  servings() { return this.servingRows }
  async setStatus(id: string, status: ChallengerRow['status'], patch: Partial<ChallengerRow> = {}) {
    const next = { ...this.challengers.get(id)!, ...patch, status }
    this.challengers.set(id, next)
    this.patches.push([id, { ...patch, status }])
    return next
  }
  async updateRound(id: string, patch: Partial<RoundRow>) {
    const cur = this.round(id)!
    const next = { ...cur, ...patch }
    this.rounds[this.rounds.indexOf(cur)] = next
    this.patches.push([id, patch])
    return next
  }
}

/** ctx.signoff without a socket: `request` opens a pending row, `answer` plays the proof the human would submit. */
class FakeSignoff {
  ready = Promise.resolve()
  requested: PendingSignoff[] = []
  private listeners = new Set<(c: ConsentRecord) => void>()
  request(rowId: string, action: SignoffAction, opts: { roundId?: string } = {}): PendingSignoff {
    const p = { nonce: 'n', rowId, action, ...(opts.roundId !== undefined ? { roundId: opts.roundId } : {}), expiresAt: 'later' }
    this.requested.push(p)
    return p
  }
  onConfirm(l: (c: ConsentRecord) => void) { this.listeners.add(l); return () => { this.listeners.delete(l) } }
  /** The proof the human would submit answers the pending sign-off, so it carries the round that sign-off named. */
  answer(rowId: string, action: SignoffAction, id: string) {
    const pending = this.requested.find((p) => p.rowId === rowId && p.action === action)
    const payload = { nonce: 'n', rowId, action, who: 'me', issuedAt: 't', ...(pending?.roundId !== undefined ? { roundId: pending.roundId } : {}) }
    const c: ConsentRecord = { id, challenger_id: rowId, action, who: 'me', channel: 'unix-socket', proof_sha: 'p', at: 't', ...(pending?.roundId !== undefined ? { round_id: pending.roundId } : {}), proof: { payload, signature: 's' } }
    for (const l of this.listeners) l(c)
  }
}

class FakeLifecycle {
  preregistered: ExperimentInput[] = []
  decided: string[] = []
  demoted: [string, string, string | undefined][] = []
  budgets: [string, ExperimentRow['budget'], unknown][] = []
  aborted: string[] = []
  outcome: RoundOutcome = { roundId: 'r1', promoted: 'c1', superseded: [], consentId: 'k' }
  rounds: RoundRow[] = []
  /** The ledger the service would write (the host's, which one test swaps for a real one). */
  ledgerOf: () => MemLedger = () => { throw new Error('no ledger') }
  status() { return { ...STATUS, rounds: this.rounds } }
  async setExperimentBudget(id: string, budget: ExperimentRow['budget'], by: { session_id?: string; command_id?: string } = {}) {
    this.budgets.push([id, budget, by])
    const ledger = this.ledgerOf()
    const e = ledger.experiment(id)!
    return ledger.updateExperiment(id, { budget, budget_changes: [...(e.budget_changes ?? []), { at: new Date().toISOString(), ...by, budget }] })
  }
  async abortRound(id: string) {
    this.aborted.push(id)
    const ledger = this.ledgerOf()
    const round = ledger.round(id)!
    const aborted = round.sibling_ids.filter((s) => ledger.challenger(s)?.status === 'running')
    for (const s of aborted) await ledger.setStatus(s, 'judged', { verdict: { value: 'invalid', by: 'lifecycle', rule: ABORT_RULE, round_id: id } })
    await ledger.updateRound(id, { status: 'decided', closed_at: new Date().toISOString(), outcome: { superseded: [], aborted: true } })
    return { roundId: id, aborted }
  }
  async preregister(input: ExperimentInput): Promise<ExperimentRow> {
    this.preregistered.push(input)
    return { ...EXPERIMENT, ...input, id: 'e-new', created_at: '2026-02-02T00:00:00.000Z' }
  }
  async decide(roundId: string) { this.decided.push(roundId); return this.outcome }
  async demote(id: string, reason: string, consentId?: string) { this.demoted.push([id, reason, consentId]) }
}

interface Job { id: string; kind: string; label: string }

/** Labels as the tools set them: the approval reason, which names no round. */
class FakeJobs {
  jobs: Job[] = [
    { id: 'samsara-campaign-1', kind: 'samsara-campaign', label: '2 round(s) on experiment e1: minipack/fake by fake-proposer: cost unknown (20 attempts)' },
    { id: 'samsara-control-1', kind: 'samsara-control', label: 'control aa r1 on minipack/fake at holdout x1: cost unknown (4 attempts)' },
    { id: 'bash-1', kind: 'bash', label: 'ls r1' },
  ]
  killed: [string, unknown, string | undefined][] = []
  list(caller: unknown) { return caller === undefined ? [] : this.jobs }
  kill(id: string, caller: unknown, reason?: string) { this.killed.push([id, caller, reason]); return 'requested' as const }
}

class FakeAgent {
  id = 'sess-1'
  followups: { content: { type: string; text?: string }[] }[] = []
  followup(m: { content: { type: string; text?: string }[] }) { this.followups.push(m) }
}

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

/** The real ledger over the json backend in `root` (as the ledger's own tests open it). */
async function openLedger(root: string) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new JsonStorageBackend(root)
  ctx.storage.backend.register('json', backend)
  ctx.provide(storageBackendServiceKey('json'), backend)
  const facility = new DomainFacility(ctx, { backend: 'json', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const fiber = ctx.plugin(Ledger)
  await fiber
  return {
    ledger: ctx.ledger,
    async close() {
      await fiber.dispose()
      await backend.close()
    },
  }
}

function host() {
  const defs: CommandDefinition[] = []
  const ledger = new MemLedger()
  const signoff = new FakeSignoff()
  const lifecycle = new FakeLifecycle()
  const jobs = new FakeJobs()
  const agent = new FakeAgent()
  const ctx = {
    commands: { register: (d: CommandDefinition) => { defs.push(d); return () => {} } },
    lifecycle, ledger, signoff, jobs,
    champion: { current: () => STATUS.champion },
    get: (key: string) => (key === 'gate' ? { current: () => GATE, list: () => [GATE, FAST] } : undefined),
  } as unknown as Context
  lifecycle.ledgerOf = () => (ctx as unknown as { ledger: MemLedger }).ledger
  const controller = new AbortController()
  const invocation = (rawInput: string): CommandInvocation => ({ commandId: 'cmd-7', agent, rawInput, attachments: [], signal: controller.signal }) as unknown as CommandInvocation
  const run = (rawInput: string) => execute(ctx, invocation(rawInput)) as Promise<CommandResult>
  const notices = () => agent.followups.map((m) => m.content.map((b) => b.text).join(''))
  return { ctx, defs, ledger, signoff, lifecycle, jobs, agent, controller, invocation, run, notices }
}

describe('workbench-commands', () => {
  it('registers /samsara with a handler that executes the line', async () => {
    const h = host()
    apply(h.ctx)
    expect(h.defs.map((d) => d.name)).toEqual(['samsara'])
    const result = await h.defs[0]!.handler(h.invocation(' status'))
    expect(result).toEqual({ kind: 'success', text: expect.stringContaining('champion   skill:abc') })
  })

  it('tokenizes quoted runs as one word', () => {
    expect(tokenize(' demote c0 "reads worse on go" --wait 5')).toEqual(['demote', 'c0', 'reads worse on go', '--wait', '5'])
  })

  it('rejects an empty line, an unknown subcommand and a bad option with the usage', async () => {
    const h = host()
    for (const line of ['', 'frobnicate', 'status extra', 'approve', 'approve c1 --wait', 'approve c1 --wait x', 'approve c1 --nope 1']) {
      const r = await h.run(line)
      expect(r.kind).toBe('error')
      expect(r.text).toContain(USAGE)
    }
  })

  describe('predict', () => {
    it('pre-registers the experiment on the pack, the mounted gate and the command as creator, and prints the campaign call', async () => {
      const h = host()
      const r = await h.run(`predict new "shorter skill helps" --pack ${MINI} --metric pass_rate --direction up --magnitude 0.05 --budget-usd 12.5 --budget-rounds 4`)
      expect(r.kind).toBe('success')
      expect(h.lifecycle.preregistered).toEqual([{
        hypothesis: 'shorter skill helps', prediction: { metric: 'pass_rate', direction: 'up', magnitude: 0.05 }, pack: 'minipack',
        gate: gateRefOf(GATE, roundPolicy(3, 0.1)), budget: { usd: 12.5, rounds: 4 },
        created_by: { channel: 'command', session_id: 'sess-1', command_id: 'cmd-7' },
      }])
      expect(r.text).toContain('experiment e-new')
      expect(r.text).toContain('samsara_campaign_start {"experiment_id":"e-new","proposer":"<proposer>","rounds":4}')
      expect(h.agent.followups).toEqual([])
    })
    it('takes --gate by name or name@version and --n-eff-floor', async () => {
      const h = host()
      await h.run(`predict new "h" --pack ${MINI} --metric m --direction down --gate gate-fast --n-eff-floor 5`)
      await h.run(`predict new "h" --pack ${MINI} --metric m --direction down --gate gate-fast@0.1.0`)
      expect(h.lifecycle.preregistered.map((e) => e.gate)).toEqual([gateRefOf(FAST, roundPolicy(5, 0.1)), gateRefOf(FAST, roundPolicy(3, 0.1))])
      expect(h.lifecycle.preregistered[0]!.budget).toEqual({})
      const r = await h.run(`predict new "h" --pack ${MINI} --metric m --direction down --gate nope`)
      expect(r).toEqual({ kind: 'error', text: 'no mounted gate policy named nope' })
    })
    it('refuses a missing hypothesis, metric or pack, an unquoted hypothesis and a bad direction', () => {
      expect(() => parseCommand('predict new')).toThrow('needs a "<hypothesis>"')
      expect(() => parseCommand('predict new "h" --pack p --direction up')).toThrow('--metric is required')
      expect(() => parseCommand('predict new "h" --metric m --direction up')).toThrow('--pack is required')
      expect(() => parseCommand('predict new two words --pack p --metric m --direction up')).toThrow('unexpected "words"')
      expect(() => parseCommand('predict new "h" --pack p --metric m --direction sideways')).toThrow('--direction must be up or down')
      expect(() => parseCommand('predict new "h" --pack p --metric m --direction up --magnitude big')).toThrow('--magnitude must be a number')
    })
    it('--auto-reveal pre-registers the held-out reveal on the experiment row, and the card says so; without it nothing is set', async () => {
      const h = host()
      const r = await h.run(`predict new "h" --pack ${MINI} --metric m --direction up --auto-reveal --budget-rounds 2`)
      expect(r.kind).toBe('success')
      expect(h.lifecycle.preregistered).toEqual([expect.objectContaining({ hypothesis: 'h', budget: { rounds: 2 }, auto_reveal: true })])
      expect(r.text).toContain('auto-reveal pre-registered: the campaign runs the held-out tier after a held-in hold without a /samsara reveal per round')
      await h.run(`predict new "h" --pack ${MINI} --metric m --direction up`)
      expect(h.lifecycle.preregistered[1]).not.toHaveProperty('auto_reveal')
      expect(() => parseCommand('predict new "h" --pack p --metric m --direction up --auto-reveal yes')).toThrow('unexpected "yes"')
      // shown again by id, as it was pre-registered
      h.ledger.experiments.set('e-auto', { ...EXPERIMENT, id: 'e-auto', auto_reveal: true })
      expect((await h.run('predict e-auto')).text).toContain('auto-reveal pre-registered')
      expect((await h.run('predict e1')).text).not.toContain('auto-reveal')
    })
    it('shows a pre-registered experiment by id and refuses to change one', async () => {
      const h = host()
      h.ledger.experiments.set('e1', EXPERIMENT)
      const r = await h.run('predict e1')
      expect(r.kind).toBe('success')
      expect(r.text).toContain('hypothesis shorter skill helps')
      expect(r.text).toContain('samsara_campaign_start {"experiment_id":"e1","proposer":"<proposer>","rounds":3}')
      expect(await h.run('predict e9')).toEqual({ kind: 'error', text: 'no experiment e9 on the ledger' })
      expect((await h.run('predict e1 "other" --metric m')).text).toContain('fixed once pre-registered')
    })
  })

  describe('approve', () => {
    it('with --wait, opens a promote sign-off, records the proof, decides the round, prints the serving row and notifies the operator', async () => {
      const h = host()
      h.ledger.challengers.set('c1', challenger({}))
      h.ledger.rounds.push(round({ id: 'r0', status: 'decided' }), round({}))
      h.ledger.servingRows.push({ id: 's1', champion_id: 'c1', from: '2026-01-02', by: 'promote', consent_id: 'k', profile_sha: 'abcdef0123456789' })
      const done = h.run('approve c1 --wait 5')
      await new Promise((r) => setTimeout(r, 0))
      // E2: the promote sign-off names the round it decides.
      expect(h.signoff.requested).toEqual([{ nonce: 'n', rowId: 'c1', action: 'promote', roundId: 'r1', expiresAt: 'later' }])
      h.signoff.answer('c2', 'promote', 'x')
      h.signoff.answer('c1', 'demote', 'y')
      h.signoff.answer('c1', 'promote', 'k')
      const r = await done
      // every proof the socket confirms lands on the ledger; only the one naming c1/promote answers the wait
      expect(h.ledger.consents.map((c) => c.id)).toEqual(['x', 'y', 'k'])
      expect(h.lifecycle.decided).toEqual(['r1'])
      expect(r).toEqual({ kind: 'success', text: ['promoted c1 with consent k (round r1)', 'serving    s1  champion c1  by promote  consent k  from 2026-01-02  profile abcdef012345', 'kept       skill:abc'].join('\n') })
      expect(h.notices()).toEqual(['promoted c1 with consent k (round r1)'])
    })
    it('without --wait, uses the consent on the ledger or refuses with the line that opens one', async () => {
      const h = host()
      h.ledger.challengers.set('c1', challenger({}))
      h.ledger.rounds.push(round({}))
      expect(await h.run('approve c1')).toEqual({ kind: 'error', text: 'no promote consent on the ledger for c1; run `/samsara approve c1 --wait <seconds>` and confirm with samsara-signoff' })
      // E2: a promote consent bound to another round is not this round's.
      h.ledger.consents.push({ id: 'elsewhere', challenger_id: 'c1', action: 'promote', who: 'me', channel: 'unix-socket', proof_sha: 'p', at: '0', round_id: 'r0' })
      expect((await h.run('approve c1')).kind).toBe('error')
      h.ledger.consents.push({ id: 'old', challenger_id: 'c1', action: 'promote', who: 'me', channel: 'unix-socket', proof_sha: 'p', at: '1', round_id: 'r1' })
      const r = await h.run('approve c1')
      expect(r.kind).toBe('success')
      expect(h.signoff.requested).toEqual([])
      expect(h.lifecycle.decided).toEqual(['r1'])
      expect(h.notices()).toEqual(['promoted c1 with consent k (round r1)'])
    })
    it('refuses an unknown row, a row without a promote verdict, a pending or foreign decision, and a timed-out or cancelled wait', async () => {
      const h = host()
      expect(await h.run('approve c1')).toEqual({ kind: 'error', text: 'no challenger c1 on the ledger' })
      h.ledger.challengers.set('c1', challenger({ verdict: { value: 'hold', by: 'gate', rule: 'r', round_id: 'r1' } }))
      expect(await h.run('approve c1')).toEqual({ kind: 'error', text: 'challenger c1 has verdict hold, not promote' })
      h.ledger.challengers.set('c1', challenger({}))
      h.ledger.consents.push({ id: 'k', challenger_id: 'c1', action: 'promote', who: 'me', channel: 'unix-socket', proof_sha: 'p', at: '1', round_id: 'r1' })
      expect(await h.run('approve c1')).toEqual({ kind: 'error', text: 'challenger c1 is in no round' })
      h.ledger.rounds.push(round({}))
      h.lifecycle.outcome = { pending: 'consent', roundId: 'r1', candidate: 'c2' }
      expect((await h.run('approve c1')).text).toContain('its candidate is c2, not c1')
      h.lifecycle.outcome = { roundId: 'r1', promoted: 'c2', superseded: ['c1'] }
      expect((await h.run('approve c1')).text).toBe('round r1 decided without promoting c1 (promoted c2)')
      expect(h.notices()).toEqual([])

      h.ledger.consents.length = 0
      const decided = h.lifecycle.decided.length
      expect(await h.run('approve c1 --wait 0.01')).toEqual({ kind: 'error', text: 'no promote consent for c1 arrived within 0.01s' })
      const cancelled = h.run('approve c1 --wait 5')
      await new Promise((r) => setTimeout(r, 0))
      h.controller.abort()
      expect((await cancelled).text).toBe('the promote sign-off for c1 was cancelled before a proof arrived')
      expect(h.lifecycle.decided).toHaveLength(decided)
    })
  })

  describe('error cards', () => {
    it('a service refusal renders with the errors table\'s sentence and next action; a plain error is its message', async () => {
      const h = host()
      h.ledger.challengers.set('c1', challenger({}))
      h.ledger.rounds.push(round({}))
      h.ledger.consents.push({ id: 'k', challenger_id: 'c1', action: 'promote', who: 'me', channel: 'unix-socket', proof_sha: 'p', at: 't', round_id: 'r1' })
      h.lifecycle.decide = async () => { throw new LifecycleError('ROUND_CLOSED', 'round r1 is decided') }
      const r = await h.run('approve c1')
      expect(r.kind).toBe('error')
      expect(r.text.split('\n')).toEqual([
        'round r1 is decided [ROUND_CLOSED]',
        expect.stringMatching(/^The round .* Holm k\.$/),
        expect.stringMatching(/^Next: open a new round/),
      ])
      expect(await h.run('predict e9')).toEqual({ kind: 'error', text: 'no experiment e9 on the ledger' })
    })
  })

  describe('demote', () => {
    it('takes the quoted reason, waits for the demote consent, demotes through the service and notifies', async () => {
      const h = host()
      const done = h.run('demote c0 "reads worse on go" --wait 5')
      await new Promise((r) => setTimeout(r, 0))
      expect(h.signoff.requested).toEqual([{ nonce: 'n', rowId: 'c0', action: 'demote', expiresAt: 'later' }])
      h.signoff.answer('c0', 'demote', 'd')
      const r = await done
      expect(h.lifecycle.demoted).toEqual([['c0', 'reads worse on go', 'd']])
      expect(r).toEqual({ kind: 'success', text: 'demoted c0 with consent d: reads worse on go\nkept       skill:abc' })
      expect(h.notices()).toEqual(['demoted c0 with consent d: reads worse on go'])
    })
    it('needs a reason and, without --wait, a consent on the ledger', async () => {
      const h = host()
      expect((await h.run('demote c0')).text).toContain('a "<reason>" is required')
      expect((await h.run('demote c0 reads worse')).text).toContain('unexpected "worse" (quote the reason)')
      expect(await h.run('demote c0 "why"')).toEqual({ kind: 'error', text: 'no demote consent on the ledger for c0; run `/samsara demote c0 "why" --wait <seconds>` and confirm with samsara-signoff' })
      expect(h.lifecycle.demoted).toEqual([])
    })
  })

  describe('gate', () => {
    it('opens a gate_change sign-off whose subject is the name@version (or command) and reports the consent', async () => {
      const h = host()
      const done = h.run('gate keep-better@0.1.0 --wait 5')
      await new Promise((r) => setTimeout(r, 0))
      expect(h.signoff.requested).toEqual([{ nonce: 'n', rowId: 'keep-better@0.1.0', action: 'gate_change', expiresAt: 'later' }])
      h.signoff.answer('keep-better@0.1.0', 'gate_change', 'g')
      expect(await done).toEqual({ kind: 'success', text: 'gate_change consent g names keep-better@0.1.0 (by me at t)' })
      expect(h.ledger.consentsOf('keep-better@0.1.0').map((c) => c.id)).toEqual(['g'])
      expect(h.notices()).toEqual(['gate_change consent g names keep-better@0.1.0 (by me at t)'])
      expect(parseCommand('gate ./bin/gate')).toEqual({ kind: 'gate', gate: './bin/gate' })
      expect((await h.run('gate')).text).toContain('a gate (name@version or ./command) is required')
    })
  })

  describe('reveal', () => {
    it('opens a holdout_reveal sign-off on the challenger a campaign paused on, and records the consent where the campaign reads it', async () => {
      const h = host()
      expect(await h.run('reveal c1 --wait 5')).toEqual({ kind: 'error', text: 'no challenger c1 on the ledger' })
      h.ledger.challengers.set('c1', challenger({ verdict: { value: 'hold', by: 'gate', rule: 'r', round_id: 'r1' } }))
      h.ledger.rounds.push(round({}))
      const done = h.run('reveal c1 --wait 5')
      await new Promise((r) => setTimeout(r, 0))
      expect(h.signoff.requested).toEqual([{ nonce: 'n', rowId: 'c1', action: 'holdout_reveal', expiresAt: 'later' }])
      h.signoff.answer('c1', 'holdout_reveal', 'h')
      expect(await done).toEqual({ kind: 'success', text: 'holdout_reveal consent h names challenger c1 (by me at t)' })
      // what the campaign driver looks up before the held-out tier: consentsOf(candidate) with action holdout_reveal
      expect(h.ledger.consentsOf('c1').filter((c) => c.action === 'holdout_reveal').map((c) => c.id)).toEqual(['h'])
      expect(h.ledger.consentsOf('r1')).toEqual([])
      expect(h.notices()).toEqual(['holdout_reveal consent h names challenger c1 (by me at t)'])
      expect((await h.run('reveal')).text).toContain('a challenger id is required')
      expect(USAGE).toContain('/samsara reveal <challenger-id>')
    })
  })

  describe('budget', () => {
    it('raises one budget line on the ledger and says who did it when', async () => {
      const h = host()
      h.ledger.experiments.set('e1', EXPERIMENT)
      const r = await h.run('budget e1 --usd 20')
      expect(r.kind).toBe('success')
      const change = { at: expect.any(String), session_id: 'sess-1', command_id: 'cmd-7', budget: { rounds: 3, usd: 20 } }
      expect(h.lifecycle.budgets).toEqual([['e1', { rounds: 3, usd: 20 }, { session_id: 'sess-1', command_id: 'cmd-7' }]])
      expect(h.ledger.patches).toEqual([['e1', { budget: { rounds: 3, usd: 20 }, budget_changes: [change] }]])
      expect(r.text).toContain('usd 0/20')
      expect(r.text).toContain('budget set by session sess-1 (command cmd-7)')
      await h.run('budget e1 --rounds 6')
      expect(h.ledger.experiment('e1')!.budget).toEqual({ rounds: 6, usd: 20 })
      // every raise, oldest first: who set which budget when
      expect(h.ledger.experiment('e1')!.budget_changes).toEqual([change, { ...change, budget: { rounds: 6, usd: 20 } }])
      expect(h.agent.followups).toEqual([])
    })
    it('persists the budget and who raised it on the real ledger, across a reload', async () => {
      const root = mkdtempSync(join(tmpdir(), 'samsara-workbench-ledger-'))
      dirs.push(root)
      let real = await openLedger(root)
      let id: string
      try {
        const row = await real.ledger.createExperiment({ ...EXPERIMENT, created_by: { channel: 'test' } })
        id = row.id
        const h = host()
        ;(h.ctx as { ledger: unknown }).ledger = real.ledger
        const r = await h.run(`budget ${row.id} --usd 20`)
        expect(r.kind).toBe('success')
        expect(real.ledger.experiment(row.id)!.budget).toEqual({ rounds: 3, usd: 20 })
        expect(real.ledger.experiment(row.id)!.spent).toEqual(row.spent)
      } finally {
        await real.close()
      }
      real = await openLedger(root)
      try {
        expect(real.ledger.experiment(id)).toMatchObject({
          budget: { rounds: 3, usd: 20 },
          budget_changes: [{ at: expect.any(String), session_id: 'sess-1', command_id: 'cmd-7', budget: { rounds: 3, usd: 20 } }],
        })
      } finally {
        await real.close()
      }
    })
    it('needs --usd or --rounds, an integer round count and a known experiment', async () => {
      const h = host()
      expect((await h.run('budget e1')).text).toContain('budget needs --usd or --rounds')
      expect((await h.run('budget e1 --rounds 1.5')).text).toContain('--rounds must be an integer')
      expect(await h.run('budget e1 --usd 1')).toEqual({ kind: 'error', text: 'no experiment e1 on the ledger' })
      expect(h.ledger.patches).toEqual([])
    })
  })

  describe('stop', () => {
    const label = '2 round(s) on experiment e1: minipack/fake by fake-proposer: cost unknown (20 attempts)'
    it('kills the campaign job this session owns, by job id, by a round id the job opened, or by a round of the experiment it is charged to', async () => {
      const h = host()
      jobTags.set(JobId('samsara-campaign-1'), { experiment_id: 'e1', round_ids: ['r1'] })
      h.ledger.rounds.push(round({ id: 'r2', experiment_id: 'e1' }))
      expect(await h.run('stop samsara-campaign-1')).toEqual({ kind: 'success', text: `samsara-campaign-1 (${label}): requested` })
      expect(await h.run('stop r1')).toEqual({ kind: 'success', text: `samsara-campaign-1 (${label}): requested` })
      expect(await h.run('stop r2')).toEqual({ kind: 'success', text: `samsara-campaign-1 (${label}): requested` })
      expect(h.jobs.killed.map((k) => k[0])).toEqual(['samsara-campaign-1', 'samsara-campaign-1', 'samsara-campaign-1'])
      expect(h.jobs.killed[0]).toEqual(['samsara-campaign-1', h.agent, 'stopped by /samsara stop'])
    })
    it('never matches a round id against a label: a job that merely mentions the id is not the round\'s', async () => {
      const h = host()
      h.ledger.rounds.push(round({ id: 'r1', experiment_id: 'e9' }))
      expect(await h.run('stop r1')).toEqual({ kind: 'error', text: 'no samsara job r1 is owned by this session' })
      expect(h.jobs.killed).toEqual([])
    })
    it('refuses a job that is not a samsara job, an unknown id and a missing id', async () => {
      const h = host()
      expect(await h.run('stop bash-1')).toEqual({ kind: 'error', text: 'no samsara job bash-1 is owned by this session' })
      expect(await h.run('stop nope')).toEqual({ kind: 'error', text: 'no samsara job nope is owned by this session' })
      expect((await h.run('stop')).text).toContain('a job or round id is required')
      expect(h.jobs.killed).toEqual([])
    })
  })

  describe('reconcile', () => {
    /** One open round with a running sibling (c1) and a judged one (c2); another open round with the judged one only. */
    const stale = () => {
      const h = host()
      h.ledger.challengers.set('c1', challenger({ id: 'c1', status: 'running', verdict: undefined }))
      h.ledger.challengers.set('c2', challenger({ id: 'c2', status: 'judged' }))
      h.ledger.rounds.push(round({ id: 'r1', sibling_ids: ['c1', 'c2'] }), round({ id: 'r2', sibling_ids: ['c2'] }))
      h.lifecycle.rounds = h.ledger.rounds
      return h
    }
    it('lists the rounds open with a running sibling and writes nothing', async () => {
      const h = stale()
      const r = await h.run('reconcile')
      expect(r.kind).toBe('success')
      expect(r.text).toContain('round r1: running c1')
      expect(r.text).not.toContain('r2')
      expect(r.text).toContain('/samsara reconcile <round-id>')
      expect(h.ledger.patches).toEqual([])
      expect(await host().run('reconcile')).toEqual({ kind: 'success', text: 'no round is open with a running sibling' })
    })
    it('closes one round aborted: the running sibling judged invalid under the abort rule, the outcome aborted; once', async () => {
      const h = stale()
      const r = await h.run('reconcile r1')
      expect(r.kind).toBe('success')
      expect(r.text).toContain(`challenger c1 was running in round r1; judged invalid (${ABORT_RULE})`)
      expect(r.text).toContain('round r1 closed aborted (1 running)')
      expect(h.lifecycle.aborted).toEqual(['r1'])
      expect(h.ledger.challenger('c1')).toMatchObject({ status: 'judged', verdict: { value: 'invalid', by: 'lifecycle', rule: ABORT_RULE, round_id: 'r1' } })
      expect(h.ledger.challenger('c2')!.status).toBe('judged')
      expect(h.ledger.round('r1')).toMatchObject({ status: 'decided', outcome: { superseded: [], aborted: true } })
      expect(h.ledger.round('r1')!.closed_at).toMatch(/^\d{4}-/)
      expect(await h.run('reconcile r1')).toEqual({ kind: 'error', text: 'round r1 is not open with a running sibling; nothing to reconcile' })
    })
    it('refuses a round a job of this host is driving, a round that is not stale, and extra arguments', async () => {
      const h = stale()
      jobTags.set(JobId('samsara-campaign-1'), { experiment_id: 'e1', round_ids: ['r1'] })
      expect(await h.run('reconcile r1')).toEqual({ kind: 'error', text: 'round r1 is driven by job samsara-campaign-1 of this host; /samsara stop it first' })
      expect(await h.run('reconcile r2')).toEqual({ kind: 'error', text: 'round r2 is not open with a running sibling; nothing to reconcile' })
      expect((await h.run('reconcile r1 r2')).text).toContain('unexpected "r2"')
      expect(h.ledger.patches).toEqual([])
    })
  })
})
