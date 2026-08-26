// One round with a proposer: open the round on ctx.lifecycle (or reuse the
// one `--round` names) → render the proposer view from the ledger (the ledger
// redacts held-out rows; nothing under the pack's bin/ or held-out set is
// copied) → run the adapter → validate the Proposal (schema, held-in task
// ids, surface) → the challenge chain in that round (propose → open → run →
// judge → decide, every transition the service's). Like challenge.ts, every
// dependency comes in through `RoundDeps`.

import { cpSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import type { Ledger } from '@oldbulb/samsara-ledger'
import type { HarnessFacts } from '@oldbulb/samsara-loops'
import { loadPack, type PackDefinition } from '@oldbulb/samsara-pack'
import { policyFor } from '@oldbulb/samsara-sandbox'
import { policyPaths } from '@oldbulb/samsara-workdir'
import { HumanAdapter, PROPOSAL_DRAFT_SCHEMA, assertTaskIdsWithin, type Proposal, type ProposerAdapter } from '@oldbulb/samsara-proposers'
import { challenge, formatChallenge, gateFor, roundFor, type ChallengeDeps, type ChallengeResult, type GatePolicyName } from './challenge.ts'
import { bookOf, championProposal, selectTasks, type Loops, type RunRequest } from './run.ts'

export interface RoundRequest extends RunRequest {
  /** Adapter name on ctx.proposers; 'human' may instead take its patch from `humanSkillDir` + `intent`. */
  proposer: string
  /** Primary metric (kind reality) the gate decides on; the proposal's prediction must name it. */
  metric: string
  nEffFloor: number
  withChampion: boolean
  gatePolicy: GatePolicyName
  /** Reuse this round instead of opening one. */
  round?: string
  /** Human adapter inputs from the command line (instead of a configured proposer-human row). */
  humanSkillDir?: string
  intent?: string
}

export interface RoundDeps extends ChallengeDeps {
  ledger: ChallengeDeps['ledger'] & Pick<Ledger, 'read'>
  proposers: { get(name: string): ProposerAdapter | undefined }
}

export interface RoundResult extends ChallengeResult {
  proposal: Proposal
  viewDir: string
  proposalPath: string
}

export const VIEW_DIR = 'view'
export const PROPOSER_DIR = 'proposer'
export const VIEW_VERSION = 1
/** What the view directory holds besides `view.json` (examples/proposers/README.md); `environment.md` only when the host knows the environment. */
export const VIEW_FILES = ['champion.json', 'champion-skill', 'tasks.jsonl', 'champion-attempts.jsonl', 'champion-scores.jsonl', 'compares.jsonl', 'proposal.schema.json'] as const
export const ENVIRONMENT_FILE = 'environment.md'

/** What the proposer is told about where its patch will run: nothing here comes from the ledger. */
export interface ViewEnvironment {
  pack: { name: string; taskVersion?: number }
  loop: { name: string; facts?: HarnessFacts }
  limits: { maxTurns: number; maxMinutes: number }
  tools: { allow: string[]; deny: string[] }
}

/** The environment a run request would put an attempt in (the same values run.ts hands the loop). */
export function viewEnvironmentOf(def: PackDefinition, req: Pick<RunRequest, 'loop' | 'maxTurns' | 'maxMinutes' | 'allow'>, loops: Pick<Loops, 'get'>): ViewEnvironment {
  const facts = loops.get(req.loop)?.harnessFacts
  return {
    pack: { name: def.name, ...(def.manifest.tasks.version !== undefined ? { taskVersion: def.manifest.tasks.version } : {}) },
    loop: { name: req.loop, ...(facts ? { facts } : {}) },
    limits: { maxTurns: req.maxTurns, maxMinutes: req.maxMinutes },
    tools: { allow: req.allow ?? [], deny: def.denyPatterns },
  }
}

function listOrNone(xs: readonly string[]): string {
  return xs.length ? xs.map((x) => `\`${x}\``).join(', ') : '(none)'
}

/** `environment.md`: the loop, its harness facts, the limits and tool policy the attempts run under, and the out-directory protocol. */
export function formatEnvironment(env: ViewEnvironment): string {
  const facts = env.loop.facts
  const lines = [
    '# Environment',
    '',
    `- pack: ${env.pack.name}${env.pack.taskVersion !== undefined ? ` (tasks version ${env.pack.taskVersion})` : ''}`,
    `- loop: ${env.loop.name}${facts ? ` (adapter ${facts.version.loop}${facts.version.sdk ? `, sdk ${facts.version.sdk}` : ''})` : ''}`,
  ]
  if (facts) {
    lines.push(
      `- harness facts: system prompt mode ${facts.systemPromptMode}; skill delivery ${facts.skillDelivery}; schema enforcement ${facts.schemaEnforcement}; permission ${facts.permission}${facts.sandbox ? `; sandbox ${facts.sandbox}` : ''}`,
      `- envelope fidelity: config ${facts.envelope.config}, system ${facts.envelope.system}, tools ${facts.envelope.tools}`,
    )
    if (Object.keys(facts.reasoning).length) lines.push(`- reasoning: ${JSON.stringify(facts.reasoning)}`)
  }
  lines.push(
    `- limits: max turns ${env.limits.maxTurns}; max minutes ${env.limits.maxMinutes}`,
    `- tools allowed: ${env.tools.allow.length ? listOrNone(env.tools.allow) : '(provider default)'}`,
    `- tools denied: ${listOrNone(env.tools.deny)}`,
    '- protocol: write `proposal.json` (schema in `proposal.schema.json`) and, for the skill surface, the skill directory into the out directory; task ids named in the prediction must come from `tasks.jsonl`',
    '',
  )
  return lines.join('\n')
}

function stripRound(req: RoundRequest): RunRequest {
  const { proposer: _p, metric: _m, nEffFloor: _n, withChampion: _w, gatePolicy: _g, round: _r, humanSkillDir: _h, intent: _i, ...run } = req
  return run
}

function jsonl(rows: unknown[]): string {
  return rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '')
}

