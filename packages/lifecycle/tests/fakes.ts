// Fakes for the service tests: an in-memory ledger over the slice the
// service uses, a champion that keeps state in memory and emits its events,
// a gate registry, a scope manager that never scans, an executor that
// records deterministic attempts through the ledger.

import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'
import { Context } from '@oldbulb/samsara-kernel'
import { EMPTY_STATE, stateOf, type ChampionEvents, type ChampionState, type KeptPatch, type RescoreEvent, type SettledEvent } from '@oldbulb/samsara-champion'
import { gateDefault, GATE_DEFAULT_NAME, GATE_DEFAULT_VERSION, type CompareRequest, type GatePolicyProvider } from '@oldbulb/samsara-gate'
import {
  challengerId, compareKey, evalConfigSha, experimentId, LedgerError, noiseFloorId, roundId, scoreKey,
  type AttemptRow, type ChallengerProposal, type ChallengerRow, type CompareRow, type ConsentRow, type ExperimentInput, type ExperimentRow,
  type NoiseFloorInput, type NoiseFloorRow, type RoundInput, type RoundRow, type ScoreRow, type ServingRow, type SettlementRow, type View, type ViewRows, type Viewer,
} from '@oldbulb/samsara-ledger'
import { loadPack } from '@oldbulb/samsara-pack'
import type { Challenger, Scope, Violation } from '@oldbulb/samsara-scope'
import { ScopeError } from '@oldbulb/samsara-scope'
import { Lifecycle, type Executor, type LifecycleChampion, type LifecycleLedger, type RunDeps, type RunOptions, type RunRequest, type RunResult } from '../src/index.ts'

export const sha = (s: string) => createHash('sha256').update(s).digest('hex')
export const PACK = resolve(import.meta.dirname, 'fixtures', 'pack')
export const DEFAULT = `${GATE_DEFAULT_NAME}@${GATE_DEFAULT_VERSION}`
export const GATE_DEFAULT: GatePolicyProvider = { name: GATE_DEFAULT_NAME, version: GATE_DEFAULT_VERSION, judge: gateDefault }
/** A test policy: gate-default's statistics with the interval collapsed to the mean and holdout forced to promote. */
export const GATE_PICK: GatePolicyProvider = {
  name: 'gate-pick',
  version: 'test',
  judge: (req: CompareRequest) => {
    const j = gateDefault(req)
    return { compare: { ...j.compare, ci: [j.compare.mean, j.compare.mean] }, verdict: req.tier === 'holdout' ? 'promote' : j.verdict }
  },
}

// ------------------------------------------------------------- proposals

export function championProposal(over: Partial<ChallengerProposal> = {}): ChallengerProposal {
  return {
    parent_ids: [], patch_sha: sha(''), harness_sha: sha('h'), env_sha: sha('e'), skill_sha: sha('s'), taskset_sha: sha('t'),
    route: { loop: 'fake', loop_adapter_version: '1', model_id: 'm', model_pool_sha: sha('mp'), base_url_kind: 'direct' },
    optimizer_config_sha: sha(''), lineage: 'main', surface: 'skill', patch: { skill_ref: `skill:${sha('s')}` }, intent: 'champion',
    prediction: { metric: '', direction: 'up' }, scorer_version: '0', task_version: 0, truth_snapshot_id: sha('t'), report_rule_version: '0',
    runtime: { timeout_s: 60, step_cap: 5 }, tasksets: { smoke: sha('a'), holdin: sha('b'), holdout: sha('c') }, budget: 2,
    ...over,
  }
}

/** A skill challenger of the champion: same coordinates, its own patch, the round's metric, the pack name. */
export function challengerProposal(championId: string, intent: string, over: Partial<ChallengerProposal> = {}): ChallengerProposal {
  const skill_sha = sha(intent)
  return {
    ...championProposal(),
    parent_ids: [championId], patch_sha: skill_sha, skill_sha, patch: { skill_ref: `/skills/${intent}`, before: `skill:${sha('s')}` },
    intent, prediction: { metric: 'm', direction: 'up' }, pack: 'fixture', proposed_at: `2026-08-26T00:00:00.${String(intent.charCodeAt(0)).padStart(3, '0')}Z`,
    ...over,
  }
}

/** A consent row as the socket path would record it; a `promote` names the round it decides (`round_id`). */
export function consent(challenger_id: string, action: ConsentRow['action'], id = `${action}-${challenger_id.slice(0, 6)}`, round_id?: string): ConsentRow {
  return { id, challenger_id, action, who: 'human', channel: 'test', proof_sha: sha(id), at: new Date().toISOString(), ...(round_id !== undefined ? { round_id } : {}) }
}

// ---------------------------------------------------------------- ledger

