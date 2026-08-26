// The whole chain for one challenger, without a proposer, through
// ctx.lifecycle: a round for the champion of these coordinates (or the one
// `--round` names) → propose → open (diff scan, E8/S5; nothing runs on
// rejection) → run in the scope → judge against the champion's attempts on
// the same tasks under the round's gate → decide. A row the service refuses
// to run (decided before this command, rejected by the diff scan, invalid on
// the run invariant) closes its round instead, so no rejected challenger
// leaves a round open. The command performs no transition itself: every
// status, compare row and round row is the service's. `--gate-policy` names a policy the host mounted on ctx.gate (the
// presets and catalog rules through this package's gate-presets plugin): the
// promotion gate (`default`, the one mounted last) judges for real; any other
// mounted policy judges as a shadow beside it (a compare row that sets no
// verdict) unless a `gate_change` consent names it, in which case the round
// pins it. Like run.ts, every dependency comes in through `ChallengeDeps`.

import { resolve } from 'node:path'
import { gateDefault, gateMethodOf, GATE_DEFAULT_NAME, GATE_DEFAULT_VERSION, type GatePolicyProvider, type GateRegistry } from '@oldbulb/samsara-gate'
import { CATALOG, catalogGate } from '@oldbulb/samsara-gate-catalog'
import { refMethod, type Lifecycle, type RoundOutcome, type RunOptions } from '@oldbulb/samsara-lifecycle'
import { compareKey, type ChallengerProposal, type ChallengerRow, type CompareRow, type Ledger, type RoundRow } from '@oldbulb/samsara-ledger'
import { loadPack, type PackDefinition } from '@oldbulb/samsara-pack'
import { ScopeError, type Scope, type Violation } from '@oldbulb/samsara-scope'
import { hashDir } from '@oldbulb/samsara-workdir'
import { bookOf, championProposal, envLockOf, newRunId, writeEnvLock, type RunDeps, type RunRequest, type RunResult } from './run.ts'

export { scoredAttemptsOf } from '@oldbulb/samsara-lifecycle'

/**
 * `--gate-policy`: one of the runner's presets (`GATE_PRESETS`) or a rule name
 * from @oldbulb/samsara-gate-catalog; the host must have mounted it on
 * ctx.gate (a `@oldbulb/samsara-runner/gate-presets` row). Anything but the
 * promotion gate judges as a shadow unless a `gate_change` consent names it.
 */
export type GatePolicyName = string

export interface ChallengeRequest extends RunRequest {
  surface: 'skill'
  skillDir: string
  intent: string
  /** Primary metric (kind reality) the gate decides on. */
  metric: string
  nEffFloor: number
  /** Run the champion on the same tasks in this command instead of reusing its ledger attempts. */
  withChampion: boolean
  gatePolicy: GatePolicyName
  /** Reuse this round (its gate, shadows and experiment) instead of opening one. */
  round?: string
  /** Open the round under this pre-registered experiment. */
  experiment?: string
  /** The proposer's falsifiable contract; defaults to `{ metric, direction: 'up' }`. */
  prediction?: ChallengerProposal['prediction']
  /** The proposer's config sha (`optimizer_config_sha` on the row); defaults to the champion's. */
  optimizerConfigSha?: string
}

export type ChallengeLedger = Pick<Ledger, 'challenger' | 'attemptsOf' | 'scoresOf' | 'comparesOf' | 'consentsOf' | 'round'>
export type ChallengeLifecycle = Pick<Lifecycle, 'openRound' | 'closeRound' | 'propose' | 'open' | 'run' | 'judge' | 'decide'>

export interface ChallengeDeps extends Omit<RunDeps, 'ledger' | 'challengerId' | 'materialize' | 'heartbeatMs'> {
  ledger: ChallengeLedger
  lifecycle: ChallengeLifecycle
  gate: Pick<GateRegistry, 'judge' | 'current' | 'list'>
}

