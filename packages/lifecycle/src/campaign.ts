// The campaign driver (lifecycle spec § Campaign driver): rounds of
// propose → open → run → judge → decide under one experiment, with the stop
// rules, the escalations (replicates at held-in, then holdout) and the
// consents between them. Every transition is the service's; this module
// sequences them, reads the ledger for what came before, and writes the
// proposer's `history.jsonl` beside the view the runner renders. Resumable:
// a campaign on the same experiment continues from its last open round, the
// sibling's status saying where.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { TaskSet } from '@oldbulb/samsara-book'
import { challengerId, evalConfigSha, type ChallengerProposal, type ChallengerRow, type CompareRow, type ConsentRow, type ExperimentRow, type RoundRow, type Tier } from '@oldbulb/samsara-ledger'
import { loadPack, type PackDefinition } from '@oldbulb/samsara-pack'
import { ScopeError } from '@oldbulb/samsara-scope'
import type { RunResult } from './executor.ts'
import { LifecycleError, type Lifecycle, type LifecycleErrorCode, type LifecycleEvent, type LifecycleLedger, type ProposerRoute, type RoundOutcome, type RunOptions, type RunSummary } from './index.ts'

export const HISTORY_FILE = 'history.jsonl'
export const VIEW_MANIFEST = 'view.json'

/** The champion a round anchors on: the runner's `championProposal` for the state served now, and the skill directory the attempts run. */
export interface CampaignChampion {
  proposal: ChallengerProposal
  skillDir: string
}

/** What a proposer returns; structurally the `Proposal` of @oldbulb/samsara-proposers. */
export interface CampaignProposal {
  surface: string
  patch: { surface: 'skill'; skill_dir: string } | { surface: string; rows: unknown[] }
  intent: string
  prediction: ChallengerProposal['prediction']
  proposer: { name: string; version: string; config_sha: string }
}

/** The proposer; structurally a `ProposerAdapter`, which the runner resolves by name (and wraps with the sandbox policy, E9). */
export interface CampaignProposer {
  readonly name: string
  readonly version: string
  readonly configSha: string
  propose(input: { viewDir: string; workDir: string; signal: AbortSignal; parent: string }): Promise<CampaignProposal>
}

export type CampaignRunOptions = Pick<RunOptions, 'maxTurns' | 'maxMinutes' | 'allow' | 'parallel' | 'route'>

export interface CampaignInput {
  experimentId: string
  /** The pack directory. */
  pack: string
  /** Called before every round, so a promotion is followed. */
  champion(): CampaignChampion
  proposer: CampaignProposer
  metric: string
  nEffFloor: number
  /** The set the proposer view renders; never the held-out one. */
  set: Exclude<TaskSet, 'holdout'>
  /** Replicates per tier; a held-in `hold:underpowered` doubles them up to `maxRepeat`. Without `holdout` a held-in hold ends the round. */
  tiers: { holdin: { repeat: number; maxRepeat?: number }; holdout?: { repeat: number } }
  /** `maxRounds` counts the rounds this call drives (the experiment's `budget.rounds` is the durable limit); `maxConsecutiveHolds` counts decided rounds since the last promotion, from the ledger on resume. */
  stop: { maxRounds: number; maxConsecutiveHolds: number; budgetUsd?: number; stopOnPromote: boolean }
  /** Run holdout after a held-in hold without a `holdout_reveal` consent; the experiment's pre-registered `auto_reveal` says the same. */
  autoHoldout: boolean
  shadowGates?: string[]
  out: string
  run: CampaignRunOptions
  operator?: RoundRow['operator']
  /** The route the proposer declares, passed to every `openRound` (refused there when it is the operator's). */
  proposerRoute?: ProposerRoute | 'unknown'
}

export type ConsentAction = 'promote' | 'holdout_reveal'

/** What the runner renders for the proposer (its `renderView`); the campaign writes `history.jsonl` into the same directory afterwards. */
export interface ViewInput {
  championId: string
  championSkillDir: string
  metric: string
  tasks: readonly unknown[]
  history: HistoryLine[]
}