export class FakeLedger implements LifecycleLedger {
  challengers = new Map<string, ChallengerRow>()
  attempts = new Map<string, AttemptRow>()
  scores = new Map<string, ScoreRow>()
  compares = new Map<string, CompareRow>()
  consents: ConsentRow[] = []
  rounds = new Map<string, RoundRow>()
  floors = new Map<string, NoiseFloorRow>()
  servingRows = new Map<string, ServingRow>()
  settlements: SettlementRow[] = []
  experimentRows = new Map<string, ExperimentRow>()
  statusLog: { id: string; status: string; verdict?: string }[] = []

  async propose(p: ChallengerProposal): Promise<string> {
    const id = challengerId(p)
    if (!this.challengers.has(id)) {
      this.challengers.set(id, { ...p, id, pack: p.pack ?? '', eval_config_sha: evalConfigSha(p), status: 'proposed', proposed_at: p.proposed_at ?? new Date().toISOString() })
    }
    return id
  }
  async setStatus(id: string, status: ChallengerRow['status'], patch: Partial<Pick<ChallengerRow, 'tier_reached' | 'verdict' | 'opened'>> = {}): Promise<ChallengerRow> {
    const cur = this.challengers.get(id)
    if (!cur) throw new LedgerError(`no challenger ${id}`, 'UNKNOWN_CHALLENGER')
    const next = { ...cur, ...patch, status }
    this.challengers.set(id, next)
    this.statusLog.push({ id, status, ...(patch.verdict ? { verdict: patch.verdict.value } : {}) })
    return next
  }
  async recordAttempt(row: AttemptRow): Promise<string> {
    const existing = this.attempts.get(row.id)
    if (existing && existing.challenger_id !== row.challenger_id) throw new LedgerError(`attempt ${row.id} belongs to challenger ${existing.challenger_id}, not ${row.challenger_id}`, 'ATTEMPT_EXISTS')
    this.attempts.set(row.id, row)
    return row.id
  }
  async appendScores(rows: ScoreRow[]): Promise<string[]> {
    const written: string[] = []
    for (const r of rows) {
      const key = scoreKey(r)
      if (this.scores.has(key)) continue
      this.scores.set(key, r)
      written.push(key)
    }
    return written
  }
  async recordCompare(row: CompareRow): Promise<string> {
    const key = compareKey(row)
    if (this.compares.has(key)) throw new LedgerError(`a verdict already exists for ${key}`, 'VERDICT_EXISTS')
    this.compares.set(key, row)
    return key
  }
  async openRound(input: RoundInput): Promise<RoundRow> {
    const opened_at = input.opened_at ?? new Date().toISOString()
    const id = roundId({ ...input, opened_at })
    const existing = this.rounds.get(id)
    if (existing) return existing
    const sibling_ids = input.sibling_ids ?? []
    const row: RoundRow = { ...input, id, opened_at, sibling_ids, k: sibling_ids.length, status: 'open' }
    this.rounds.set(id, row)
    return row
  }
  async updateRound(id: string, patch: Partial<Pick<RoundRow, 'status' | 'sibling_ids' | 'noise_floor_id' | 'best_so_far' | 'closed_at' | 'outcome'>>): Promise<RoundRow> {
    const cur = this.rounds.get(id)
    if (!cur) throw new LedgerError(`no round ${id}`, 'UNKNOWN_ROUND')
    const next = { ...cur, ...patch }
    next.k = next.sibling_ids.length
    this.rounds.set(id, next)
    return next
  }
  async recordNoiseFloor(input: NoiseFloorInput): Promise<string> {
    const id = noiseFloorId(input)
    if (!this.floors.has(id)) this.floors.set(id, { ...input, id })
    return id
  }
  async recordServing(row: ServingRow): Promise<string> {
    const existing = this.servingRows.get(row.id)
    if (!existing) this.servingRows.set(row.id, row)
    else if (row.to !== undefined && existing.to === undefined) this.servingRows.set(row.id, { ...existing, to: row.to })
    return row.id
  }
  async createExperiment(input: ExperimentInput): Promise<ExperimentRow> {
    const created_at = input.created_at ?? new Date().toISOString()
    const id = experimentId({ ...input, created_at })
    const existing = this.experimentRows.get(id)
    if (existing) return existing
    const row: ExperimentRow = { ...input, id, created_at, status: 'active', round_ids: [], spent: { usd: 0, attempts: 0, rounds: 0, holdout_reveals: 0 } }
    this.experimentRows.set(id, row)
    return row
  }
  async updateExperiment(id: string, patch: Partial<Pick<ExperimentRow, 'spent' | 'round_ids' | 'status' | 'closed_at' | 'budget' | 'budget_changes'>>): Promise<ExperimentRow> {
    const cur = this.experimentRows.get(id)
    if (!cur) throw new LedgerError(`no experiment ${id}`, 'UNKNOWN_EXPERIMENT')
    const next = { ...cur, ...patch }
    this.experimentRows.set(id, next)
    return next
  }
  challenger(id: string) { return this.challengers.get(id) }
  attemptsOf(id: string) { return [...this.attempts.values()].filter((a) => a.challenger_id === id) }
  scoresOf(id: string) { return [...this.scores.values()].filter((s) => s.attempt_id === id) }
  comparesOf(id: string) { return [...this.compares.values()].filter((c) => c.challenger_id === id) }
  consentsOf(id: string) { return this.consents.filter((c) => c.challenger_id === id) }
  round(id: string) { return this.rounds.get(id) }
  roundsOf(championId: string) { return [...this.rounds.values()].filter((r) => r.champion_id === championId).sort((a, b) => (a.opened_at < b.opened_at ? -1 : 1)) }
  noiseFloorFor(eval_config_sha: string, champion_id: string, loop: string, metric: string) {
    let latest: NoiseFloorRow | undefined
    for (const f of this.floors.values()) {
      if (f.eval_config_sha !== eval_config_sha || f.champion_id !== champion_id || f.loop !== loop || f.metric !== metric) continue
      if (!latest || f.measured_at > latest.measured_at) latest = f
    }
    return latest
  }
  servings() { return [...this.servingRows.values()].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0)) }
  experiment(id: string) { return this.experimentRows.get(id) }
  experiments() { return [...this.experimentRows.values()] }
  read<N extends View>(view: N, _viewer: Viewer): ViewRows[N] {
    const rows: Record<View, unknown[]> = {
      challengers: [...this.challengers.values()], attempts: [...this.attempts.values()], scores: [...this.scores.values()],
      compares: [...this.compares.values()], consents: this.consents, settlements: this.settlements, rounds: [...this.rounds.values()],
      noise_floors: [...this.floors.values()], servings: this.servings(), experiments: this.experiments(),
    }
    return rows[view] as ViewRows[N]
  }
}