export interface ChallengeResult {
  challengerId: string
  championId: string
  roundId: string
  rejected?: Violation[]
  champion?: RunResult
  challenger?: RunResult
  /** Set when the run invariant failed (`coordinates:facts`): the row is judged invalid and no statistic was computed. */
  invalid?: string
  /** Set when the row was decided before this command (rejected, dropped, invalid): its verdict on the ledger; nothing ran. */
  decided?: NonNullable<ChallengerRow['verdict']>
  /** The compare row of the gate `--gate-policy` named: the round's gate, or the shadow row beside it. */
  compare?: CompareRow
  /** Set when the compare row for these coordinates already existed (the judgement above was not recorded). */
  verdictExists?: boolean
  /** `name@version` of the policy mounted on ctx.gate: the one whose verdict can promote. */
  promotionGate?: string
  /** The judgement came from another gate without a `gate_change` consent: a shadow row, the challenger's verdict from the round's gate. */
  shadow?: boolean
  /** What became of the round: a holdout promote verdict waits for its consent, anything else decides or closes the round. */
  outcome?: RoundOutcome
}

/** Exploration preset: the default statistics at one-sided alpha 0.10; recorded on the ledger as gate-fast@0.1.0. */
export const GATE_FAST = {
  name: 'gate-fast',
  version: '0.1.0',
  judge: (req: Parameters<typeof gateDefault>[0]) => gateDefault({ ...req, policy: { ...req.policy, alpha: 0.1 } }),
}

/** TEST ONLY: the default statistics with the verdict forced to promote; recorded on the ledger as gate-permissive@test. */
export const GATE_PERMISSIVE = {
  name: 'gate-permissive',
  version: 'test',
  judge: (req: Parameters<typeof gateDefault>[0]) => ({ ...gateDefault(req), verdict: 'promote' as const }),
}

/** gate-default as a provider of its own (what `ctx.gate` judges with when no preset is registered). */
export const GATE_DEFAULT: GatePolicyProvider = { name: GATE_DEFAULT_NAME, version: GATE_DEFAULT_VERSION, judge: gateDefault }

export const GATE_PRESETS = ['default', 'fast', 'permissive'] as const

/** Every name `--gate-policy` accepts: the presets, then the catalog rules. */
export function gatePolicyNames(): string[] {
  return [...GATE_PRESETS, ...CATALOG.map((g) => g.name)]
}

/** The provider a policy name stands for; `default` is `ctx.gate`'s own, so it resolves to nothing to register. Unknown names throw. */
export function gatePresetOf(name: GatePolicyName): GatePolicyProvider | undefined {
  if (name === 'default') return undefined
  if (name === 'fast') return GATE_FAST
  if (name === 'permissive') return GATE_PERMISSIVE
  const rule = catalogGate(name)
  if (!rule) throw new Error(`unknown gate policy "${name}" (one of ${gatePolicyNames().join('|')})`)
  return rule
}

export interface GateSelection {
  /** `name@version` of the policy mounted last on ctx.gate: the one whose verdict can promote. */
  promotionGate: string
  /** `name@version` of the policy `--gate-policy` names (the promotion gate for `default`). */
  gate: string
  /** The named policy is not the promotion gate and no gate_change consent names it: it judges beside the round's gate, setting no verdict. */
  shadow: boolean
}

/**
 * The policy `--gate-policy` names. It must be mounted on ctx.gate: the
 * service pins what the host mounted, and a policy registered by a command
 * would become the promotion gate (the one mounted last).
 */
export function gateFor(name: GatePolicyName, deps: Pick<ChallengeDeps, 'gate' | 'ledger'>): GateSelection {
  const mounted = deps.gate.current()
  const promotionGate = mounted ? gateMethodOf(mounted) : ''
  if (!promotionGate) throw new Error('no gate policy is mounted on ctx.gate')
  const preset = gatePresetOf(name)
  const gate = preset ? gateMethodOf(preset) : promotionGate
  if (preset && !deps.gate.list().some((p) => gateMethodOf(p) === gate)) {
    throw new Error(`gate policy ${gate} is not mounted on ctx.gate (mount it in the profile with a @oldbulb/samsara-runner/gate-presets row: before the promotion gate to judge as a shadow, last to be the promotion gate)`)
  }
  const consented = deps.ledger.consentsOf(gate).some((c) => c.action === 'gate_change')
  return { promotionGate, gate, shadow: gate !== promotionGate && !consented }
}