export interface CampaignHooks {
  onEvent(e: CampaignEvent): void
  signal: AbortSignal
  /** Ask for a consent the round needs (a `promote` is bound to `roundId`); the row it returns is on the ledger. Absent, or resolving undefined, pauses the campaign. */
  consent?(action: ConsentAction, subject: string, roundId: string): Promise<ConsentRow | undefined>
  renderView(dir: string, input: ViewInput): void
  /** The content hash of a directory (`hashDir` of @oldbulb/samsara-workdir, the one the scope snapshots by). */
  hashDir(dir: string): string
}

export type CampaignStop = 'max_rounds' | 'consecutive_holds' | 'budget' | 'promoted' | 'aborted' | 'no_noise_floor'

export type CampaignEvent =
  | { kind: 'round:opened'; roundId: string; championId: string; resumed: boolean }
  | { kind: 'attempt:progress'; roundId: string; challengerId: string; tier: Tier; line: string }
  | { kind: 'judged'; roundId: string; challengerId: string; tier: Tier; compare: CompareRow; spent: ExperimentRow['spent'] }
  | { kind: 'decided'; roundId: string; challengerId?: string; verdict?: string; promoted?: string; spent: ExperimentRow['spent'] }
  | { kind: 'paused'; roundId: string; action: ConsentAction; candidate: string }
  | { kind: 'stopped'; reason: CampaignStop; spent: ExperimentRow['spent'] }

export interface CampaignRoundSummary {
  roundId: string
  challengerId?: string
  tier?: Tier
  verdict?: string
  promoted?: string
}

export type CampaignResult =
  | { paused: 'consent'; action: ConsentAction; roundId: string; candidate: string; rounds: CampaignRoundSummary[]; promoted: string[] }
  | { paused?: undefined; stopped: CampaignStop; rounds: CampaignRoundSummary[]; promoted: string[] }

/** One prior sibling of the experiment as the proposer may see it: held-in numbers only, never a held-out one. */
export interface HistoryLine {
  round_id: string
  challenger_id: string
  tier?: Tier
  verdict?: string
  mean?: number
  ci?: [number, number]
  n_eff?: number
  mde?: number
}

export type CampaignLifecycle = Pick<Lifecycle, 'openRound' | 'closeRound' | 'propose' | 'open' | 'run' | 'judge' | 'decide'>
export type CampaignLedger = Pick<LifecycleLedger, 'experiment' | 'round' | 'challenger' | 'attemptsOf' | 'comparesOf' | 'consentsOf' | 'noiseFloorFor'>

export interface CampaignDeps {
  lifecycle: CampaignLifecycle
  ledger: CampaignLedger
  /** The service's event bus: every campaign event is forwarded, and a consent the hook records is announced. */
  emit?(e: LifecycleEvent): void
}

type RoundEnd =
  | { end: 'decided'; challengerId?: string; tier?: Tier; verdict?: string; promoted?: string }
  | { end: 'paused'; action: ConsentAction; candidate: string }
  | { end: 'stopped'; reason: CampaignStop }

const ABORTED: RoundEnd = { end: 'stopped', reason: 'aborted' }

function codeOf(e: unknown): LifecycleErrorCode | undefined {
  return e instanceof LifecycleError ? e.code : undefined
}

function latestBy<T>(rows: readonly T[], at: (r: T) => string): T | undefined {
  return [...rows].sort((a, b) => (at(a) < at(b) ? 1 : at(a) > at(b) ? -1 : 0))[0]
}

function jsonl(rows: readonly unknown[]): string {
  return rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '')
}

/** The gate's verdict was `hold:underpowered`: the row's verdict loses the suffix, the rule (`power:*`) keeps it. */
function underpowered(row: ChallengerRow): boolean {
  return row.status === 'judged' && row.tier_reached === 'holdin' && row.verdict?.value === 'hold' && row.verdict.rule.startsWith('power:')
}

