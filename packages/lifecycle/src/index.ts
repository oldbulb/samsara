// @oldbulb/samsara-lifecycle — `ctx.lifecycle`: every transition of a
// challenger row and of a round.
//
// The runner's commands, the workbench tools and the UI call this service;
// none of them writes `status`, `verdict`, `compares`, `rounds`, `servings`,
// `noise_floors` or `experiments` themselves. Each transition asserts its invariant
// (architecture.md § Lifecycle): propose is comparable with its parent
// (rule 0), open leaves the profile untouched (E1), run pools no two
// harnesses (facts_sha), judge uses the round's gate and noise floor and checks
// the facts again, decide promotes at most one sibling — a holdout verdict of
// this round under its gate, against the champion state the round opened on —
// and only with a consent, settle debits the holdout budget. Attempts run through the injected executor (the runner's
// runSet), never here. The promotion gate is the policy the host mounted on
// ctx.gate, which must be gate-default or a policy a `gate_change` consent
// names; a round may pin another mounted policy on the same terms, and any
// other judges as a shadow (a compare row that sets no verdict).

import { EventEmitter } from 'node:events'
import { basename, resolve } from 'node:path'
import { createBook, HoldoutBudgetExhausted, type Book, type Task, type TaskSet } from '@oldbulb/samsara-book'
import { compareRowOf, stateSha, type Champion, type ChampionState, type CompareCoords, type RescoreEvent, type SettledEvent } from '@oldbulb/samsara-champion'
import { gateMethodOf, sd, GATE_DEFAULT_NAME, GATE_DEFAULT_VERSION, type CompareRequest, type GatePolicy, type GatePolicyProvider, type GateRegistry, type GateVerdictRow } from '@oldbulb/samsara-gate'
import type {} from '@oldbulb/samsara-environments'
import { Context, Service } from '@oldbulb/samsara-kernel'
import type { PatchOptions } from '@oldbulb/samsara-kernel'
import {
  canonicalJson,
  challengerId as challengerIdOf,
  compareKey,
  evalConfigSha,
  LedgerError,
  roundId as roundIdOf,
  sha256,
  type AttemptRow,
  type BudgetChange,
  type ChallengerProposal,
  type ChallengerRow,
  type CompareRow,
  type ConsentRow,
  type ExperimentInput,
  type ExperimentRow,
  type Ledger,
  type NoiseFloorRow,
  type RoundRow,
  type ScoreRow,
  type ServingRow,
  type Tier,
} from '@oldbulb/samsara-ledger'
import { loadPack, protectedPaths, surfaceBoundaries, type PackDefinition } from '@oldbulb/samsara-pack'
import { ScopeError, type Patch, type Scope, type ScopeManager } from '@oldbulb/samsara-scope'
import { nextActionsOf, type NextAction } from './actions.ts'
import { latestAttempts, scoredAttemptsOf } from './attempts.ts'
import { runCampaign, type CampaignEvent, type CampaignHooks, type CampaignInput, type CampaignResult } from './campaign.ts'
import { comparable, evalConfigShaOf, gateRefOf, policySha, refMethod, roundPolicy } from './comparable.ts'
import { runControl, type ControlHooks, type ControlInput, type ControlResult } from './controls.ts'
import type { Executor, RouteConfig, RunDeps, RunResult } from './executor.ts'

export * from './executor.ts'
export * from './comparable.ts'
export * from './actions.ts'
export * from './campaign.ts'
export * from './controls.ts'
export { latestAttempts, scoredAttemptsOf } from './attempts.ts'

declare module '@oldbulb/samsara-kernel' {
  interface Context {
    lifecycle: Lifecycle
    executor: Executor
  }
}

export type LifecycleErrorCode =
  | 'NOT_COMPARABLE'
  | 'GATE_NOT_CONSENTED'
  | 'GATE_MISMATCH'
  | 'PROFILE_CHANGED'
  | 'NO_NOISE_FLOOR'
  | 'ROUND_CLOSED'
  | 'NOT_IN_ROUND'
  | 'BAD_TRANSITION'
  | 'NO_CONSENT'
  | 'BUDGET_EXCEEDED'
  | 'OPERATOR_IS_PROPOSER'
  | 'UNKNOWN'

export class LifecycleError extends Error {
  constructor(readonly code: LifecycleErrorCode, message: string, readonly detail?: unknown) {
    super(message)
    this.name = 'LifecycleError'
  }
}

/** The slice of `ctx.ledger` the service uses (structural, so fakes compose). */
export type LifecycleLedger = Pick<Ledger,
  | 'propose' | 'challenger' | 'setStatus' | 'attemptsOf' | 'scoresOf' | 'comparesOf' | 'consentsOf' | 'recordCompare'
  | 'openRound' | 'round' | 'roundsOf' | 'updateRound' | 'recordNoiseFloor' | 'noiseFloorFor'
  | 'recordServing' | 'servings' | 'createExperiment' | 'experiment' | 'experiments' | 'updateExperiment' | 'read'
  | 'recordAttempt' | 'appendScores'>

export type LifecycleChampion = Pick<Champion, 'current' | 'promote' | 'demote' | 'onSettlement' | 'on'>
export type LifecycleGate = Pick<GateRegistry, 'current' | 'list'>
export type LifecycleScopes = Pick<ScopeManager, 'open'>

/** The route a proposer declares (the model proposer's configured model, and a provider when it names one). */
export interface ProposerRoute {
  provider?: string
  model?: string
}

export interface OpenRoundInput {
  /** The pack directory. */
  pack: string
  /** The champion row for these coordinates (the runner's `championProposal`); proposed idempotently, its prediction set to the round's metric. */
  champion: ChallengerProposal
  /** Primary metric (kind reality) the round decides on. */
  metric: string
  nEffFloor: number
  /** `name@version` of a mounted policy to judge with instead of the promotion gate; needs a `gate_change` consent unless it is the promotion gate. */
  gate?: string
  /** `name@version` of mounted policies judged beside the round's gate; their rows set no verdict. */
  shadowGates?: string[]
  experimentId?: string
  operator?: RoundRow['operator']
  /**
   * The route the round's proposer runs on, as its adapter declares it;
   * `'unknown'` when the adapter declares none (a command proposer's own route
   * is opaque to the host). Refused with `OPERATOR_IS_PROPOSER` when it is the
   * operator's: the same model cannot propose and operate a round.
   */
  proposerRoute?: ProposerRoute | 'unknown'
  openedAt?: string
  bestSoFar?: number
}

export interface RunOptions {
  repeat: number
  out: string
  maxTurns: number
  maxMinutes: number
  allow?: string[]
  parallel?: number
  limit?: number
  stratum?: string[]
  /** The environment provider the attempts run in (as registered on ctx.environments); default `local`. */
  env?: string
  route: RouteConfig
  /** Run the champion on the same tasks in this call instead of reusing its ledger attempts. */
  withChampion?: boolean
  /** The champion's kept skill snapshot (ctx.champion.current().skill_ref). */
  championSkillDir?: string
  signal?: AbortSignal
  log?: (line: string) => void
  runId?: string
}

export interface RunSummary {
  challengerId: string
  championId: string
  tier: Tier
  champion?: RunResult
  challenger: RunResult
  /** Set when the run invariant failed: the verdict rule recorded (`coordinates:facts`), no statistics follow. */
  invalid?: string
}

export type RoundOutcome =
  | { pending: 'consent'; roundId: string; candidate: string }
  | { pending?: undefined; roundId: string; promoted?: string; superseded: string[]; consentId?: string }

export interface CalibrateInput {
  /** The pack directory. */
  pack: string
  /** The champion row for these coordinates; its attempts are recorded under it and stay reusable by later rounds. */
  champion: ChallengerProposal
  metric: string
  set: TaskSet
  /** Same-config reruns of every task (>= 3, S1). */
  reruns: number
  run: Omit<RunOptions, 'repeat' | 'withChampion'>
}

export interface PendingConsent {
  roundId: string
  candidate: string
  action: 'promote'
}

export interface LifecycleStatus {
  champion: ChampionState
  /** Rounds not yet decided. */
  rounds: RoundRow[]
  pending: PendingConsent[]
  /** The latest noise floor per (eval_config_sha, champion_id, loop, metric). */
  noiseFloors: NoiseFloorRow[]
  experiments: ExperimentRow[]
}

/**
 * What a live view subscribes to (`on('lifecycle/event', ...)`): every
 * transition the service writes, the campaign's events, and the rows it
 * records beside them. `attempt/progress` is per finished executor run (the
 * executor reports lines, not counts).
 */