/**
 * The round the chain runs in: the one `req.round` names, opened again in this
 * process under its own coordinates (the service keeps the pack and policy in
 * memory), or a new one under the named gate — as its gate when it may set a
 * verdict, beside it as a shadow otherwise.
 */
export async function roundFor(
  req: Pick<ChallengeRequest, 'pack' | 'metric' | 'nEffFloor' | 'round' | 'experiment'>,
  champion: ChallengerProposal,
  selection: GateSelection,
  deps: Pick<ChallengeDeps, 'lifecycle' | 'ledger'>,
): Promise<RoundRow> {
  const base = { pack: req.pack, champion, metric: req.metric, nEffFloor: req.nEffFloor }
  if (req.round !== undefined) {
    const existing = deps.ledger.round(req.round)
    if (!existing) throw new Error(`no round ${req.round} on the ledger`)
    const round = await deps.lifecycle.openRound({
      ...base,
      gate: refMethod(existing.gate),
      shadowGates: existing.shadow_gates.map(refMethod),
      openedAt: existing.opened_at,
      ...(existing.experiment_id !== undefined ? { experimentId: existing.experiment_id } : {}),
    })
    if (round.id !== existing.id) {
      throw new Error(`round ${existing.id} was opened under other coordinates (champion ${existing.champion_id}, its evaluation configuration, gate policy or experiment); this command computes round ${round.id}`)
    }
    return round
  }
  return deps.lifecycle.openRound({
    ...base,
    ...(selection.shadow ? { shadowGates: [selection.gate] } : { gate: selection.gate }),
    ...(req.experiment !== undefined ? { experimentId: req.experiment } : {}),
  })
}

function stripRun(req: ChallengeRequest): RunRequest {
  const { surface: _s, skillDir: _d, intent: _i, metric: _m, nEffFloor: _n, withChampion: _w, gatePolicy: _g, round: _r, experiment: _e, prediction: _p, optimizerConfigSha: _o, ...run } = req
  return run
}

/** The challenger row: the champion's coordinates with the skill snapshot as the patch and the champion as parent. */
export function challengerProposalOf(champion: ChallengerProposal, championId: string, req: ChallengeRequest): ChallengerProposal {
  const skill_sha = hashDir(req.skillDir)
  return {
    ...champion,
    parent_ids: [championId],
    patch_sha: skill_sha,
    skill_sha,
    patch: { skill_ref: resolve(req.skillDir), before: champion.patch.skill_ref ?? '' },
    intent: req.intent,
    prediction: req.prediction ?? { metric: req.metric, direction: 'up' },
    ...(req.optimizerConfigSha !== undefined ? { optimizer_config_sha: req.optimizerConfigSha } : {}),
  }
}

/** What `lifecycle.run` needs of the request and the deps (the executor it calls is this plugin's runSet). */
export function runOptionsOf(req: RunRequest & { withChampion: boolean }, deps: Pick<ChallengeDeps, 'route' | 'championSkillDir' | 'signal' | 'log'>, runId: string): RunOptions {
  return {
    repeat: req.repeat, out: req.out, maxTurns: req.maxTurns, maxMinutes: req.maxMinutes, route: deps.route, withChampion: req.withChampion, runId,
    ...(req.allow !== undefined ? { allow: req.allow } : {}),
    ...(req.parallel !== undefined ? { parallel: req.parallel } : {}),
    ...(req.limit !== undefined ? { limit: req.limit } : {}),
    ...(req.stratum !== undefined ? { stratum: req.stratum } : {}),
    ...(req.env !== undefined ? { env: req.env } : {}),
    ...(deps.championSkillDir !== undefined ? { championSkillDir: deps.championSkillDir } : {}),
    ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
    ...(deps.log !== undefined ? { log: deps.log } : {}),
  }
}