function holdinCompareOf(ledger: Pick<CampaignLedger, 'comparesOf'>, id: string, roundId: string): CompareRow | undefined {
  return latestBy(ledger.comparesOf(id).filter((c) => !c.shadow && c.tier === 'holdin' && c.round_id === roundId), (c) => c.at)
}

/** Replicates the ledger holds for the row on a tier: the samples its attempts reached, whatever run recorded them. */
function replicatesOf(ledger: Pick<CampaignLedger, 'attemptsOf'>, id: string, tier: Tier): number {
  return ledger.attemptsOf(id).reduce((n, a) => (a.tier === tier ? Math.max(n, a.sample + 1) : n), 0)
}

// ----------------------------------------------------------------- pure

/** The noise floor a round on this champion would pin (S1): refused before a round judged at holdout is spent. */
export function requireNoiseFloor(ledger: Pick<CampaignLedger, 'noiseFloorFor'>, def: Pick<PackDefinition, 'name'>, champion: ChallengerProposal, metric: string): void {
  const floor = ledger.noiseFloorFor(evalConfigSha({ ...champion, pack: def.name }), challengerId(champion), champion.route.loop, metric)
  if (!floor) throw new LifecycleError('NO_NOISE_FLOOR', `no noise floor for champion ${challengerId(champion)} on ${metric}; calibrate before a round judged at holdout`)
}

/** The challenger row for a skill directory: the champion's coordinates with the snapshot as the patch and the champion as parent. */
export function skillChallengerOf(
  champion: ChallengerProposal,
  championId: string,
  input: { skillDir: string; intent: string; prediction: ChallengerProposal['prediction']; optimizerConfigSha?: string },
  hashDir: (dir: string) => string,
): ChallengerProposal {
  const skill_sha = hashDir(input.skillDir)
  return {
    ...champion,
    parent_ids: [championId],
    patch_sha: skill_sha,
    skill_sha,
    patch: { skill_ref: resolve(input.skillDir), before: champion.patch.skill_ref ?? '' },
    intent: input.intent,
    prediction: input.prediction,
    ...(input.optimizerConfigSha !== undefined ? { optimizer_config_sha: input.optimizerConfigSha } : {}),
  }
}

/** One line per sibling of the experiment's rounds: the tier reached, the verdict, and the held-in compare's numbers; a held-out compare contributes nothing. */
export function campaignHistory(experiment: ExperimentRow, ledger: Pick<CampaignLedger, 'round' | 'challenger' | 'comparesOf'>): HistoryLine[] {
  const lines: HistoryLine[] = []
  for (const roundId of experiment.round_ids) {
    const round = ledger.round(roundId)
    if (!round) continue
    for (const id of round.sibling_ids) {
      const row = ledger.challenger(id)
      if (!row) continue
      const compare = holdinCompareOf(ledger, id, roundId)
      lines.push({
        round_id: roundId,
        challenger_id: id,
        ...(row.tier_reached !== undefined ? { tier: row.tier_reached } : {}),
        ...(row.verdict ? { verdict: row.verdict.value } : {}),
        ...(compare ? { mean: compare.mean, ci: compare.ci, n_eff: compare.n_eff, mde: compare.mde } : {}),
      })
    }
  }
  return lines
}

/** `history.jsonl` into a rendered view directory, listed in its `view.json`. */
export function writeHistory(viewDir: string, history: HistoryLine[]): void {
  mkdirSync(viewDir, { recursive: true })
  writeFileSync(resolve(viewDir, HISTORY_FILE), jsonl(history))
  const manifest = resolve(viewDir, VIEW_MANIFEST)
  const view = existsSync(manifest) ? (JSON.parse(readFileSync(manifest, 'utf8')) as { files?: string[] }) : {}
  const files = view.files ?? []
  if (!files.includes(HISTORY_FILE)) files.push(HISTORY_FILE)
  writeFileSync(manifest, JSON.stringify({ ...view, files }, null, 2) + '\n')
}