// -------------------------------------------------------------- champion

export class FakeChampion implements LifecycleChampion {
  state: ChampionState = EMPTY_STATE
  promoted: [string, string][] = []
  demoted: string[] = []
  plan: RescoreEvent[] = []
  settled: SettledEvent[] = []
  private readonly emitter = new EventEmitter()

  constructor(private readonly ledger: FakeLedger) {}

  current(): ChampionState { return this.state }
  async promote(id: string, consentId: string): Promise<ChampionState> {
    if (this.state.kept.some((k) => k.challenger_id === id)) return this.state
    const row = this.ledger.challenger(id)!
    const kept: KeptPatch = { challenger_id: id, surface: row.surface, ref: `skill:${row.skill_sha}`, rows: [], consent_id: consentId, promoted_at: new Date().toISOString() }
    this.state = stateOf([...this.state.kept, kept])
    this.promoted.push([id, consentId])
    this.emitter.emit('champion/changed', this.state)
    return this.state
  }
  async demote(id: string): Promise<ChampionState> {
    if (!this.state.kept.some((k) => k.challenger_id === id)) throw new Error(`challenger ${id} is not kept`)
    this.state = stateOf(this.state.kept.filter((k) => k.challenger_id !== id))
    this.demoted.push(id)
    this.emitter.emit('champion/changed', this.state)
    return this.state
  }
  async onSettlement(event: SettledEvent): Promise<RescoreEvent[]> {
    this.settled.push(event)
    // As the real champion does: the settlement row lands on the ledger with the rows it re-scores.
    const { task_ids: _tasks, ...row } = event
    this.ledger.settlements.push({ ...row, triggered_rescoring: this.plan.map((p) => p.challenger_id) })
    return this.plan
  }
  on<K extends keyof ChampionEvents>(event: K, listener: (...args: ChampionEvents[K]) => void): () => void {
    this.emitter.on(event, listener as (...args: unknown[]) => void)
    return () => { this.emitter.off(event, listener as (...args: unknown[]) => void) }
  }
}

// ------------------------------------------------------------ gate, scopes

export class FakeGate {
  constructor(public policies: GatePolicyProvider[] = [GATE_DEFAULT]) {}
  current() { return this.policies.at(-1) }
  list() { return [...this.policies] }
}

export class FakeScopes {
  opened: Challenger[] = []
  disposed: string[] = []
  reject: Violation[] | undefined
  /** Runs while the scope opens (the E1 test changes the champion state here). */
  onOpen: (() => void) | undefined
  async open(challenger: Challenger): Promise<Scope> {
    if (this.reject) throw new ScopeError('PATCH_REJECTED', 'rejected', this.reject)
    this.opened.push(challenger)
    this.onOpen?.()
    const scope = {
      scopeId: `${challenger.id}-${this.opened.length}`, challengerId: challenger.id,
      skillDir: challenger.patch.surface === 'skill' ? challenger.patch.skill_dir : undefined,
      harnessSha: sha('harness'), envSha: sha('env'), entryIds: [], unappliedRows: [],
      dispose: async () => { this.disposed.push(challenger.id) },
    }
    return scope as unknown as Scope
  }
}