function latestBy<T>(rows: readonly T[], at: (r: T) => string): T | undefined {
  return [...rows].sort((a, b) => (at(a) < at(b) ? 1 : at(a) > at(b) ? -1 : 0))[0]
}

/** Close the round without a decision (nothing in it can be ranked), as the outcome the result reports. */
async function closeRound(lifecycle: Pick<Lifecycle, 'closeRound'>, roundId: string): Promise<RoundOutcome> {
  const round = await lifecycle.closeRound(roundId)
  return { roundId, superseded: round.outcome?.superseded ?? [] }
}

export async function challenge(req: ChallengeRequest, deps: ChallengeDeps): Promise<ChallengeResult> {
  const def: PackDefinition = loadPack(req.pack)
  const book = bookOf(def)
  const runReq = stripRun(req)
  const log = deps.log ?? (() => {})
  const runId = deps.runId ?? newRunId()
  const { lifecycle } = deps

  // 0. the round: the champion row for these coordinates is its baseline; the
  // service refuses a promotion gate without a gate_change consent (nothing
  // opens under it).
  const selection = gateFor(req.gatePolicy, deps)
  const lock = writeEnvLock(req.out, envLockOf(def, req.loop))
  const champion = championProposal(def, book, runReq, deps, lock)
  const round = await roundFor(req, champion, selection, deps)
  const championId = round.champion_id
  const base = { challengerId: '', championId, roundId: round.id, promotionGate: selection.promotionGate }

  // 1. propose: the champion is the parent; rule 0 is the service's. A row
  // the ledger already holds decided (rejected, dropped, invalid) is rendered
  // from the ledger and nothing runs; its round is closed.
  const proposal = challengerProposalOf(champion, championId, req)
  const { id: challengerId, created } = await lifecycle.propose(proposal, { roundId: round.id })
  base.challengerId = challengerId
  log(`challenger ${challengerId} (parent champion ${championId}) intent: ${req.intent}; round ${round.id}`)
  const existing = created ? undefined : deps.ledger.challenger(challengerId)
  if (existing?.status === 'decided' && existing.verdict) {
    log(`challenger ${challengerId} is already decided (${existing.verdict.value} by ${existing.verdict.by}, rule ${existing.verdict.rule}); nothing runs, round ${round.id} closes`)
    const compare = latestBy(deps.ledger.comparesOf(challengerId).filter((c) => c.gate === selection.gate && c.tier === req.set && c.vs_id === championId), (c) => c.at)
    return { ...base, decided: existing.verdict, ...(compare ? { compare, shadow: selection.shadow } : {}), outcome: await closeRound(lifecycle, round.id) }
  }

  // 2. open: the diff scan runs before anything is created; a rejection is a
  // decided row, and its round is closed here so it does not stay open.
  let scope: Scope
  try {
    scope = await lifecycle.open(challengerId)
  } catch (e) {
    if (e instanceof ScopeError && e.code === 'PATCH_REJECTED') return { ...base, rejected: e.violations, outcome: await closeRound(lifecycle, round.id) }
    throw e
  }
  log(`scope ${scope.scopeId} open: harness_sha ${scope.harnessSha.slice(0, 12)} env_sha ${scope.envSha.slice(0, 12)}`)

  // 3. run: the champion first when asked for or when the ledger holds nothing
  // on these tasks, then the challenger in its scope. The executor is this
  // plugin's runSet, so the results are its rows.
  const summary = await lifecycle.run(challengerId, req.set, runOptionsOf(req, deps, runId))
  const runs = { ...(summary.champion ? { champion: summary.champion as RunResult } : {}), challenger: summary.challenger as RunResult }
  if (summary.invalid !== undefined) return { ...base, ...runs, invalid: summary.invalid, outcome: await closeRound(lifecycle, round.id) }

  // 4. judge: paired on the same tasks, the primary metric only, under the
  // round's gate with the shadows beside it; first verdict wins for these
  // coordinates.
  const before = new Set(deps.ledger.comparesOf(challengerId).map(compareKey))
  const judged = await lifecycle.judge(challengerId, req.set)
  const verdictExists = before.has(compareKey(judged))
  const compare = selection.shadow
    ? latestBy(deps.ledger.comparesOf(challengerId).filter((c) => c.shadow && c.gate === selection.gate && c.tier === req.set && c.vs_id === championId), (c) => c.at) ?? judged
    : judged
  if (selection.shadow) log(`shadow judgement by ${selection.gate}: the promotion gate is ${selection.promotionGate} and no gate_change consent names ${selection.gate}`)

  // 5. decide: a holdout promote verdict waits for its consent (`promote <id> --wait`); anything else decides the round without a candidate.
  const outcome = await lifecycle.decide(round.id)
  return { ...base, ...runs, compare, shadow: selection.shadow, outcome, ...(verdictExists ? { verdictExists } : {}) }
}