/** Consecutive holds at the end of the decided rounds: what the stop rule counts when a campaign resumes (an open round's hold is still being driven). */
function trailingHolds(experiment: ExperimentRow, ledger: Pick<CampaignLedger, 'round' | 'challenger' | 'comparesOf'>): number {
  const decided = experiment.round_ids.filter((id) => ledger.round(id)?.status === 'decided')
  let n = 0
  for (const line of campaignHistory({ ...experiment, round_ids: decided }, ledger).reverse()) {
    if (line.verdict?.startsWith('hold')) n++
    else if (line.verdict === 'promote') break
  }
  return n
}

// --------------------------------------------------------------- driver

export function runCampaign(deps: CampaignDeps, input: CampaignInput, hooks: CampaignHooks): Promise<CampaignResult> {
  return new Campaign(deps, input, hooks).run()
}

class Campaign {
  private readonly def: PackDefinition
  private readonly rounds: CampaignRoundSummary[] = []
  private readonly promoted: string[] = []
  private holds: number
  private champion: CampaignChampion

  constructor(private readonly deps: CampaignDeps, private readonly input: CampaignInput, private readonly hooks: CampaignHooks) {
    this.def = loadPack(input.pack)
    this.holds = trailingHolds(this.experiment(), deps.ledger)
    this.champion = input.champion()
  }

  async run(): Promise<CampaignResult> {
    let resume = this.lastOpenRound()
    for (;;) {
      const stop = this.stopRule()
      if (stop) return this.stopped(stop)
      let round: RoundRow
      try {
        round = await this.openRound(resume)
      } catch (e) {
        if (codeOf(e) === 'BUDGET_EXCEEDED') return this.stopped('budget')
        if (codeOf(e) === 'NO_NOISE_FLOOR') return this.stopped('no_noise_floor')
        throw e
      }
      this.emit({ kind: 'round:opened', roundId: round.id, championId: round.champion_id, resumed: resume !== undefined })
      resume = undefined
      const end = await this.drive(round)
      if (end.end === 'stopped') return this.stopped(end.reason)
      if (end.end === 'paused') {
        this.emit({ kind: 'paused', roundId: round.id, action: end.action, candidate: end.candidate })
        return { paused: 'consent', action: end.action, roundId: round.id, candidate: end.candidate, rounds: this.rounds, promoted: this.promoted }
      }
      const { end: _e, ...summary } = end
      this.rounds.push({ roundId: round.id, ...summary })
      if (end.promoted !== undefined) {
        this.promoted.push(end.promoted)
        this.holds = 0
        if (this.input.stop.stopOnPromote) return this.stopped('promoted')
      } else if (end.verdict?.startsWith('hold')) {
        this.holds++
      }
    }
  }

  // --------------------------------------------------------- stop rules

  /** Checked before each round; nothing is spent past a rule. */
  private stopRule(): CampaignStop | undefined {
    const { stop } = this.input
    if (this.hooks.signal.aborted) return 'aborted'
    if (this.rounds.length >= stop.maxRounds) return 'max_rounds'
    if (this.holds >= stop.maxConsecutiveHolds) return 'consecutive_holds'
    if (stop.budgetUsd !== undefined && this.experiment().spent.usd >= stop.budgetUsd) return 'budget'
    return undefined
  }

  private stopped(reason: CampaignStop): CampaignResult {
    this.emit({ kind: 'stopped', reason, spent: this.experiment().spent })
    return { stopped: reason, rounds: this.rounds, promoted: this.promoted }
  }

  // ------------------------------------------------------------- rounds

  private lastOpenRound(): RoundRow | undefined {
    return this.experiment().round_ids.map((id) => this.deps.ledger.round(id)).filter((r): r is RoundRow => r?.status === 'open').at(-1)
  }