// -------------------------------------------------------------- executor

/** Records tasks × repeat COMPLETED attempts under `deps.challengerId`, scored on metric `m` by `value`. */
export class FakeExecutor implements Executor {
  calls: { req: RunRequest; challengerId: string | undefined; runId: string | undefined }[] = []
  values = new Map<string, number>()
  value: (challengerId: string, taskId: string, sample: number) => number = (id) => this.values.get(id) ?? 0.5
  facts: (challengerId: string, taskId: string) => string = () => sha('facts')
  async runSet(req: RunRequest, deps: RunDeps): Promise<RunResult> {
    const def = loadPack(req.pack)
    const challengerId = deps.challengerId ?? 'champion'
    const runId = deps.runId ?? 'run'
    this.calls.push({ req, challengerId: deps.challengerId, runId: deps.runId })
    const tasks = def.taskSets[req.set].tasks.slice(0, req.limit)
    const rows: RunResult['rows'] = []
    for (const task of tasks) {
      for (let r = 0; r < req.repeat; r++) {
        const id = `${runId}-${task.task_id}-${r}`
        const value = this.value(challengerId, task.task_id, r)
        await deps.ledger?.recordAttempt({
          id, challenger_id: challengerId, task_id: task.task_id, sample: r, loop: req.loop, tier: req.set, status: 'COMPLETED', stop_reason: 'completed',
          facts_sha: this.facts(challengerId, task.task_id), usage: { input_tokens: 1, output_tokens: 1 }, cost: { usd: 0.01, tokens: 2 }, output: { source: 'file', valid: true }, artifacts: [],
        })
        await deps.ledger?.appendScores([{ attempt_id: id, scorer_version: '0', truth_snapshot_id: sha('t'), metric: 'm', value, kind: 'reality' }])
        rows.push({ attemptId: id, task_id: task.task_id, loop: req.loop, facts_sha: this.facts(challengerId, task.task_id), status: 'COMPLETED', cost: { usd: 0.01 }, scores: [{ task_id: task.task_id, metric: 'm', value, kind: 'reality' }] })
      }
    }
    return { runId, pack: def.name, set: req.set, tasksetSha: sha(req.set), challengerId, rows, attemptsPath: resolve(req.out, 'attempts.jsonl') }
  }
}

const FACTS = {
  systemPromptMode: 'none', skillDelivery: 'agents-skills-dir', schemaEnforcement: 'permissive-tool', permission: 'none', reasoning: {},
  envelope: { config: 'absent', system: 'absent', tools: 'absent' }, version: { loop: 'fake' },
} as const

export function fakeLoops() {
  const provider = { name: 'fake', harnessFacts: FACTS, capabilities: { perAttemptBaseUrl: false, perAttemptEnv: false, nativeSchema: 'none', toolFilter: false, nativeMaxTurns: false }, start: async () => { throw new Error('the fake executor never starts a loop') } }
  return { get: (name: string) => (name === 'fake' ? provider : undefined), start: provider.start }
}

// ----------------------------------------------------------------- setup

export interface Harness {
  ctx: Context
  ledger: FakeLedger
  champion: FakeChampion
  gate: FakeGate
  scopes: FakeScopes
  executor: FakeExecutor
  lifecycle: Lifecycle
}

/** A service over fresh fakes; `ledger` reuses one (a second process over the same rows). */
export async function openLifecycle(over: { gate?: GatePolicyProvider[]; ledger?: FakeLedger } = {}): Promise<Harness> {
  const ctx = new Context()
  const ledger = over.ledger ?? new FakeLedger()
  const champion = new FakeChampion(ledger)
  const gate = new FakeGate(over.gate)
  const scopes = new FakeScopes()
  const executor = new FakeExecutor()
  ctx.provide('ledger', ledger)
  ctx.provide('scopes', scopes)
  ctx.provide('gate', gate)
  ctx.provide('loops', fakeLoops())
  ctx.provide('champion', champion)
  ctx.provide('executor', executor)
  await ctx.plugin(Lifecycle)
  return { ctx, ledger, champion, gate, scopes, executor, lifecycle: ctx.lifecycle }
}

export function runOptions(out: string, over: Partial<RunOptions> = {}): RunOptions {
  return { repeat: 1, out, maxTurns: 5, maxMinutes: 1, route: { provider: 'p', model: 'm', credentialRef: 'cred' }, ...over }
}