export function formatChallenge(r: ChallengeResult): string {
  const out = [`challenger ${r.challengerId}`, `champion   ${r.championId}`, `round      ${r.roundId}`]
  if (r.rejected) {
    out.push('verdict    invalid (PATCH_REJECTED before any attempt)')
    for (const v of r.rejected) out.push(`  ${v.code} ${v.where}: ${v.detail}`)
  } else if (r.decided) {
    out.push(`verdict    ${r.decided.value}  rule ${r.decided.rule}  by ${r.decided.by}  (decided before this command; nothing ran)`)
    if (r.compare) out.push(...compareLines(r.compare))
  } else if (r.invalid !== undefined) {
    out.push(`verdict    invalid  rule ${r.invalid}  (no statistic computed)`)
  } else {
    const c = r.compare!
    const shadow = r.shadow ? `  (shadow: not the promotion gate ${r.promotionGate} and no gate_change consent; the challenger's verdict is untouched)` : ''
    out.push(
      `verdict    ${c.verdict.value}  rule ${c.rule_fired}  by ${c.gate ?? c.verdict.by}${shadow}${r.verdictExists ? '  (a verdict already existed; not recorded)' : ''}`,
      ...compareLines(c),
    )
  }
  if (r.outcome) {
    out.push(r.outcome.pending
      ? `decision   pending: promote consent for ${r.outcome.candidate} (promote ${r.outcome.candidate} --wait <seconds>)`
      : `decision   round decided${r.outcome.promoted !== undefined ? `, promoted ${r.outcome.promoted}` : ''}`)
  }
  if (r.champion) out.push(`champion attempts:   ${r.champion.attemptsPath}`)
  if (r.challenger) out.push(`challenger attempts: ${r.challenger.attemptsPath}`)
  return out.join('\n')
}

function fmt(v: number): string {
  return Number.isFinite(v) ? v.toFixed(3) : String(v)
}

function compareLines(c: CompareRow): string[] {
  return [
    `compare    mean ${fmt(c.mean)}  ci [${fmt(c.ci[0])}, ${fmt(c.ci[1])}]  n_eff ${c.n_eff}  paired ${c.per_task.length}  replicates ${c.replicates ?? 'n/a'}  mde ${fmt(c.mde)}`,
    `signal     ${signalLine(c)}`,
  ]
}

/** What the comparison says short of the verdict: distance to the SESOI, whether the design could see it, the Ladder. */
function signalLine(c: CompareRow): string {
  const significant = c.ci[0] > 0 ? 'ci.lo > 0' : 'ci.lo <= 0'
  const minEffect = c.min_effect ?? 0
  const toMin = c.mean - minEffect
  const effect = minEffect > 0 ? `mean ${toMin >= 0 ? 'clears' : 'short of'} min_effect ${fmt(minEffect)} by ${fmt(Math.abs(toMin))}` : 'no min_effect declared'
  const power = c.mde <= (minEffect || Infinity) ? `powered (mde ${fmt(c.mde)})` : `underpowered (mde ${fmt(c.mde)} > min_effect ${fmt(minEffect)})`
  const ladder = c.ladder ? `ladder ${c.ladder.beat_best ? 'beats' : 'does not beat'} best-so-far (step ${fmt(c.ladder.step)})` : 'no ladder recorded'
  return `${significant}; ${effect}; ${power}; ${ladder}`
}