  /** Reopen the last open round on the same coordinates (so the service reloads its pack and policy), or open a fresh one. */
  private async openRound(resume: RoundRow | undefined): Promise<RoundRow> {
    this.champion = this.input.champion()
    const { proposal } = this.champion
    const base = {
      pack: this.input.pack, champion: proposal, metric: this.input.metric, nEffFloor: this.input.nEffFloor, experimentId: this.input.experimentId,
      ...(this.input.shadowGates !== undefined ? { shadowGates: this.input.shadowGates } : {}),
      ...(this.input.operator !== undefined ? { operator: this.input.operator } : {}),
      ...(this.input.proposerRoute !== undefined ? { proposerRoute: this.input.proposerRoute } : {}),
    }
    if (resume) {
      if (resume.champion_id === challengerId(proposal)) return this.deps.lifecycle.openRound({ ...base, openedAt: resume.opened_at })
      // The champion moved while the round was open: nothing in it is judged against the one served now.
      await this.deps.lifecycle.closeRound(resume.id)
    }
    // A holdout tier needs the noise floor the round would pin (S1): refuse before a round is spent.
    if (this.input.tiers.holdout) requireNoiseFloor(this.deps.ledger, this.def, proposal, this.input.metric)
    return this.deps.lifecycle.openRound({ ...base, openedAt: this.openedAt() })
  }

  /** Strictly after every round of the experiment, so two rounds never share an id. */
  private openedAt(): string {
    const now = new Date()
    const last = this.experiment().round_ids.map((id) => this.deps.ledger.round(id)?.opened_at ?? '').sort().at(-1) ?? ''
    if (now.toISOString() > last) return now.toISOString()
    return new Date(new Date(last).getTime() + 1).toISOString()
  }

  private async drive(round: RoundRow): Promise<RoundEnd> {
    try {
      return await this.steps(round)
    } catch (e) {
      // A cancelled run leaves the round open and the row at its last status.
      if (this.hooks.signal.aborted) return ABORTED
      if (codeOf(e) === 'BUDGET_EXCEEDED') return { end: 'stopped', reason: 'budget' }
      if (codeOf(e) === 'NO_NOISE_FLOOR') return { end: 'stopped', reason: 'no_noise_floor' }
      throw e
    }
  }

  /** The round's one sibling from wherever the ledger left it to a decision, a pause or a stop. */
  private async steps(round: RoundRow): Promise<RoundEnd> {
    const out = resolve(this.input.out, round.id.slice(0, 12))
    const id = round.sibling_ids.at(-1) ?? (await this.propose(round, out))
    if (this.aborted()) return ABORTED
    let row = this.row(id)
    if (row.status !== 'decided') {
      try {
        await this.deps.lifecycle.open(id)
      } catch (e) {
        if (!(e instanceof ScopeError && e.code === 'PATCH_REJECTED')) throw e
      }
      row = this.row(id)
    }
    if (row.status === 'decided') return this.decide(round, id)

    // smoke: validity only.
    if (row.status === 'opened' || (row.status === 'running' && row.tier_reached === 'smoke')) {
      const smoke = await this.runTier(round, id, 'smoke', 1, out)
      if (!smoke) return ABORTED
      if (!smoke.invalid) await this.judgeTier(round, id, 'smoke')
      row = this.row(id)
    }
    if (row.tier_reached === 'smoke') {
      if (row.verdict?.value !== 'hold') return this.decide(round, id)
      if (this.aborted()) return ABORTED
    }

    // holdin: the screen, with the replicates doubled while the design is underpowered. A resumed row
    // continues at the replicates its attempts reached, its verdict saying whether the design was underpowered.
    const { holdin } = this.input.tiers
    let repeat = holdin.repeat
    if (row.tier_reached === 'holdin') repeat = Math.max(repeat, replicatesOf(this.deps.ledger, id, 'holdin'))
    if (row.tier_reached !== 'holdout' && !(row.status === 'judged' && row.tier_reached === 'holdin')) {
      const summary = await this.runTier(round, id, 'holdin', repeat, out)
      if (!summary) return ABORTED
      if (!summary.invalid) await this.judgeTier(round, id, 'holdin')
      row = this.row(id)
    }
    while (underpowered(row)) {
      const next = Math.min(holdin.maxRepeat ?? repeat, repeat * 2)
      if (next <= repeat) break
      if (this.aborted()) return ABORTED
      repeat = next
      const summary = await this.runTier(round, id, 'holdin', repeat, out, true)
      if (!summary) return ABORTED
      if (!summary.invalid) await this.judgeTier(round, id, 'holdin')
      row = this.row(id)
    }
    if (row.tier_reached !== 'holdout') {
      if (row.verdict?.value !== 'hold' || !this.input.tiers.holdout) return this.decide(round, id)
      if (this.aborted()) return ABORTED
      if (round.noise_floor_id === undefined) return { end: 'stopped', reason: 'no_noise_floor' }
      // The reveal is the person's: pre-registered on the experiment (auto_reveal), the driver's autoHoldout, or a holdout_reveal consent per row.
      const autoReveal = this.input.autoHoldout || this.experiment().auto_reveal === true
      if (!autoReveal && !(await this.consentFor('holdout_reveal', id, round))) return { end: 'paused', action: 'holdout_reveal', candidate: id }
    }

    // holdout: one pre-registered test; a run left running is rerun, its attempts may be partial.
    if (row.tier_reached !== 'holdout' || row.status === 'running') {
      const summary = await this.runTier(round, id, 'holdout', this.input.tiers.holdout?.repeat ?? repeat, out)
      if (!summary) return ABORTED
      if (!summary.invalid) await this.judgeTier(round, id, 'holdout')
    }
    if (this.aborted()) return ABORTED
    return this.decide(round, id)
  }