/**
 * Render what `ledger.read(view, 'proposer')` allows into `dir`: the champion
 * skill, the tasks of the requested (non-held-out) set, the champion's
 * attempts and scores (held-out ones as aggregates), and the compare rows the
 * champion is a side of (held-out ones as the ledger's aggregates; no other
 * lineage's rows) — plus the manifest `view.json`, the proposal schema and,
 * when the host knows it, `environment.md`.
 */
export function renderView(dir: string, input: {
  championId: string
  championSkillDir: string
  metric: string
  tasks: readonly unknown[]
  ledger: Pick<Ledger, 'read'>
  environment?: ViewEnvironment
}): void {
  mkdirSync(dir, { recursive: true })
  cpSync(input.championSkillDir, resolve(dir, 'champion-skill'), { recursive: true })
  const attempts = input.ledger.read('attempts', 'proposer').filter((a) => a.challenger_id === input.championId)
  const attemptIds = new Set(attempts.map((a) => ('redacted' in a ? '' : a.id)))
  const scores = input.ledger.read('scores', 'proposer').filter((s) => ('redacted' in s ? s.challenger_id === input.championId : attemptIds.has(s.attempt_id)))
  const compares = input.ledger.read('compares', 'proposer').filter((c) => c.challenger_id === input.championId || c.vs_id === input.championId)
  writeFileSync(resolve(dir, 'champion.json'), JSON.stringify({ challenger_id: input.championId, skill: 'champion-skill/', metric: input.metric }, null, 2) + '\n')
  writeFileSync(resolve(dir, 'tasks.jsonl'), jsonl([...input.tasks]))
  writeFileSync(resolve(dir, 'champion-attempts.jsonl'), jsonl(attempts))
  writeFileSync(resolve(dir, 'champion-scores.jsonl'), jsonl(scores))
  writeFileSync(resolve(dir, 'compares.jsonl'), jsonl(compares))
  writeFileSync(resolve(dir, 'proposal.schema.json'), JSON.stringify(PROPOSAL_DRAFT_SCHEMA, null, 2) + '\n')
  const files: string[] = [...VIEW_FILES]
  if (input.environment) {
    writeFileSync(resolve(dir, ENVIRONMENT_FILE), formatEnvironment(input.environment))
    files.push(ENVIRONMENT_FILE)
  }
  writeFileSync(resolve(dir, 'view.json'), JSON.stringify({ view_version: VIEW_VERSION, champion_id: input.championId, metric: input.metric, files }, null, 2) + '\n')
}