export type LifecycleEvent =
  | { kind: 'round/opened'; roundId: string; championId: string; experimentId?: string; at: string }
  | { kind: 'round/closed'; roundId: string; at: string }
  | { kind: 'round/decided'; roundId: string; promoted?: string; superseded: string[]; consentId?: string; at: string }
  | { kind: 'challenger/transition'; challengerId: string; roundId?: string; status: ChallengerRow['status']; tier?: Tier; at: string }
  | { kind: 'attempt/progress'; challengerId: string; roundId?: string; tier: Tier; done: number; total: number; at: string }
  | { kind: 'campaign'; roundId?: string; experimentId: string; event: CampaignEvent; at: string }
  | { kind: 'noise_floor/recorded'; id: string; at: string }
  | { kind: 'consent/recorded'; id: string; action: ConsentRow['action']; at: string }

export interface LifecycleEvents {
  'lifecycle/event': [event: LifecycleEvent]
}

/** An event before the service stamps `at`. */
type Unstamped<E> = E extends unknown ? Omit<E, 'at'> : never

/** What the round row does not carry and the service needs in-process: the pack, the policy behind `gate.policy_sha`, the metric. */
interface RoundContext {
  pack: string
  policy: GatePolicy
  metric: string
  nEffFloor: number
}

interface PackContext {
  def: PackDefinition
  book: Book
}

const DEFAULT_GATE = `${GATE_DEFAULT_NAME}@${GATE_DEFAULT_VERSION}`
const BY_LIFECYCLE = 'lifecycle'

/** The rule a running sibling is judged invalid under when its round is aborted: the process driving it is gone. */
export const ABORT_RULE = 'aborted:restart'

/** The fixed points and their writers: services on the host root tree that a challenger scope never resolves (architecture.md § Surfaces). */
export const ISOLATED_SERVICES: readonly string[] = ['ledger', 'gate', 'signoff', 'champion', 'lifecycle']

let runSeq = 0

/** Unique per call in this process (ms timestamp + counter): two calls in the same second never share attempt ids. */
function newRunId(now = new Date()): string {
  const ts = now.toISOString().replace(/[-:]/g, '')
  return `run-${ts}-${++runSeq}`
}

function verdictValueOf(j: GateVerdictRow): NonNullable<ChallengerRow['verdict']>['value'] {
  return j.verdict === 'hold:underpowered' ? 'hold' : j.verdict
}

function latestBy<T>(rows: readonly T[], at: (r: T) => string): T | undefined {
  return [...rows].sort((a, b) => (at(a) < at(b) ? 1 : at(a) > at(b) ? -1 : 0))[0]
}

function normalized(s: string): string {
  return s.trim().toLowerCase()
}

/** The normalized (provider, model) pairs agree: both name a model and the models equal, and the providers too when both sides name one. */
export function sameRoute(operator: Pick<NonNullable<RoundRow['operator']>, 'provider' | 'model'>, proposer: ProposerRoute): boolean {
  if (operator.model === undefined || proposer.model === undefined || normalized(operator.model) !== normalized(proposer.model)) return false
  return operator.provider === undefined || proposer.provider === undefined || normalized(operator.provider) === normalized(proposer.provider)
}

function selectTasks(book: Book, set: TaskSet, opts: { limit?: number; stratum?: string[] }): readonly Task[] {
  const all = book.tasks(set)
  const chosen = opts.stratum ? all.filter((t) => opts.stratum!.includes(t.stratum ?? '')) : all
  return chosen.slice(0, opts.limit ?? undefined)
}

/** The harness facts behind the latest attempt on each (task, sample) pair of these tasks for one loop. */
function factsOf(rows: readonly AttemptRow[], loop: string, tasks: ReadonlyMap<string, string>): Map<string, string> {
  return new Map(latestAttempts(rows.filter((a) => a.loop === loop), tasks).map((a) => [`${a.task_id}\0${a.sample}`, a.facts_sha]))
}

/**
 * The run invariant, pair by pair: on every (task, sample) the challenger
 * ran, the champion ran too and under the same facts. An attempt's
 * environment is in its facts, and a pack whose task rows bring their own
 * environments has one per task, so the arms are held to agree per pair, not
 * to one sha per loop. A champion with no attempt on these tasks has nothing
 * to pair on.
 */
function factsAgree(champion: ReadonlyMap<string, string>, challenger: ReadonlyMap<string, string>): boolean {
  if (champion.size === 0) return false
  for (const [pair, sha] of challenger) if (champion.get(pair) !== sha) return false
  return true
}

/** The one sha behind every pair, when there is one (the gate's own rule 0 runs on it). */
function oneFacts(facts: ReadonlyMap<string, string>): string | undefined {
  const shas = new Set(facts.values())
  return shas.size === 1 ? [...shas][0] : undefined
}

/** The pack's book; a held-out set sharing an entity with the visible sets is refused here (S2/S7: `HoldoutNotDisjoint`). */
function bookOf(def: PackDefinition): Book {
  const book = createBook({
    sets: { smoke: def.taskSets.smoke.tasks, holdin: def.taskSets.holdin.tasks, holdout: def.taskSets.holdout.tasks },
    entityKey: 'entity_key',
    holdoutPolicy: { mde: def.manifest.holdout?.mde ?? 0.05, budget: def.manifest.holdout?.budget ?? 0 },
  })
  book.assertDisjointHoldout()
  return book
}

/** The truth snapshot behind each (task, sample) pair's primary-metric score, from the latest attempts on these tasks. */
function truthOf(attempts: readonly AttemptRow[], scoresOf: (attemptId: string) => ScoreRow[], tasks: ReadonlyMap<string, string>, metric: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const a of latestAttempts(attempts, tasks)) {
    const score = scoresOf(a.id).find((s) => s.metric === metric)
    if (score) out.set(`${a.task_id}\0${a.sample}`, score.truth_snapshot_id)
  }
  return out
}

/** S5: how the proposer's prediction fared on the paired deltas; absent when the row predicted nothing per task. */
function predictedVsObserved(prediction: ChallengerRow['prediction'], perTask: readonly { taskId: string; delta: number }[]): CompareRow['predicted_vs_observed'] | undefined {
  const fixes = prediction.predicted_fixes ?? []
  const atRisk = prediction.at_risk ?? []
  if (fixes.length === 0 && atRisk.length === 0) return undefined
  const deltaOf = new Map(perTask.map((d) => [d.taskId, d.delta]))
  const hit = (ids: readonly string[], test: (delta: number) => boolean) => (ids.length === 0 ? 0 : ids.filter((t) => { const d = deltaOf.get(t); return d !== undefined && test(d) }).length / ids.length)
  return { fixes_hit: hit(fixes, (d) => d > 0), at_risk_hit: hit(atRisk, (d) => d < 0) }
}

export class Lifecycle extends Service {
  static inject = ['ledger', 'scopes', 'gate', 'loops', 'champion']

  private readonly packs = new Map<string, PackContext>()
  private readonly rounds = new Map<string, RoundContext>()
  private readonly open_ = new Map<string, Scope>()
  /** Why a kept row is being dropped (a demote with its consent, or a reversal), consumed when its serving row is written. */
  private readonly demotions = new Map<string, Pick<ServingRow, 'by' | 'consent_id'>>()
  private readonly emitter = new EventEmitter()
  private chain: Promise<void> = Promise.resolve()

  constructor(ctx: Context) {
    super(ctx, 'lifecycle')
  }

  protected [Service.init](): void {
    // Every champion change (a promotion here, a demotion here, a reversal
    // through rescore) lands as servings rows; the explicit calls below
    // await the same queue so a caller sees its rows written.
    this.ctx.effect(() => this.champion.on('champion/changed', () => { this.sync().catch(() => {}) }), 'lifecycle.servings')
  }

  private get ledger(): LifecycleLedger {
    return this.ctx.ledger
  }

  private get scopes(): LifecycleScopes {
    return this.ctx.scopes
  }

  private get gate(): LifecycleGate {
    return this.ctx.gate
  }

  private get champion(): LifecycleChampion {
    return this.ctx.champion
  }

  private get executor(): Executor {
    const executor = this.ctx.get('executor') as Executor | undefined
    if (!executor) throw new LifecycleError('BAD_TRANSITION', 'no attempt executor is mounted on ctx.executor (the runner provides it)')
    return executor
  }

  /** The environments registry the executor opens attempts on, when the host mounts one (read per run: it is no injection of this service). */
  private environmentDeps(): Pick<RunDeps, 'environments'> {
    const environments = this.ctx.get('environments')
    return environments !== undefined ? { environments } : {}
  }

  /** E4: an environment the executor opens for this challenger is disposed with its scope, through the scope's own context. */
  private trackOn(scope: Scope | undefined): Pick<RunDeps, 'track'> {
    const ctx = scope?.ctx
    if (ctx === undefined) return {}
    return { track: (dispose) => ctx.effect(() => () => dispose(), 'lifecycle.environment') }
  }

  on<K extends keyof LifecycleEvents>(event: K, listener: (...args: LifecycleEvents[K]) => void): () => void {
    this.emitter.on(event, listener as (...args: unknown[]) => void)
    return () => { this.emitter.off(event, listener as (...args: unknown[]) => void) }
  }