  /** Render the view and its history, run the proposer, land the row in the round. */
  private async propose(round: RoundRow, out: string): Promise<string> {
    const viewDir = resolve(out, 'view')
    const workDir = resolve(out, 'proposer')
    const history = campaignHistory(this.experiment(), this.deps.ledger)
    const tasks = this.def.taskSets[this.input.set].tasks
    this.hooks.renderView(viewDir, { championId: round.champion_id, championSkillDir: this.champion.skillDir, metric: this.input.metric, tasks, history })
    writeHistory(viewDir, history)
    mkdirSync(workDir, { recursive: true })
    const proposal = await this.input.proposer.propose({ viewDir, workDir, signal: this.hooks.signal, parent: round.champion_id })
    const skillDir = this.checkProposal(proposal, workDir)
    writeFileSync(resolve(out, 'proposal.json'), JSON.stringify(proposal, null, 2) + '\n')
    const row = skillChallengerOf(
      this.champion.proposal, round.champion_id,
      { skillDir, intent: proposal.intent, prediction: proposal.prediction, optimizerConfigSha: proposal.proposer.config_sha },
      this.hooks.hashDir,
    )
    const { id } = await this.deps.lifecycle.propose(row, { roundId: round.id })
    return id
  }

  /** What the host checks before a proposal costs anything: the v1 surface, the round's metric, held-in task ids only. */
  private checkProposal(proposal: CampaignProposal, workDir: string): string {
    const { patch } = proposal
    if (proposal.surface !== 'skill' || !('skill_dir' in patch)) {
      throw new LifecycleError('BAD_TRANSITION', `the proposal's surface "${proposal.surface}" is not a v1 challenger surface (only skill)`)
    }
    if (proposal.prediction.metric !== this.input.metric) {
      throw new LifecycleError('BAD_TRANSITION', `the proposal predicts metric "${proposal.prediction.metric}" but the campaign judges "${this.input.metric}"`)
    }
    const heldIn = new Set([...this.def.taskSets.smoke.tasks, ...this.def.taskSets.holdin.tasks].map((t) => t.task_id))
    const named = [...(proposal.prediction.predicted_fixes ?? []), ...(proposal.prediction.at_risk ?? [])]
    const outside = named.filter((t) => !heldIn.has(t))
    if (outside.length) throw new LifecycleError('BAD_TRANSITION', `the proposal names task ids outside the held-in set: ${outside.join(', ')}`)
    return resolve(workDir, patch.skill_dir)
  }