/** The registered adapter named by the request; 'human' with --skill-dir/--intent builds one from the command line. */
export function adapterOf(req: Pick<RoundRequest, 'proposer' | 'metric' | 'humanSkillDir' | 'intent'>, deps: Pick<RoundDeps, 'proposers'>): ProposerAdapter {
  if (req.proposer === 'human' && req.humanSkillDir !== undefined) {
    if (req.intent === undefined) throw new Error('round: --intent is required with --skill-dir')
    return new HumanAdapter({ skillDir: resolve(req.humanSkillDir), intent: req.intent, prediction: { metric: req.metric, direction: 'up' } })
  }
  const adapter = deps.proposers.get(req.proposer)
  if (!adapter) throw new Error(`no proposer named "${req.proposer}" is registered (is its plugin enabled in the profile?)`)
  return adapter
}

/** A Proposal on the one v1 surface. */
export type SkillProposal = Proposal & { patch: { surface: 'skill'; skill_dir: string } }

/** What the host checks on a Proposal before it costs anything: held-in task ids only, the v1 surface, the metric the round judges. */
export function checkProposal(proposal: Proposal, heldIn: readonly string[], metric: string): asserts proposal is SkillProposal {
  assertTaskIdsWithin(proposal, heldIn)
  if (proposal.patch.surface !== 'skill') throw new Error(`round: surface "${proposal.surface}" is not a v1 challenger surface (only skill)`)
  if (proposal.prediction.metric !== metric) {
    throw new Error(`round: the proposal predicts metric "${proposal.prediction.metric}" but the round judges "${metric}"`)
  }
}

export async function round(req: RoundRequest, deps: RoundDeps): Promise<RoundResult> {
  if (req.set === 'holdout') throw new Error('round: the proposer view cannot be rendered from the held-out set (use smoke or holdin)')
  const def = loadPack(req.pack)
  const book = bookOf(def)
  const runReq = stripRound(req)
  const tasks = selectTasks(book, req)
  const heldIn = [...book.tasks('smoke'), ...book.tasks('holdin')].map((t) => t.task_id)
  const log = deps.log ?? (() => {})

  // 1. the round: the champion row for these coordinates is the parent; its skill is what the proposer improves.
  const champion = championProposal(def, book, runReq, deps)
  const round = await roundFor(req, champion, gateFor(req.gatePolicy, deps), deps)
  const championId = round.champion_id
  const championSkillDir = runReq.skillDir ?? deps.championSkillDir ?? def.skillDir

  // 2. the view: rendered by the host from the ledger's proposer reads, never by the adapter.
  const viewDir = resolve(req.out, VIEW_DIR)
  renderView(viewDir, { championId, championSkillDir, metric: req.metric, tasks, ledger: deps.ledger, environment: viewEnvironmentOf(def, runReq, deps.loops) })
  log(`view rendered at ${viewDir} (${tasks.length} ${req.set} tasks, champion ${championId})`)

  // 3. the proposer.
  const adapter = adapterOf(req, deps)
  const workDir = resolve(req.out, PROPOSER_DIR)
  mkdirSync(workDir, { recursive: true })
  // E9: the proposer reads its rendered view, the pack's skill/ and loader/ and the runtimes; writes only its work directory.
  const sandbox = policyFor({ ...policyPaths(workDir, def), readOnly: [viewDir], homeDir: homedir() })
  const proposal = await adapter.propose({ viewDir, workDir, signal: deps.signal ?? new AbortController().signal, parent: championId, sandbox })
  checkProposal(proposal, heldIn, req.metric)
  const proposalPath = resolve(req.out, 'proposal.json')
  writeFileSync(proposalPath, JSON.stringify(proposal, null, 2) + '\n')
  log(`proposal by ${proposal.proposer.name}@${proposal.proposer.version}: ${proposal.intent}`)

  // 4. the challenge chain in this round: propose → open → run → judge → decide.
  const result = await challenge({
    ...runReq,
    surface: 'skill',
    skillDir: proposal.patch.skill_dir,
    intent: proposal.intent,
    metric: req.metric,
    nEffFloor: req.nEffFloor,
    withChampion: req.withChampion,
    gatePolicy: req.gatePolicy,
    round: round.id,
    prediction: proposal.prediction,
    optimizerConfigSha: proposal.proposer.config_sha,
  }, deps)
  return { ...result, proposal, viewDir, proposalPath }
}

export function formatRound(r: RoundResult): string {
  return [
    `proposer   ${r.proposal.proposer.name}@${r.proposal.proposer.version} config ${r.proposal.proposer.config_sha.slice(0, 12)}`,
    `view       ${r.viewDir}`,
    `proposal   ${r.proposalPath}`,
    formatChallenge(r),
  ].join('\n')
}