  // ------------------------------------------------------------ rounds

  /** Pre-register an experiment before any spend: the ledger row, deduplicated by content. */
  async preregister(input: ExperimentInput): Promise<ExperimentRow> {
    return this.ledger.createExperiment(input)
  }

  async openRound(input: OpenRoundInput): Promise<RoundRow> {
    // The operator and the proposer are kept apart by route: refused before anything is written.
    if (input.operator && input.proposerRoute !== undefined && input.proposerRoute !== 'unknown' && sameRoute(input.operator, input.proposerRoute)) {
      throw new LifecycleError('OPERATOR_IS_PROPOSER', `the operator session runs on ${input.operator.model}, the route the proposer declares; the same model cannot propose and operate a round`)
    }
    const { def } = this.packOf(input.pack)
    const champion = this.championProposalOf(def, input.champion, input.metric)
    const championId = await this.ledger.propose(champion)
    const eval_config_sha = this.evalConfigOf(champion, championId)
    const policy = roundPolicy(input.nEffFloor, def.manifest.holdout?.mde)

    // The promotion gate: what the host mounted on ctx.gate. Replacing
    // gate-default is a fixed-point change (architecture.md § Ledger), so a
    // mounted policy of any other name@version needs a gate_change consent
    // (subject: that name@version) before anything opens under it.
    const mounted = this.gate.current()
    const promotionGate = mounted ? gateMethodOf(mounted) : ''
    if (!promotionGate) throw new LifecycleError('GATE_NOT_CONSENTED', 'no gate policy is mounted on ctx.gate')
    if (promotionGate !== DEFAULT_GATE && !this.consented(promotionGate)) {
      throw new LifecycleError('GATE_NOT_CONSENTED', `the mounted gate ${promotionGate} is not ${DEFAULT_GATE} and no gate_change consent names it; nothing opens under it`)
    }
    const method = input.gate ?? promotionGate
    const provider = this.mountedGate(method)
    if (method !== promotionGate && !this.consented(method)) {
      throw new LifecycleError('GATE_NOT_CONSENTED', `${method} is not the promotion gate ${promotionGate} and no gate_change consent names it`)
    }
    const gate = gateRefOf(provider, policy)
    const shadow_gates = (input.shadowGates ?? []).filter((s) => s !== method).map((s) => gateRefOf(this.mountedGate(s), policy))

    const experiment = input.experimentId !== undefined ? this.experimentOf(input.experimentId) : undefined
    if (experiment && refMethod(experiment.gate) !== refMethod(gate)) {
      throw new LifecycleError('GATE_MISMATCH', `experiment ${experiment.id} pre-registered gate ${refMethod(experiment.gate)}, the round would open under ${refMethod(gate)}`)
    }
    if (experiment && experiment.gate.policy_sha !== gate.policy_sha) {
      throw new LifecycleError('GATE_MISMATCH', `experiment ${experiment.id} pre-registered policy ${experiment.gate.policy_sha.slice(0, 12)}, the round would open under ${gate.policy_sha.slice(0, 12)}`)
    }

    const opened_at = input.openedAt ?? new Date().toISOString()
    const coords = { eval_config_sha, champion_id: championId, gate, opened_at, ...(experiment ? { experiment_id: experiment.id } : {}) }
    const id = roundIdOf(coords)
    let round = this.ledger.round(id)
    if (!round) {
      if (experiment && experiment.budget.rounds !== undefined && experiment.spent.rounds >= experiment.budget.rounds) {
        throw new LifecycleError('BUDGET_EXCEEDED', `experiment ${experiment.id} spent its ${experiment.budget.rounds} round(s)`)
      }
      const floor = this.ledger.noiseFloorFor(eval_config_sha, championId, champion.route.loop, input.metric)
      round = await this.ledger.openRound({
        ...coords,
        shadow_gates,
        profile_sha: stateSha(this.champion.current()),
        ...(floor ? { noise_floor_id: floor.id } : {}),
        ...(input.bestSoFar !== undefined ? { best_so_far: input.bestSoFar } : {}),
        ...(input.operator ? { operator: input.operator } : {}),
      })
      if (experiment) {
        await this.ledger.updateExperiment(experiment.id, {
          round_ids: [...experiment.round_ids, round.id],
          spent: { ...experiment.spent, rounds: experiment.spent.rounds + 1 },
        })
      }
      this.emit({ kind: 'round/opened', roundId: round.id, championId, ...(experiment ? { experimentId: experiment.id } : {}) })
    }
    this.rounds.set(round.id, { pack: def.dir, policy, metric: input.metric, nEffFloor: input.nEffFloor })
    return round
  }

  /** Close a round without a promotion: its scopes are disposed; an already decided round is returned as is. */
  async closeRound(id: string): Promise<RoundRow> {
    const round = this.roundById(id)
    if (round.status === 'decided') return round
    for (const sibling of round.sibling_ids) await this.disposeScope(sibling)
    const closed = await this.ledger.updateRound(id, { status: 'decided', closed_at: new Date().toISOString(), outcome: round.outcome ?? { superseded: [] } })
    this.emit({ kind: 'round/closed', roundId: id })
    return closed
  }

  /**
   * Close a round nothing drives any more: every `running` sibling is judged
   * `invalid` under `aborted:restart` (its attempts never reached a
   * statistic), the scopes are disposed, and the round closes with an
   * `aborted` outcome — never a clean no-promotion decision. Refused on a
   * decided round and on one with no running sibling (`closeRound` is for that).
   */
  async abortRound(id: string): Promise<{ roundId: string; aborted: string[] }> {
    const round = this.roundById(id)
    if (round.status === 'decided') throw new LifecycleError('ROUND_CLOSED', `round ${id} is decided`)
    const aborted = round.sibling_ids.filter((s) => this.rowOf(s).status === 'running')
    if (aborted.length === 0) throw new LifecycleError('BAD_TRANSITION', `round ${id} has no running sibling; nothing to abort (closeRound closes it)`)
    for (const s of aborted) {
      await this.setStatus(s, 'judged', { verdict: { value: 'invalid', by: BY_LIFECYCLE, rule: ABORT_RULE, round_id: round.id } }, round.id)
    }
    for (const s of round.sibling_ids) await this.disposeScope(s)
    await this.ledger.updateRound(round.id, { status: 'decided', closed_at: new Date().toISOString(), outcome: { superseded: [], aborted: true } })
    this.emit({ kind: 'round/closed', roundId: round.id })
    return { roundId: round.id, aborted }
  }

  /** Set an active experiment's budget: refused below what it already spent; the change lands on the row with who set it and when. */
  async setExperimentBudget(id: string, budget: ExperimentRow['budget'], by: Omit<BudgetChange, 'at' | 'budget'> = {}): Promise<ExperimentRow> {
    const experiment = this.experimentOf(id)
    for (const key of ['usd', 'attempts', 'rounds', 'holdout_reveals'] as const) {
      const cap = budget[key]
      if (cap !== undefined && experiment.spent[key] > cap) {
        throw new LifecycleError('BUDGET_EXCEEDED', `experiment ${id} already spent ${experiment.spent[key]} ${key}, more than the budget ${cap}`)
      }
    }
    const change: BudgetChange = { at: new Date().toISOString(), ...by, budget }
    return this.ledger.updateExperiment(id, { budget, budget_changes: [...(experiment.budget_changes ?? []), change] })
  }

  // ------------------------------------------------------- transitions

  /** 1. propose: the row lands on the ledger and joins the round; its coordinates differ from its parent's only where rule 0 allows. */
  async propose(proposal: ChallengerProposal, opts: { roundId: string }): Promise<{ id: string; created: boolean }> {
    const round = this.roundById(opts.roundId)
    if (round.status !== 'open') throw new LifecycleError('ROUND_CLOSED', `round ${round.id} is ${round.status}`)
    const champion = this.rowOf(round.champion_id)
    if (proposal.parent_ids[0] !== round.champion_id) {
      throw new LifecycleError('NOT_IN_ROUND', `the proposal's parent ${proposal.parent_ids[0] ?? '(none)'} is not the round's champion ${round.champion_id}`)
    }
    const full: ChallengerProposal = { ...proposal, pack: proposal.pack ?? champion.pack }
    const id = challengerIdOf(full)
    const asRow = { ...full, id, status: 'proposed', proposed_at: '', eval_config_sha: evalConfigSha(full) } as ChallengerRow
    const rule0 = comparable(asRow, champion)
    if (!rule0.ok) {
      throw new LifecycleError('NOT_COMPARABLE', `NOT_COMPARABLE:${rule0.coordinate}: challenger ${id} differs from its parent ${champion.id} on ${rule0.coordinate}`, { coordinate: rule0.coordinate })
    }
    const created = this.ledger.challenger(id) === undefined
    if (!round.sibling_ids.includes(id)) {
      // Holm's k is the sibling count at the first judgement (S4): once a statistic was computed under this round, no sibling joins.
      if (round.sibling_ids.some((s) => this.ledger.comparesOf(s).some((c) => c.round_id === round.id))) {
        throw new LifecycleError('ROUND_CLOSED', `round ${round.id} already judged a sibling at Holm's k = ${round.k}; a new sibling needs a new round`)
      }
      // A row belongs to one open round at a time: two rounds would each decide over it.
      const elsewhere = this.ledger.roundsOf(round.champion_id).find((r) => r.id !== round.id && r.status !== 'decided' && r.sibling_ids.includes(id))
      if (elsewhere) throw new LifecycleError('BAD_TRANSITION', `challenger ${id} is a sibling of open round ${elsewhere.id}; decide or close it first`)
    }
    await this.ledger.propose(full)
    if (!round.sibling_ids.includes(id)) await this.ledger.updateRound(round.id, { sibling_ids: [...round.sibling_ids, id] })
    if (created) this.emit({ kind: 'challenger/transition', challengerId: id, roundId: round.id, status: 'proposed' })
    return { id, created }
  }