  /** Nothing runs past the signal, and a run it cut short (attempts missing or aborted) is nothing to judge: undefined, the row left running for a resume. */
  private async runTier(round: RoundRow, id: string, tier: TaskSet, repeat: number, out: string, withChampion = false): Promise<RunSummary | undefined> {
    if (this.aborted()) return undefined
    const opts: RunOptions = {
      ...this.input.run,
      repeat,
      out: resolve(out, `${tier}-x${repeat}`),
      championSkillDir: this.champion.skillDir,
      signal: this.hooks.signal,
      log: (line) => this.emit({ kind: 'attempt:progress', roundId: round.id, challengerId: id, tier, line }),
      ...(withChampion ? { withChampion } : {}),
    }
    const summary = await this.deps.lifecycle.run(id, tier, opts)
    const expected = this.def.taskSets[tier].tasks.length * repeat
    const complete = (result: RunResult | undefined) => !result || (result.rows.length >= expected && result.rows.every((r) => r.status !== 'ABORTED'))
    return complete(summary.champion) && complete(summary.challenger) ? summary : undefined
  }

  /** The service's judgement; a row it found invalid (rule 0, no noise floor) is judged already and yields no compare. */
  private async judgeTier(round: RoundRow, id: string, tier: Tier): Promise<CompareRow | undefined> {
    try {
      const compare = await this.deps.lifecycle.judge(id, tier)
      this.emit({ kind: 'judged', roundId: round.id, challengerId: id, tier, compare, spent: this.experiment().spent })
      return compare
    } catch (e) {
      const code = codeOf(e)
      if (code === 'NOT_COMPARABLE' || code === 'NO_NOISE_FLOOR') return undefined
      throw e
    }
  }

  /** Close the round through `decide`; a promote candidate waits for its consent through the hook, or pauses. */
  private async decide(round: RoundRow, id: string): Promise<RoundEnd> {
    let outcome: RoundOutcome = await this.deps.lifecycle.decide(round.id)
    if (outcome.pending) {
      if (await this.consentFor('promote', outcome.candidate, round)) outcome = await this.deps.lifecycle.decide(round.id)
      if (outcome.pending) return { end: 'paused', action: 'promote', candidate: outcome.candidate }
    }
    const row = this.row(id)
    const end: RoundEnd = {
      end: 'decided', challengerId: id,
      ...(row.tier_reached !== undefined ? { tier: row.tier_reached } : {}),
      ...(row.verdict !== undefined ? { verdict: row.verdict.value } : {}),
      ...(outcome.promoted !== undefined ? { promoted: outcome.promoted } : {}),
    }
    const { end: _e, ...summary } = end
    this.emit({ kind: 'decided', roundId: round.id, ...summary, spent: this.experiment().spent })
    return end
  }

  private async consentFor(action: ConsentAction, subject: string, round: RoundRow): Promise<ConsentRow | undefined> {
    // A promote consent decides one round (E2); a reveal is the row's.
    const existing = this.deps.ledger.consentsOf(subject).find((c) => c.action === action && (action !== 'promote' || c.round_id === round.id))
    if (existing) return existing
    const row = await this.hooks.consent?.(action, subject, round.id)
    if (row) this.deps.emit?.({ kind: 'consent/recorded', id: row.id, action: row.action, at: new Date().toISOString() })
    return row
  }

  // ------------------------------------------------------------ helpers

  private experiment(): ExperimentRow {
    const experiment = this.deps.ledger.experiment(this.input.experimentId)
    if (!experiment) throw new LifecycleError('UNKNOWN', `no experiment ${this.input.experimentId}`)
    return experiment
  }

  private row(id: string): ChallengerRow {
    const row = this.deps.ledger.challenger(id)
    if (!row) throw new LifecycleError('UNKNOWN', `no challenger ${id}`)
    return row
  }

  private aborted(): boolean {
    return this.hooks.signal.aborted
  }

  private emit(e: CampaignEvent): void {
    this.hooks.onEvent(e)
    this.deps.emit?.({ kind: 'campaign', ...('roundId' in e ? { roundId: e.roundId } : {}), experimentId: this.input.experimentId, event: e, at: new Date().toISOString() })
  }
}
