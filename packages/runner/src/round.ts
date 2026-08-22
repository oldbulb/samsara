// One round with a proposer: render the proposer view from the ledger (the
// ledger redacts held-out rows; nothing under the pack's bin/ or held-out set
// is copied) → run the adapter → validate the Proposal (schema, held-in task
// ids, surface) → the existing challenge chain (diff scan → scope → attempts
// → gate → compare row). Like challenge.ts, every dependency comes in through
// `RoundDeps`.

import { cpSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { CompareRow, Ledger } from '@samsara/ledger'
import { loadPack } from '@samsara/pack'
import { HumanAdapter, assertTaskIdsWithin, type Proposal, type ProposerAdapter } from '@samsara/proposers'
import { challenge, formatChallenge, type ChallengeDeps, type ChallengeResult, type GatePolicyName } from './challenge.ts'
import { bookOf, championProposal, type RunRequest } from './run.ts'

export interface RoundRequest extends RunRequest {
  /** Adapter name on ctx.proposers; 'human' may instead take its patch from `humanSkillDir` + `intent`. */
  proposer: string
  /** Primary metric (kind reality) the gate decides on; the proposal's prediction must name it. */
  metric: string
  nEffFloor: number
  withChampion: boolean
  gatePolicy: GatePolicyName
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

function stripRound(req: RoundRequest): RunRequest {
  const { proposer: _p, metric: _m, nEffFloor: _n, withChampion: _w, gatePolicy: _g, humanSkillDir: _h, intent: _i, ...run } = req
  return run
}

function jsonl(rows: unknown[]): string {
  return rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '')
}

/** A compare row as the proposer may see it: held-out per-task deltas collapse to their count. */
function redactCompare(c: CompareRow): CompareRow | (Omit<CompareRow, 'per_task'> & { per_task: []; per_task_n: number }) {
  if (c.tier !== 'holdout') return c
  const { per_task, ...rest } = c
  return { ...rest, per_task: [], per_task_n: per_task.length }
}

/**
 * Render what `ledger.read(view, 'proposer')` allows into `dir`: the champion
 * skill, the tasks of the requested (non-held-out) set, the champion's
 * attempts and scores (held-out ones as aggregates), and compare rows with
 * held-out per-task deltas removed.
 */
export function renderView(dir: string, input: {
  championId: string
  championSkillDir: string
  metric: string
  tasks: readonly unknown[]
  ledger: Pick<Ledger, 'read'>
}): void {
  mkdirSync(dir, { recursive: true })
  cpSync(input.championSkillDir, resolve(dir, 'champion-skill'), { recursive: true })
  const attempts = input.ledger.read('attempts', 'proposer').filter((a) => a.challenger_id === input.championId)
  const attemptIds = new Set(attempts.map((a) => ('redacted' in a ? '' : a.id)))
  const scores = input.ledger.read('scores', 'proposer').filter((s) => ('redacted' in s ? s.challenger_id === input.championId : attemptIds.has(s.attempt_id)))
  const compares = input.ledger.read('compares', 'proposer').map(redactCompare)
  writeFileSync(resolve(dir, 'champion.json'), JSON.stringify({ challenger_id: input.championId, skill: 'champion-skill/', metric: input.metric }, null, 2) + '\n')
  writeFileSync(resolve(dir, 'tasks.jsonl'), jsonl([...input.tasks]))
  writeFileSync(resolve(dir, 'champion-attempts.jsonl'), jsonl(attempts))
  writeFileSync(resolve(dir, 'champion-scores.jsonl'), jsonl(scores))
  writeFileSync(resolve(dir, 'compares.jsonl'), jsonl(compares))
}

function adapterOf(req: RoundRequest, deps: RoundDeps): ProposerAdapter {
  if (req.proposer === 'human' && req.humanSkillDir !== undefined) {
    if (req.intent === undefined) throw new Error('round: --intent is required with --skill-dir')
    return new HumanAdapter({ skillDir: resolve(req.humanSkillDir), intent: req.intent, prediction: { metric: req.metric, direction: 'up' } })
  }
  const adapter = deps.proposers.get(req.proposer)
  if (!adapter) throw new Error(`no proposer named "${req.proposer}" is registered (is its plugin enabled in the profile?)`)
  return adapter
}

export async function round(req: RoundRequest, deps: RoundDeps): Promise<RoundResult> {
  if (req.set === 'holdout') throw new Error('round: the proposer view cannot be rendered from the held-out set (use smoke or holdin)')
  const def = loadPack(req.pack)
  const book = bookOf(def)
  const runReq = stripRound(req)
  const tasks = book.tasks(req.set).slice(0, req.limit ?? undefined)
  const heldIn = [...book.tasks('smoke'), ...book.tasks('holdin')].map((t) => t.task_id)
  const log = deps.log ?? (() => {})

  // 1. the champion row for these coordinates is the parent; its skill is what the proposer improves.
  const champion = championProposal(def, book, runReq, deps)
  const championId = await deps.ledger.propose(champion)
  const championSkillDir = runReq.skillDir ?? deps.championSkillDir ?? def.skillDir

  // 2. the view: rendered by the host from the ledger's proposer reads, never by the adapter.
  const viewDir = resolve(req.out, VIEW_DIR)
  renderView(viewDir, { championId, championSkillDir, metric: req.metric, tasks, ledger: deps.ledger })
  log(`view rendered at ${viewDir} (${tasks.length} ${req.set} tasks, champion ${championId})`)

  // 3. the proposer.
  const adapter = adapterOf(req, deps)
  const workDir = resolve(req.out, PROPOSER_DIR)
  mkdirSync(workDir, { recursive: true })
  const proposal = await adapter.propose({ viewDir, workDir, signal: deps.signal ?? new AbortController().signal, parent: championId })
  assertTaskIdsWithin(proposal, heldIn)
  if (proposal.patch.surface !== 'skill') throw new Error(`round: surface "${proposal.surface}" is not a v1 challenger surface (only skill)`)
  if (proposal.prediction.metric !== req.metric) {
    throw new Error(`round: the proposal predicts metric "${proposal.prediction.metric}" but the round judges "${req.metric}"`)
  }
  const proposalPath = resolve(req.out, 'proposal.json')
  writeFileSync(proposalPath, JSON.stringify(proposal, null, 2) + '\n')
  log(`proposal by ${proposal.proposer.name}@${proposal.proposer.version}: ${proposal.intent}`)

  // 4. the challenge chain: diff scan → scope → attempts → gate → compare row.
  const result = await challenge({
    ...runReq,
    surface: 'skill',
    skillDir: proposal.patch.skill_dir,
    intent: proposal.intent,
    metric: req.metric,
    nEffFloor: req.nEffFloor,
    withChampion: req.withChampion,
    gatePolicy: req.gatePolicy,
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