  /** 2. open: the diff scan runs before anything is created; a rejection is a decided row. The profile is untouched (E1). */
  async open(id: string): Promise<Scope> {
    const row = this.rowOf(id)
    const existing = this.open_.get(id)
    if (existing) return existing
    if (row.status === 'decided') throw new LifecycleError('BAD_TRANSITION', `challenger ${id} is decided`)
    // v1: a scope carries no runtime — attempts start from the host context, so config rows put on the scope group
    // would be judged as if applied while nothing consults them (E4). Only the skill surface is evaluated for real.
    if (row.surface !== 'skill') throw new LifecycleError('BAD_TRANSITION', `challenger ${id} is on surface ${row.surface}; v1 scopes carry no runtime, so only the skill surface can be opened (architecture.md E4)`)
    const round = this.roundOf(row)
    const { def } = this.packOf(this.contextOf(round).pack)
    const sets = ['smoke', 'holdin', 'holdout'] as const
    const taskIds = sets.flatMap((set) => def.taskSets[set].tasks.map((t) => t.task_id))
    // S5: the entity keys and the task set file names are literals the patch must not name either.
    const literals = [...new Set([...sets.flatMap((set) => def.taskSets[set].tasks.map((t) => t.entity_key)), ...sets.map((set) => basename(def.taskSets[set].path))])]
    const before = stateSha(this.champion.current())
    let scope: Scope
    try {
      scope = await this.scopes.open({
        id, patch: patchOf(row, def), boundaries: surfaceBoundaries(def), taskIds, literals,
        forbiddenPaths: protectedPaths(def),
        isolate: Object.fromEntries(ISOLATED_SERVICES.map((s) => [s, true as const])),
      })
    } catch (e) {
      if (e instanceof ScopeError && e.code === 'PATCH_REJECTED') {
        await this.setStatus(id, 'decided', {
          verdict: { value: 'invalid', by: 'diffscan', rule: e.violations.map((v) => `${v.code}:${v.where}`).join(','), round_id: round.id },
        }, round.id)
      }
      throw e
    }
    const after = stateSha(this.champion.current())
    if (before !== after) {
      await scope.dispose()
      throw new LifecycleError('PROFILE_CHANGED', `the profile changed while scope ${scope.scopeId} opened (E1): ${before.slice(0, 12)} -> ${after.slice(0, 12)}`)
    }
    await this.setStatus(id, row.status === 'proposed' ? 'opened' : row.status, {
      opened: { harness_sha: scope.harnessSha, env_sha: scope.envSha, profile_sha: after, at: new Date().toISOString() },
    }, round.id)
    this.open_.set(id, scope)
    return scope
  }

  /** 3. run: the champion's attempts are ensured (reused or run), then the challenger's; no two harnesses are ever pooled. */
  async run(id: string, tier: Tier, opts: RunOptions): Promise<RunSummary> {
    const row = this.rowOf(id)
    if (row.status === 'proposed' || row.status === 'decided') throw new LifecycleError('BAD_TRANSITION', `challenger ${id} is ${row.status}; run needs an opened row`)
    if (tier === 'live') throw new LifecycleError('BAD_TRANSITION', 'the executor runs task sets; live is settled by the book')
    const round = this.openRoundOf(row)
    const { def, book } = this.packOf(this.contextOf(round).pack)
    const executor = this.executor
    const championId = round.champion_id
    const tasks = selectTasks(book, tier, opts)
    const entityOf = new Map(tasks.map((t) => [t.task_id, t.entity_key]))
    const runId = opts.runId ?? newRunId()
    const experiment = round.experiment_id !== undefined ? this.experimentOf(round.experiment_id) : undefined
    if (experiment) this.assertSpend(experiment, tier)
    // One reveal per challenger: a rerun on the held-out set (more replicates, a resumed run) shows nothing new.
    const reveal = tier === 'holdout' && !this.ledger.attemptsOf(id).some((a) => a.tier === 'holdout') ? id : undefined
    if (reveal !== undefined) this.debitHoldout(def, book, `run:${id}`)

    const request = {
      pack: def.dir, loop: row.route.loop, set: tier, repeat: opts.repeat, maxTurns: opts.maxTurns, maxMinutes: opts.maxMinutes,
      ...(opts.allow !== undefined ? { allow: opts.allow } : {}),
      ...(opts.parallel !== undefined ? { parallel: opts.parallel } : {}),
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
      ...(opts.stratum !== undefined ? { stratum: opts.stratum } : {}),
      ...(opts.env !== undefined ? { env: opts.env } : {}),
    }
    const deps: RunDeps = {
      loops: this.ctx.loops, route: opts.route, ledger: this.ledger,
      ...(opts.championSkillDir !== undefined ? { championSkillDir: opts.championSkillDir } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      ...(opts.log !== undefined ? { log: opts.log } : {}),
      ...this.environmentDeps(),
    }

    let champion: RunResult | undefined
    // Reuse needs the champion on every (task, sample) this run pairs on; a floor's reruns cover sample 0 only.
    const have = new Set(latestAttempts(this.ledger.attemptsOf(championId), entityOf).map((a) => `${a.task_id}\0${a.sample}`))
    const samples = Array.from({ length: opts.repeat }, (_, r) => r)
    const haveChampion = tasks.every((t) => samples.every((r) => have.has(`${t.task_id}\0${r}`)))
    // The run id names the row so two siblings started in the same second never share an attempt id.
    const runs = { champion: `${runId}-champion-${championId.slice(0, 12)}`, challenger: `${runId}-challenger-${id.slice(0, 12)}` }
    const scope = this.open_.get(id)
    const skillDir = scope?.skillDir ?? (row.surface === 'skill' ? row.patch.skill_ref : undefined)
    const runChampion = opts.withChampion || !haveChampion
    // The executor reports lines, not counts: progress is one event per finished run.
    const total = tasks.length * opts.repeat
    let challenger: RunResult
    try {
      if (runChampion) {
        champion = await executor.runSet({ ...request, out: resolve(opts.out, 'champion') }, { ...deps, challengerId: championId, runId: runs.champion })
        this.emit({ kind: 'attempt/progress', challengerId: championId, roundId: round.id, tier, done: champion.rows.length, total })
      }
      await this.setStatus(id, 'running', { tier_reached: tier }, round.id)
      challenger = await executor.runSet(
        { ...request, out: resolve(opts.out, 'challenger'), ...(skillDir !== undefined ? { skillDir } : {}) },
        { ...deps, challengerId: id, runId: runs.challenger, ...this.trackOn(scope) },
      )
      this.emit({ kind: 'attempt/progress', challengerId: id, roundId: round.id, tier, done: challenger.rows.length, total })
    } finally {
      // What the executor recorded under this run is spent whether or not the run came back.
      if (experiment) await this.recordSpend(experiment.id, tier, [...(runChampion ? [[championId, runs.champion] as const] : []), [id, runs.challenger] as const], reveal)
    }

    // The run invariant: every attempt's facts_sha equals the champion's on the same (task, sample) for the same loop, else no statistic is computed.
    const championFacts = factsOf(this.ledger.attemptsOf(championId), row.route.loop, entityOf)
    const challengerFacts = factsOf(this.ledger.attemptsOf(id), row.route.loop, entityOf)
    const summary: RunSummary = { challengerId: id, championId, tier, challenger, ...(champion ? { champion } : {}) }
    if (!factsAgree(championFacts, challengerFacts)) {
      await this.setStatus(id, 'judged', { tier_reached: tier, verdict: { value: 'invalid', by: BY_LIFECYCLE, rule: 'coordinates:facts', round_id: round.id } }, round.id)
      await this.disposeScope(id)
      summary.invalid = 'coordinates:facts'
    }
    return summary
  }

  /** 4. judge: paired on the same tasks, the primary metric only, under the round's gate and noise floor; shadows beside it. */
  async judge(id: string, tier: Tier): Promise<CompareRow> {
    const row = this.rowOf(id)
    if (row.status !== 'running' && row.status !== 'judged') throw new LifecycleError('BAD_TRANSITION', `challenger ${id} is ${row.status}; judge needs a run`)
    if (row.tier_reached !== tier) throw new LifecycleError('BAD_TRANSITION', `challenger ${id} reached ${row.tier_reached ?? 'no tier'}, not ${tier}`)
    // A row the run invariant or the diff scan already found invalid has nothing to compute a statistic over until it runs again.
    if (row.status === 'judged' && row.verdict?.value === 'invalid' && (row.verdict.by === BY_LIFECYCLE || row.verdict.by === 'diffscan')) {
      throw new LifecycleError('BAD_TRANSITION', `challenger ${id} is invalid on ${row.verdict.rule} (by ${row.verdict.by}); judge needs a new run`)
    }
    const round = this.openRoundOf(row)
    const rc = this.contextOf(round)
    const { def, book } = this.packOf(rc.pack)
    const champion = this.rowOf(round.champion_id)
    const invalid = async (rule: string) => {
      await this.setStatus(id, 'judged', { tier_reached: tier, verdict: { value: 'invalid', by: BY_LIFECYCLE, rule, round_id: round.id } }, round.id)
      await this.disposeScope(id)
    }

    // Rule 0 on the coordinates: no statistic is computed across a difference.
    const rule0 = comparable(row, champion)
    if (!rule0.ok) {
      await invalid(`coordinates:${rule0.coordinate}`)
      throw new LifecycleError('NOT_COMPARABLE', `NOT_COMPARABLE:${rule0.coordinate}: challenger ${id} differs from champion ${champion.id} on ${rule0.coordinate}`, { coordinate: rule0.coordinate })
    }
    // The noise floor the round pinned; a holdout judgement without one is invalid (S1).
    const floor = round.noise_floor_id !== undefined ? this.ledger.read('noise_floors', 'gate').find((f) => f.id === round.noise_floor_id) : undefined
    if (tier === 'holdout' && !floor) {
      await invalid('noise_floor')
      throw new LifecycleError('NO_NOISE_FLOOR', `round ${round.id} has no noise floor; calibrate the champion before judging holdout`)
    }
    if (policySha(rc.policy) !== round.gate.policy_sha) {
      throw new LifecycleError('GATE_MISMATCH', `the policy in this process differs from the one round ${round.id} pinned (${round.gate.policy_sha.slice(0, 12)})`)
    }
    const provider = this.mountedGate(refMethod(round.gate))

    const metric = rc.metric
    const scores = (attemptId: string) => this.ledger.scoresOf(attemptId)
    const tasks = tier === 'live' ? [] : book.tasks(tier)
    const entityOf = new Map(tasks.map((t) => [t.task_id, t.entity_key]))
    // The run invariant again on the rows as they are now: no statistic across two harnesses, whatever run left them.
    const championFacts = factsOf(this.ledger.attemptsOf(champion.id), row.route.loop, entityOf)
    const challengerFacts = factsOf(this.ledger.attemptsOf(id), row.route.loop, entityOf)
    const oneChallengerFacts = oneFacts(challengerFacts)
    const oneChampionFacts = oneFacts(championFacts)
    if (!factsAgree(championFacts, challengerFacts)) {
      await invalid('coordinates:facts')
      throw new LifecycleError('NOT_COMPARABLE', `NOT_COMPARABLE:facts: the attempts of challenger ${id} and champion ${champion.id} ran under different harnesses`, { coordinate: 'facts' })
    }
    // S6: a pair is one truth — a champion score settled on one snapshot never pairs with a challenger score on another.
    const championTruth = truthOf(this.ledger.attemptsOf(champion.id), scores, entityOf, metric)
    const challengerTruth = truthOf(this.ledger.attemptsOf(id), scores, entityOf, metric)
    if ([...challengerTruth].some(([pair, truth]) => championTruth.has(pair) && championTruth.get(pair) !== truth)) {
      await invalid('truth_snapshot')
      throw new LifecycleError('NOT_COMPARABLE', `NOT_COMPARABLE:truth_snapshot: the scores of challenger ${id} and champion ${champion.id} were settled on different truth snapshots`, { coordinate: 'truth_snapshot' })
    }
    const compareReq: CompareRequest = {
      challenger: scoredAttemptsOf(this.ledger.attemptsOf(id), scores, entityOf, metric),
      champion: scoredAttemptsOf(this.ledger.attemptsOf(champion.id), scores, entityOf, metric),
      tier,
      primaryMetric: metric,
      // The gate's own rule 0 stays live on the same facts, when one sha stands behind every pair.
      ...(oneChallengerFacts !== undefined && oneChampionFacts !== undefined ? { factsSha: { challenger: oneChallengerFacts, champion: oneChampionFacts } } : {}),
      // Without a rerun study the noise floor is unknown: the MDE from it is 0 and only nEffFloor / the pack mde bind.
      noiseFloor: floor ? { sdPaired: floor.sd_paired, nReruns: floor.n_reruns } : { sdPaired: 0, nReruns: 0 },
      policy: rc.policy,
      // Holm over the round's k siblings at the most conservative rank: the same adjusted level for every sibling.
      round: { k: Math.max(1, round.k), index: 0 },
      ...(round.best_so_far !== undefined ? { bestSoFar: round.best_so_far } : {}),
      seed: 0,
    }
    const coords = { vs_id: champion.id, tier, truth_snapshot_id: row.truth_snapshot_id, ...(round.best_so_far !== undefined ? { best_so_far: round.best_so_far } : {}) }
    const extras = (c: GateVerdictRow['compare']): Partial<CompareRow> => {
      const predicted = predictedVsObserved(row.prediction, c.perTask)
      return {
        round_id: round.id,
        replicates: Math.round(c.replicates),
        min_effect: c.minEffect,
        sd_source: floor ? 'noise_floor' : 'comparison',
        holm: { m: Math.max(1, round.k), rank: 0, alpha_adj: c.holm.adjustedAlpha },
        ...(tier === 'holdout' && def.manifest.holdout?.budget !== undefined ? { holdout_budget_remaining: book.holdoutBudget().remaining } : {}),
        // S5: recorded beside the verdict for the reader; gate-default does not read it.
        ...(predicted ? { predicted_vs_observed: predicted } : {}),
      }
    }

    const judgement: GateVerdictRow = { ...(await provider.judge(compareReq)), gateMethod: gateMethodOf(provider) }
    const compare: CompareRow = { ...compareRowOf(id, judgement, coords, false, false), ...extras(judgement.compare) }
    // S4: one pre-registered held-out test per (challenger, champion, round). Only an underpowered verdict escalates
    // (more replicates, a new row); the same judgement again is idempotent; anything else is a second test and is refused.
    if (tier === 'holdout') {
      const priors = this.ledger.comparesOf(id).filter((c) => !c.shadow && c.tier === 'holdout' && c.vs_id === champion.id && c.round_id === round.id)
      const key = compareKey(compare)
      const decided = priors.find((c) => !c.rule_fired.startsWith('power:'))
      if (decided && !priors.some((c) => compareKey(c) === key)) {
        throw new LifecycleError('BAD_TRANSITION', `challenger ${id} already had its held-out test in round ${round.id} (${decided.verdict.value} on ${decided.rule_fired}); one pre-registered holdout test (S4), only an underpowered verdict escalates`)
      }
    }

    // Shadows: recorded beside the promotion verdict, never a decision; an unmounted shadow is skipped.
    for (const ref of round.shadow_gates) {
      const shadow = this.gate.list().find((p) => gateMethodOf(p) === refMethod(ref))
      if (!shadow) continue
      const j: GateVerdictRow = { ...(await shadow.judge(compareReq)), gateMethod: gateMethodOf(shadow) }
      await this.record({ ...compareRowOf(id, j, coords, false, true), ...extras(j.compare) })
    }

    // First verdict wins for these coordinates and replicates: the judgement over more of them (the escalation an
    // underpowered verdict asked for) is its own row on the ledger and the row's verdict.
    const recorded = await this.record(compare)
    await this.setStatus(id, 'judged', {
      tier_reached: tier,
      ...(recorded ? { verdict: { value: verdictValueOf(judgement), by: judgement.gateMethod, rule: judgement.compare.ruleFired, round_id: round.id } } : {}),
    }, round.id)
    // Ladder (S7): best-so-far is round state, moved only by a holdout mean that beat it.
    if (recorded && tier === 'holdout' && judgement.compare.ladder.beatBest && Number.isFinite(judgement.compare.mean)) {
      await this.ledger.updateRound(round.id, { best_so_far: judgement.compare.mean })
    }
    if (recorded && (judgement.verdict === 'invalid' || judgement.verdict === 'drop')) await this.disposeScope(id)
    return compare
  }

  /**
   * 5. decide: among the round's promote verdicts at most one is promoted —
   * the largest lower CI bound, ties to the earliest proposed — and only with
   * a promote consent on the ledger bound to this round; without one nothing changes and the
   * candidate is returned. The other promotes of this round become
   * hold:superseded. The champion must still be the one the round opened on.
   */
  async decide(roundId: string): Promise<RoundOutcome> {
    const round = this.roundById(roundId)
    if (round.status === 'decided') throw new LifecycleError('ROUND_CLOSED', `round ${roundId} is decided`)
    const served = stateSha(this.champion.current())
    if (round.profile_sha !== undefined && round.profile_sha !== served) {
      throw new LifecycleError('PROFILE_CHANGED', `round ${roundId} opened against champion state ${round.profile_sha.slice(0, 12)}, the one served is ${served.slice(0, 12)}; nothing in it was judged against it (close the round)`)
    }
    const siblings = round.sibling_ids.map((id) => this.rowOf(id))
    const candidate = this.candidateOf(round, siblings)
    let promoted: string | undefined
    let consentId: string | undefined
    if (candidate) {
      // E2: the consent is bound to this round — a promote signed for an earlier round's verdict does not carry over.
      const consent = latestBy(this.ledger.consentsOf(candidate).filter((c) => c.action === 'promote' && c.round_id === round.id), (c) => c.at)
      if (!consent) return { pending: 'consent', roundId, candidate }
      await this.champion.promote(candidate, consent.id)
      await this.setStatus(candidate, 'decided', { verdict: { ...this.rowOf(candidate).verdict!, consent_id: consent.id } }, round.id)
      await this.sync()
      promoted = candidate
      consentId = consent.id
    }
    const superseded: string[] = []
    for (const s of siblings) {
      // Only this round's verdicts move: a verdict from another round (a kept champion's, an earlier round's) is not this decision's.
      if (!s.verdict || s.verdict.round_id !== round.id || s.id === promoted || s.status === 'decided') continue
      if (s.verdict.value === 'promote' && promoted !== undefined) {
        superseded.push(s.id)
        await this.setStatus(s.id, 'judged', { verdict: { ...s.verdict, value: 'hold:superseded', round_id: round.id } }, round.id)
      } else if (s.verdict.value === 'drop' || s.verdict.value === 'invalid') {
        await this.setStatus(s.id, 'decided', {}, round.id)
      }
    }
    for (const s of siblings) await this.disposeScope(s.id)
    const outcome = { ...(promoted !== undefined ? { promoted } : {}), superseded, ...(consentId !== undefined ? { consent_id: consentId } : {}) }
    await this.ledger.updateRound(round.id, { status: 'decided', closed_at: new Date().toISOString(), outcome })
    const decided = { roundId, ...(promoted !== undefined ? { promoted } : {}), superseded, ...(consentId !== undefined ? { consentId } : {}) }
    this.emit({ kind: 'round/decided', ...decided })
    return decided
  }

  /** Demote a kept champion: a `demote` consent is required unless the pack declares automatic demotion (`holdout.auto_demote`). */
  async demote(championId: string, reason: string, consentId?: string): Promise<void> {
    const row = this.rowOf(championId)
    const auto = this.packOfRow(row)?.def.manifest.holdout as { auto_demote?: boolean } | undefined
    if (!auto?.auto_demote) {
      const consent = consentId !== undefined ? this.ledger.consentsOf(championId).find((c) => c.id === consentId && c.action === 'demote') : undefined
      if (!consent) throw new LifecycleError('NO_CONSENT', `no demote consent ${consentId ?? '(none)'} for ${championId}, and its pack declares no automatic demotion`)
      await this.reverse(championId, reason, { by: 'demote', consent_id: consent.id })
      return
    }
    await this.reverse(championId, reason, { by: 'demote' })
  }

  /** A re-score result: the compare row is appended; a kept row that no longer holds `promote` is reversed and dropped, an unkept row takes the gate's value. */
  async rescore(id: string, judgement: GateVerdictRow, coords: CompareCoords): Promise<CompareRow> {
    this.rowOf(id)
    const kept = this.champion.current().kept.some((k) => k.challenger_id === id)
    const compare = compareRowOf(id, judgement, coords, kept)
    await this.ledger.recordCompare(compare)
    if (compare.verdict.value === 'reversed') {
      await this.reverse(id, `reversed on ${coords.truth_snapshot_id}: ${compare.rule_fired}`, { by: 'reversed' })
    } else if (!kept) {
      await this.setStatus(id, 'judged', { verdict: compare.verdict })
    }
    return compare
  }

  /** 6. settle: the champion plans the re-scores over its ancestry; a re-score that reveals held-out attempts of a kept row debits the holdout budget. */
  async settle(event: SettledEvent): Promise<RescoreEvent[]> {
    const plan = await this.champion.onSettlement(event)
    const kept = new Set(this.champion.current().kept.map((k) => k.challenger_id))
    for (const p of plan) {
      if (!kept.has(p.challenger_id)) continue
      const ids = new Set(p.attempt_ids)
      if (!this.ledger.attemptsOf(p.challenger_id).some((a) => ids.has(a.id) && a.tier === 'holdout')) continue
      const pack = this.packOfRow(this.rowOf(p.challenger_id))
      if (pack) this.debitHoldout(pack.def, pack.book, `settle:${event.id}`)
      break
    }
    return plan
  }

  // ------------------------------------------------------ measurements

  /** Rerun the champion on the tier's tasks with the null diff and record the paired spread per entity across reruns (S1). */
  async calibrate(input: CalibrateInput): Promise<NoiseFloorRow> {
    if (!(input.reruns >= 3)) throw new LifecycleError('BAD_TRANSITION', `a noise floor needs at least 3 reruns (S1), got ${input.reruns}`)
    const { def, book } = this.packOf(input.pack)
    const champion = this.championProposalOf(def, input.champion, input.metric)
    const championId = await this.ledger.propose(champion)
    const eval_config_sha = this.evalConfigOf(champion, championId)
    const opts = input.run
    const runId = opts.runId ?? newRunId()
    // A rerun is the set again at the same sample index, not another sample:
    // a comparison pairs attempts by (task, sample), so the floor is what two
    // attempts of one champion differ by on the same replicate — a pack whose
    // draw is paired on the sample index would otherwise be measured across coins.
    const reruns: Set<string>[] = []
    for (let r = 0; r < input.reruns; r++) {
      const result = await this.executor.runSet(
        {
          pack: def.dir, loop: champion.route.loop, set: input.set, repeat: 1, out: resolve(opts.out, `calibrate-${r}`),
          maxTurns: opts.maxTurns, maxMinutes: opts.maxMinutes,
          ...(opts.allow !== undefined ? { allow: opts.allow } : {}),
          ...(opts.parallel !== undefined ? { parallel: opts.parallel } : {}),
          ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
          ...(opts.stratum !== undefined ? { stratum: opts.stratum } : {}),
          ...(opts.env !== undefined ? { env: opts.env } : {}),
        },
        {
          loops: this.ctx.loops, route: opts.route, ledger: this.ledger, challengerId: championId, runId: `${runId}-calibrate-${r}`,
          ...(opts.championSkillDir !== undefined ? { championSkillDir: opts.championSkillDir } : {}),
          ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
          ...(opts.log !== undefined ? { log: opts.log } : {}),
          ...this.environmentDeps(),
        },
      )
      reruns.push(new Set(result.rows.map((row) => row.attemptId)))
    }
    const entityOf = new Map(book.tasks(input.set).map((t) => [t.task_id, t.entity_key]))
    // Per entity, the mean over its tasks for each rerun; the paired difference between every two reruns is one sample of the floor.
    const byEntity = new Map<string, Map<number, number[]>>()
    const tasksSeen = new Set<string>()
    for (const a of this.ledger.attemptsOf(championId)) {
      const rerun = reruns.findIndex((ids) => ids.has(a.id))
      if (rerun < 0) continue
      const score = this.ledger.scoresOf(a.id).find((s) => s.metric === input.metric)
      if (!score) continue
      tasksSeen.add(a.task_id)
      const entity = entityOf.get(a.task_id) ?? a.task_id
      const samples = byEntity.get(entity) ?? new Map<number, number[]>()
      samples.set(rerun, [...(samples.get(rerun) ?? []), score.value])
      byEntity.set(entity, samples)
    }
    const diffs: number[] = []
    for (const samples of byEntity.values()) {
      const means = [...samples.entries()].sort((a, b) => a[0] - b[0]).map(([, xs]) => xs.reduce((s, x) => s + x, 0) / xs.length)
      for (let i = 0; i < means.length; i++) for (let j = i + 1; j < means.length; j++) diffs.push(means[j]! - means[i]!)
    }
    const floor = {
      eval_config_sha, champion_id: championId, loop: champion.route.loop, metric: input.metric, measured_at: new Date().toISOString(),
      unit: 'entity' as const, sd_paired: sd(diffs), n_reruns: input.reruns, n_tasks: tasksSeen.size, tier: input.set,
    }
    const id = await this.ledger.recordNoiseFloor(floor)
    this.emit({ kind: 'noise_floor/recorded', id })
    return { id, ...floor }
  }

  // ----------------------------------------------------------- campaign

  /** Rounds under one experiment until a stop rule, a missing consent or the signal ends them; the same experiment id resumes from its last open round. */
  campaign(input: CampaignInput, hooks: CampaignHooks): Promise<CampaignResult> {
    return runCampaign({ lifecycle: this, ledger: this.ledger, emit: (e) => { this.emitter.emit('lifecycle/event', e) } }, input, hooks)
  }

  /** One control round judged at holdout: the champion's own skill (aa) or a given directory (inject). */
  control(input: ControlInput, hooks: ControlHooks): Promise<ControlResult> {
    return runControl({ lifecycle: this, ledger: this.ledger }, input, hooks)
  }

  // ---------------------------------------------------------- read-only

  status(): LifecycleStatus {
    const rounds = this.ledger.read('rounds', 'human').filter((r) => r.status !== 'decided').sort((a, b) => (a.opened_at < b.opened_at ? -1 : 1))
    const pending: PendingConsent[] = []
    for (const round of rounds) {
      const candidate = this.candidateOf(round, round.sibling_ids.map((id) => this.ledger.challenger(id)).filter((r): r is ChallengerRow => r !== undefined))
      if (candidate && !this.ledger.consentsOf(candidate).some((c) => c.action === 'promote' && c.round_id === round.id)) pending.push({ roundId: round.id, candidate, action: 'promote' })
    }
    const latest = new Map<string, NoiseFloorRow>()
    for (const f of this.ledger.read('noise_floors', 'human')) {
      const key = [f.eval_config_sha, f.champion_id, f.loop, f.metric].join('\0')
      const cur = latest.get(key)
      if (!cur || f.measured_at > cur.measured_at) latest.set(key, f)
    }
    return { champion: this.champion.current(), rounds, pending, noiseFloors: [...latest.values()], experiments: this.ledger.experiments() }
  }

  /** For a judged row: add replicates, go to holdout, drop — with the numbers the verdict rule used and a cost estimate. */
  nextActions(id: string): NextAction[] {
    const row = this.rowOf(id)
    const pack = this.packOfRow(row)
    const taskCounts = pack
      ? { smoke: pack.def.taskSets.smoke.tasks.length, holdin: pack.def.taskSets.holdin.tasks.length, holdout: pack.def.taskSets.holdout.tasks.length }
      : { smoke: 0, holdin: 0, holdout: 0 }
    const tier = row.tier_reached
    const compare = tier !== undefined
      ? latestBy(this.ledger.comparesOf(id).filter((c) => !c.shadow && c.tier === tier && (row.verdict?.round_id === undefined || c.round_id === row.verdict.round_id)), (c) => c.at)
      : undefined
    const champion = row.parent_ids[0]
    const floor = champion !== undefined && row.eval_config_sha !== undefined ? this.ledger.noiseFloorFor(row.eval_config_sha, champion, row.route.loop, row.prediction.metric) : undefined
    const costs = champion !== undefined && tier !== undefined
      ? this.ledger.attemptsOf(champion).filter((a) => a.tier === tier && a.cost.usd !== undefined).map((a) => a.cost.usd!)
      : []
    const budget = pack && pack.def.manifest.holdout?.budget !== undefined ? pack.book.holdoutBudget() : undefined
    return nextActionsOf({
      row, taskCounts,
      ...(compare ? { compare } : {}),
      ...(floor ? { sd: floor.sd_paired } : {}),
      ...(costs.length ? { meanUsd: costs.reduce((s, x) => s + x, 0) / costs.length } : {}),
      ...(budget ? { budget } : {}),
    })
  }

  // ------------------------------------------------------------ helpers

  private rowOf(id: string): ChallengerRow {
    const row = this.ledger.challenger(id)
    if (!row) throw new LifecycleError('UNKNOWN', `no challenger ${id}`)
    return row
  }

  private roundById(id: string): RoundRow {
    const round = this.ledger.round(id)
    if (!round) throw new LifecycleError('UNKNOWN', `no round ${id}`)
    return round
  }

  private experimentOf(id: string): ExperimentRow {
    const experiment = this.ledger.experiment(id)
    if (!experiment) throw new LifecycleError('UNKNOWN', `no experiment ${id}`)
    if (experiment.status !== 'active') throw new LifecycleError('ROUND_CLOSED', `experiment ${id} is ${experiment.status}`)
    return experiment
  }

  /** The round a row belongs to: the open round against its parent that lists it as a sibling (there is at most one), else the latest. */
  private roundOf(row: ChallengerRow): RoundRow {
    const parent = row.parent_ids[0]
    const rounds = parent !== undefined ? this.ledger.roundsOf(parent).filter((r) => r.sibling_ids.includes(row.id)) : []
    const round = rounds.find((r) => r.status !== 'decided') ?? rounds.at(-1)
    if (!round) throw new LifecycleError('NOT_IN_ROUND', `challenger ${row.id} is in no round`)
    return round
  }

  private openRoundOf(row: ChallengerRow): RoundRow {
    const round = this.roundOf(row)
    if (round.status !== 'open') throw new LifecycleError('ROUND_CLOSED', `round ${round.id} is ${round.status}`)
    return round
  }

  private contextOf(round: RoundRow): RoundContext {
    const rc = this.rounds.get(round.id)
    if (!rc) throw new LifecycleError('BAD_TRANSITION', `round ${round.id} was not opened in this process; call openRound with the same coordinates to reload its pack and policy`)
    return rc
  }

  private packOf(dir: string): PackContext {
    const key = resolve(dir)
    let pack = this.packs.get(key)
    if (!pack) {
      const def = loadPack(key)
      pack = { def, book: bookOf(def) }
      this.replayHoldout(pack)
      this.packs.set(key, pack)
      // S6: a settlement on the book is step 6; the re-scores it plans are the champion's.
      this.ctx.effect(() => pack!.book.on('book/settled', (settlement) => { this.settle(settlement).catch(() => {}) }), `lifecycle.settle(${def.name})`)
    }
    return pack
  }

  private packOfRow(row: ChallengerRow): PackContext | undefined {
    try {
      return this.packOf(this.contextOf(this.roundOf(row)).pack)
    } catch (e) {
      if (e instanceof LifecycleError) return undefined
      throw e
    }
  }

  /** The champion as the round's baseline: the pack it was evaluated under and the round's metric, so its eval_config_sha is the round's. */
  private championProposalOf(def: PackDefinition, champion: ChallengerProposal, metric: string): ChallengerProposal {
    return { ...champion, pack: def.name, prediction: { metric, direction: 'up' } }
  }

  /** The evaluation configuration the champion row on the ledger carries must be the one this round computes from it. */
  private evalConfigOf(champion: ChallengerProposal, championId: string): string {
    const expected = evalConfigSha(champion)
    const recorded = evalConfigShaOf(this.rowOf(championId))
    if (recorded !== expected) {
      throw new LifecycleError('NOT_COMPARABLE', `NOT_COMPARABLE:eval_config_sha: champion ${championId} was recorded under evaluation configuration ${recorded.slice(0, 12)}, this round computes ${expected.slice(0, 12)} (pack or metric differ)`, { coordinate: 'eval_config_sha' })
    }
    return expected
  }

  private consented(method: string): boolean {
    return this.ledger.consentsOf(method).some((c) => c.action === 'gate_change')
  }

  private mountedGate(method: string): GatePolicyProvider {
    const provider = this.gate.list().find((p) => gateMethodOf(p) === method)
    if (!provider) throw new LifecycleError('GATE_MISMATCH', `no gate policy ${method} is mounted on ctx.gate`)
    return provider
  }

  /** Every status write goes through here, so a live view sees each transition as it lands. */
  private async setStatus(id: string, status: ChallengerRow['status'], patch: Partial<Pick<ChallengerRow, 'tier_reached' | 'verdict' | 'opened'>> = {}, roundId?: string): Promise<ChallengerRow> {
    const row = await this.ledger.setStatus(id, status, patch)
    this.emit({
      kind: 'challenger/transition', challengerId: id, status,
      ...(roundId !== undefined ? { roundId } : {}),
      ...(row.tier_reached !== undefined ? { tier: row.tier_reached } : {}),
    })
    return row
  }

  private emit(e: Unstamped<LifecycleEvent>): void {
    this.emitter.emit('lifecycle/event', { ...e, at: new Date().toISOString() } as LifecycleEvent)
  }

  private async record(row: CompareRow): Promise<boolean> {
    try {
      await this.ledger.recordCompare(row)
      return true
    } catch (e) {
      if (e instanceof LedgerError && e.code === 'VERDICT_EXISTS') return false
      throw e
    }
  }

  /** The champion drops the row, its verdict is reversed on the ledger (`rule: demote:<reason>`, the promotion's consent kept), the serving rows follow. */
  private async reverse(id: string, reason: string, why: Pick<ServingRow, 'by' | 'consent_id'>): Promise<void> {
    const row = this.rowOf(id)
    this.demotions.set(id, why)
    try {
      await this.champion.demote(id)
    } catch (e) {
      this.demotions.delete(id)
      throw e
    }
    const verdict: NonNullable<ChallengerRow['verdict']> = { value: 'reversed', by: 'champion', rule: `demote:${reason}` }
    if (row.verdict?.consent_id !== undefined) verdict.consent_id = row.verdict.consent_id
    await this.setStatus(id, 'decided', { verdict })
    await this.sync()
  }

  private async disposeScope(id: string): Promise<void> {
    const scope = this.open_.get(id)
    if (!scope) return
    this.open_.delete(id)
    await scope.dispose()
  }

  /**
   * The promote verdict with the largest lower CI bound on its holdout compare
   * in this round; ties go to the earliest proposed. A candidate is a holdout
   * verdict of this round, backed by a compare row this round's gate recorded
   * here: a verdict from another round, another gate or a lower tier is none.
   */
  private candidateOf(round: RoundRow, siblings: readonly ChallengerRow[]): string | undefined {
    const gate = refMethod(round.gate)
    const ranked = siblings
      .filter((s) => s.status === 'judged' && s.verdict?.value === 'promote' && s.verdict.round_id === round.id && s.tier_reached === 'holdout')
      .flatMap((s) => {
        const compare = latestBy(
          this.ledger.comparesOf(s.id).filter((c) => !c.shadow && c.tier === 'holdout' && c.vs_id === round.champion_id && c.round_id === round.id && c.gate === gate),
          (c) => c.at,
        )
        return compare ? [{ id: s.id, lo: compare.ci[0], proposed_at: s.proposed_at }] : []
      })
      .sort((a, b) => b.lo - a.lo || (a.proposed_at < b.proposed_at ? -1 : a.proposed_at > b.proposed_at ? 1 : 0) || (a.id < b.id ? -1 : 1))
    return ranked[0]?.id
  }

  private assertSpend(experiment: ExperimentRow, tier: Tier): void {
    const { budget, spent } = experiment
    if (budget.attempts !== undefined && spent.attempts >= budget.attempts) throw new LifecycleError('BUDGET_EXCEEDED', `experiment ${experiment.id} spent its ${budget.attempts} attempt(s)`)
    if (budget.usd !== undefined && spent.usd >= budget.usd) throw new LifecycleError('BUDGET_EXCEEDED', `experiment ${experiment.id} spent its ${budget.usd} usd`)
    if (tier === 'holdout' && budget.holdout_reveals !== undefined && spent.holdout_reveals >= budget.holdout_reveals) {
      throw new LifecycleError('BUDGET_EXCEEDED', `experiment ${experiment.id} spent its ${budget.holdout_reveals} holdout reveal(s)`)
    }
  }

  /** The attempts the ledger holds on the tier under this run's ids, per row; `reveal` names the row whose first held-out attempt on the ledger is the experiment's reveal. */
  private async recordSpend(experimentId: string, tier: Tier, runs: readonly (readonly [challengerId: string, runId: string])[], reveal: string | undefined): Promise<void> {
    const rows = runs.flatMap(([challengerId, runId]) => this.ledger.attemptsOf(challengerId).filter((a) => a.tier === tier && a.id.startsWith(`${runId}-`)))
    const experiment = this.experimentOf(experimentId)
    const spent = { ...experiment.spent }
    spent.attempts += rows.length
    spent.usd += rows.reduce((s, a) => s + (a.cost.usd ?? 0), 0)
    if (reveal !== undefined && rows.some((a) => a.tier === 'holdout' && a.challenger_id === reveal)) spent.holdout_reveals += 1
    await this.ledger.updateExperiment(experiment.id, { spent })
  }

  /**
   * The reveals the ledger already holds for this pack, debited so the budget
   * survives a restart: every challenger run on the held-out set, and every
   * settlement that re-scored a promoted row holding held-out attempts (what
   * `settle` debits). The settlement replay is conservative — a row ever
   * promoted (a `promote` serving row) counts, whether or not it was still
   * kept when that settlement landed — so a restart never shows more budget
   * than the process it replaced.
   */
  private replayHoldout({ def, book }: PackContext): void {
    if (def.manifest.holdout?.budget === undefined) return
    const rows = new Map(this.ledger.read('challengers', 'gate').filter((r) => r.pack === def.name && r.parent_ids.length > 0).map((r) => [r.id, r]))
    const revealed = new Set(this.ledger.read('attempts', 'gate').filter((a) => a.tier === 'holdout' && rows.has(a.challenger_id)).map((a) => a.challenger_id))
    const promoted = new Set(this.ledger.servings().filter((s) => s.by === 'promote').map((s) => s.champion_id))
    const settled = this.ledger.read('settlements', 'gate').filter((s) => s.triggered_rescoring.some((id) => promoted.has(id) && revealed.has(id))).map((s) => s.id)
    for (const reason of [...[...revealed].sort().map((id) => `ledger:${id}`), ...settled.sort().map((id) => `ledger:settle:${id}`)]) {
      try {
        book.debitHoldout(reason)
      } catch (e) {
        if (e instanceof HoldoutBudgetExhausted) return
        throw e
      }
    }
  }

  /** The pack's holdout budget, when it declares one: a revelation is refused once it is spent. */
  private debitHoldout(def: PackDefinition, book: Book, reason: string): void {
    if (def.manifest.holdout?.budget === undefined) return
    try {
      book.debitHoldout(reason)
    } catch (e) {
      if (e instanceof HoldoutBudgetExhausted) throw new LifecycleError('BUDGET_EXCEEDED', e.message)
      throw e
    }
  }

  /** Servings follow the champion state through one queue, so rows are written in order. */
  private sync(): Promise<void> {
    const run = this.chain.then(() => this.reconcileServings(this.champion.current()))
    this.chain = run.catch(() => {})
    return run
  }

  /**
   * A kept challenger has one open serving row (`by: promote`, from its
   * promotion); when it is no longer kept that row closes and an event row
   * (`by: demote` with the consent, or `by: reversed` after a settlement —
   * what `reverse` noted, `demote` for a change made behind the service's
   * back) marks the moment.
   */
  private async reconcileServings(state: ChampionState): Promise<void> {
    const now = new Date().toISOString()
    const servings = this.ledger.servings()
    const kept = new Set(state.kept.map((k) => k.challenger_id))
    const profile_sha = stateSha(state)
    for (const k of state.kept) {
      if (servings.some((s) => s.champion_id === k.challenger_id && s.by === 'promote' && s.to === undefined)) continue
      await this.ledger.recordServing({
        id: sha256(canonicalJson(['promote', k.challenger_id, k.promoted_at])),
        champion_id: k.challenger_id, from: k.promoted_at, by: 'promote', consent_id: k.consent_id, profile_sha,
      })
    }
    for (const s of servings) {
      if (s.to !== undefined || s.by !== 'promote' || kept.has(s.champion_id)) continue
      await this.ledger.recordServing({ ...s, to: now })
      const why = this.demotions.get(s.champion_id) ?? { by: 'demote' }
      this.demotions.delete(s.champion_id)
      await this.ledger.recordServing({
        id: sha256(canonicalJson([why.by, s.champion_id, now])),
        champion_id: s.champion_id, from: now, to: now, by: why.by, ...(why.consent_id !== undefined ? { consent_id: why.consent_id } : {}), profile_sha,
      })
    }
  }
}

/** The scope patch a row describes: the skill snapshot for the skill surface, the loader rows otherwise. */
function patchOf(row: ChallengerRow, def: PackDefinition): Patch {
  if (row.surface === 'skill') {
    if (!row.patch.skill_ref) throw new LifecycleError('BAD_TRANSITION', `skill challenger ${row.id} has no patch.skill_ref`)
    return { surface: 'skill', skill_dir: row.patch.skill_ref, mount: def.manifest.skill.dir.replace(/\/+$/, '') }
  }
  const rows = row.patch.cordis
  if (!Array.isArray(rows)) throw new LifecycleError('BAD_TRANSITION', `challenger ${row.id} patch.cordis must be a list of loader patch rows`)
  return { surface: row.surface as Exclude<Patch['surface'], 'skill'>, rows: rows as PatchOptions[] }
}

// The loader mounts this module as the `lifecycle` row: a Service class is a plugin.
export default Lifecycle
