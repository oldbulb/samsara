// `import harbor <jobDir>`: a Harbor job's trials into the ledger (design note
// environments-harbor-modal § 3) — as the champion row of the job's
// agent/model, as a challenger judged against that champion by the gate, or
// as a noise floor. Nothing runs: the trials are evidence produced outside
// samsara, and the ledger's rows are the framework's reading of them. Every
// transition is the service's: a challenger goes through openRound → propose
// → open → run → judge → decide exactly as `challenge` does, with the executor
// the lifecycle runs attempts through replaced by `HarborReplay`, which
// records the imported rows for the row it is asked to run and starts nothing.

import { mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Book, TaskSet } from '@oldbulb/samsara-book'
import { sd } from '@oldbulb/samsara-gate'
import { comparable, evalConfigShaOf, type Executor, type Lifecycle, type RunDeps, type RunRequest, type RunResult as ExecutorResult } from '@oldbulb/samsara-lifecycle'
import type { ChallengerProposal, ChallengerRow, Ledger, NoiseFloorRow } from '@oldbulb/samsara-ledger'
import { loadPack } from '@oldbulb/samsara-pack'
import { formatCalibrate } from './calibrate.ts'
import { formatChallenge, type ChallengeResult } from './challenge.ts'
import { harborAttempts, harborChallenger, harborChampion, harborLoop, harborResultRows, harborRoute, harborTasks, harborTrialsPerTask, readHarborJob, snapshotHarborSkills, type HarborJob, type HarborRows } from './harbor.ts'
import { bookOf, type RunResult } from './run.ts'

export type ImportAs = 'champion' | 'challenger' | 'noise-floor'
export const IMPORT_AS: readonly ImportAs[] = ['champion', 'challenger', 'noise-floor']

export interface ImportHarborRequest {
  /** The Harbor job directory: one trial directory per attempt. */
  jobDir: string
  pack: string
  as: ImportAs
  /** Primary metric (kind reality): `reward`, or a key of reward.json. */
  metric: string
  /** The task set the job's trials land on: every task of the set must be run (or some of them, with `allowSubset`); trials on other tasks are skipped. */
  set: TaskSet
  /** challenger: what the job changed. */
  intent?: string
  allowSubset: boolean
  /** challenger: the champion row to judge against; default the latest champion on the ledger with the job's coordinates. */
  champion?: string
  nEffFloor: number
  out: string
}

export type ImportLedger = Pick<Ledger, 'propose' | 'challenger' | 'recordAttempt' | 'appendScores' | 'recordNoiseFloor' | 'read'>
export type ImportLifecycle = Pick<Lifecycle, 'openRound' | 'closeRound' | 'propose' | 'open' | 'run' | 'judge' | 'decide'>

export interface ImportHarborDeps {
  ledger: ImportLedger
  lifecycle: ImportLifecycle
  /** The executor mounted on ctx.executor for this command (the lifecycle runs the imported challenger through it). */
  replay: HarborReplay
  log?: (line: string) => void
}

export interface ImportHarborResult {
  as: ImportAs
  /** `trials` / `tasks`: the ones on the set; `skipped`: the subdirectories not imported (no result.json, or a trial on a task outside the set). */
  job: { id: string; dir: string; loop: string; trials: number; tasks: string[]; skipped: string[] }
  tier: TaskSet
  championId: string
  /** Attempt rows recorded. */
  attempts: number
  /** Score rows recorded. */
  scores: number
  /** challenger: the chain's result as `challenge` reports it. */
  challenge?: ChallengeResult
  /** challenger: the job's declared skill sources not on this machine — no snapshot, so the row cannot be promoted (E7) and the round closes without a decision. */
  missingSkills?: string[]
  /** noise-floor: the row. */
  floor?: NoiseFloorRow
}

async function recordRows(ledger: Pick<Ledger, 'recordAttempt' | 'appendScores'>, rows: HarborRows): Promise<void> {
  for (const a of rows.attempts) await ledger.recordAttempt(a)
  await ledger.appendScores(rows.scores)
}

/**
 * The executor an import mounts as ctx.executor in place of runSet: asked to
 * run a challenger it holds imported rows for, it records them on the tier
 * and returns them; asked for any other row (the champion, when the ledger
 * lacks a pair) it records nothing and returns no rows — the evidence is what
 * the ledger holds, and the run invariant says the rest.
 */
export class HarborReplay implements Executor {
  private readonly held = new Map<string, { rows: HarborRows; dir: string }>()

  add(challengerId: string, rows: HarborRows, dir: string): void {
    this.held.set(challengerId, { rows, dir })
  }

  async runSet(req: RunRequest, deps: RunDeps): Promise<ExecutorResult> {
    const def = loadPack(req.pack)
    const base = {
      runId: deps.runId ?? 'import-harbor', pack: def.name, set: req.set, tasksetSha: bookOf(def).tasksetSha(req.set),
      ...(deps.challengerId !== undefined ? { challengerId: deps.challengerId } : {}),
    }
    const held = deps.challengerId !== undefined ? this.held.get(deps.challengerId) : undefined
    if (!held) {
      deps.log?.(`import harbor: nothing imported for ${deps.challengerId ?? 'the champion'}; nothing runs and nothing is recorded`)
      return { ...base, rows: [], attemptsPath: '' }
    }
    const rows: HarborRows = { attempts: held.rows.attempts.map((a) => ({ ...a, tier: req.set })), scores: held.rows.scores }
    if (deps.ledger) await recordRows(deps.ledger, rows)
    return { ...base, rows: harborResultRows(rows), attemptsPath: held.dir }
  }
}

/**
 * The job's trials on the set's tasks: a trial on a task the set lacks is
 * skipped (a job over a whole dataset imports into each set the pack split
 * it into); the set's tasks must all be run, or some of them with
 * `allowSubset`.
 */
function trialsInSet(job: HarborJob, book: Book, set: TaskSet, allowSubset: boolean): HarborJob {
  const setIds = book.tasks(set).map((t) => t.task_id)
  const outside = job.trials.filter((t) => !setIds.includes(t.result.task_name))
  const kept = { ...job, trials: job.trials.filter((t) => setIds.includes(t.result.task_name)), skipped: [...job.skipped, ...outside.map((t) => t.name)].sort() }
  if (kept.trials.length === 0) throw new Error(`job ${job.id} ran none of the pack's ${set} tasks (it ran ${harborTasks(job).join(', ')})`)
  const jobIds = harborTasks(kept)
  const missing = setIds.filter((id) => !jobIds.includes(id))
  if (missing.length > 0 && !allowSubset) {
    throw new Error(`job ${job.id} ran ${jobIds.length} of the ${setIds.length} ${set} tasks (missing ${missing.join(', ')}); pass --allow-subset to import it anyway`)
  }
  return kept
}

function proposalOf(row: ChallengerRow): ChallengerProposal {
  const { id: _id, status: _s, proposed_at: _p, eval_config_sha: _e, opened: _o, tier_reached: _t, verdict: _v, ...proposal } = row
  return proposal
}

/** The champion the job is judged against: `--champion`, else the latest champion row on the ledger with the job's coordinates (rule 0). */
function championOf(req: ImportHarborRequest, own: ChallengerProposal, ledger: ImportLedger): ChallengerRow {
  if (req.champion !== undefined) {
    const row = ledger.challenger(req.champion)
    if (!row) throw new Error(`no challenger ${req.champion} on the ledger`)
    return row
  }
  const probe = { ...own, id: '', status: 'proposed', proposed_at: '', pack: own.pack ?? '' } as ChallengerRow
  const found = ledger.read('challengers', 'gate')
    .filter((r) => r.parent_ids.length === 0 && comparable(probe, r).ok)
    .sort((a, b) => (a.proposed_at < b.proposed_at ? 1 : a.proposed_at > b.proposed_at ? -1 : 0))[0]
  if (!found) throw new Error(`no champion on the ledger with this job's coordinates (${own.route.loop} on ${own.pack} ${req.set}); import the champion job first (--as champion), or name one with --champion <id>`)
  return found
}

/** The floor the way `lifecycle.calibrate` measures it: per entity, the mean over its tasks per rerun (sample); the paired difference between every two reruns is one sample of the floor. */
function noiseFloorOf(rows: HarborRows, entityOf: ReadonlyMap<string, string>, metric: string): { sd_paired: number; n_tasks: number } {
  const valueOf = new Map(rows.scores.filter((s) => s.metric === metric).map((s) => [s.attempt_id, s.value]))
  const byEntity = new Map<string, Map<number, number[]>>()
  const tasksSeen = new Set<string>()
  for (const a of rows.attempts) {
    const value = valueOf.get(a.id)
    if (value === undefined) continue
    tasksSeen.add(a.task_id)
    const entity = entityOf.get(a.task_id) ?? a.task_id
    const samples = byEntity.get(entity) ?? new Map<number, number[]>()
    samples.set(a.sample, [...(samples.get(a.sample) ?? []), value])
    byEntity.set(entity, samples)
  }
  const diffs: number[] = []
  for (const samples of byEntity.values()) {
    const means = [...samples.entries()].sort((a, b) => a[0] - b[0]).map(([, xs]) => xs.reduce((s, x) => s + x, 0) / xs.length)
    for (let i = 0; i < means.length; i++) for (let j = i + 1; j < means.length; j++) diffs.push(means[j]! - means[i]!)
  }
  return { sd_paired: sd(diffs), n_tasks: tasksSeen.size }
}

export async function importHarbor(req: ImportHarborRequest, deps: ImportHarborDeps): Promise<ImportHarborResult> {
  const def = loadPack(req.pack)
  const book = bookOf(def)
  const log = deps.log ?? (() => {})
  const { lifecycle, ledger } = deps
  const whole = readHarborJob(req.jobDir)
  const job = trialsInSet(whole, book, req.set, req.allowSubset)
  const own = harborChampion(job, def, book, { set: req.set, metric: req.metric })
  const base = { as: req.as, job: { id: job.id, dir: job.dir, loop: harborLoop(job.agent), trials: job.trials.length, tasks: harborTasks(job), skipped: job.skipped }, tier: req.set }
  log(`job ${job.id}: ${job.trials.length} trial(s) on ${base.job.tasks.length} task(s) by ${base.job.loop} in ${job.environment}${job.skipped.length ? `; skipped ${job.skipped.join(', ')}` : ''}`)
  if (whole.trials.length > job.trials.length) log(`${whole.trials.length - job.trials.length} trial(s) on tasks outside the ${req.set} set skipped`)

  if (req.as === 'challenger') {
    // The champion of the job's coordinates; the round is opened on it (its row proposed idempotently).
    const championRow = championOf(req, own, ledger)
    const round = await lifecycle.openRound({ pack: req.pack, champion: proposalOf(championRow), metric: req.metric, nEffFloor: req.nEffFloor })
    const out = resolve(req.out, `harbor-${job.id}`)
    // The scope opens on a snapshot of the job's declared skills under --out; when a source is not on this machine, on an
    // empty directory (the skill coordinate stays the declared sources) and the row is never promoted.
    const skillDir = resolve(out, 'skill')
    rmSync(skillDir, { recursive: true, force: true })
    mkdirSync(skillDir, { recursive: true })
    const snapshot = snapshotHarborSkills(job, skillDir)
    const missingSkills = 'missing' in snapshot ? snapshot.missing : undefined
    if (missingSkills) log(`skill sources ${missingSkills.join(', ')} are not on this machine: no snapshot, the challenger cannot be promoted`)
    const proposal = harborChallenger(job, def, book, round.champion_id, championRow.patch.skill_ref ?? '', {
      set: req.set, metric: req.metric, intent: req.intent ?? `harbor job ${job.id}`, skillDir, ...('sha' in snapshot ? { skillSha: snapshot.sha } : {}),
    })
    const { id } = await lifecycle.propose(proposal, { roundId: round.id })
    const rows = harborAttempts(job, { challengerId: id, tier: req.set, scorerVersion: own.scorer_version })
    deps.replay.add(id, rows, job.dir)
    log(`challenger ${id} (parent champion ${round.champion_id}); round ${round.id}`)
    const result: ChallengeResult = { challengerId: id, championId: round.champion_id, roundId: round.id }
    await lifecycle.open(id)
    // Every trial of a task is one sample; the champion must hold a pair for each (the run invariant says so otherwise).
    const repeat = Math.max(...harborTrialsPerTask(job).values())
    const summary = await lifecycle.run(id, req.set, { repeat, out, maxTurns: 0, maxMinutes: 0, route: harborRoute(job), withChampion: false, log })
    result.challenger = summary.challenger as RunResult
    const counted = { attempts: rows.attempts.length, scores: rows.scores.length }
    if (summary.invalid !== undefined) {
      log(`challenger ${id} is invalid on ${summary.invalid}: the champion ${round.champion_id} holds no attempt under the same facts on every (task, sample) the job ran; import a champion job of the same agent with as many trials per task`)
      const closed = await lifecycle.closeRound(round.id)
      result.invalid = summary.invalid
      result.outcome = { roundId: round.id, superseded: closed.outcome?.superseded ?? [] }
      return { ...base, championId: round.champion_id, ...counted, challenge: result }
    }
    result.compare = await lifecycle.judge(id, req.set)
    if (missingSkills) {
      // E7: nothing to hot-apply, so the round closes without a decision (the verdict stays on the row).
      const closed = await lifecycle.closeRound(round.id)
      result.outcome = { roundId: round.id, superseded: closed.outcome?.superseded ?? [] }
      return { ...base, championId: round.champion_id, ...counted, challenge: result, missingSkills }
    }
    result.outcome = await lifecycle.decide(round.id)
    return { ...base, championId: round.champion_id, ...counted, challenge: result }
  }

  // champion / noise-floor: the champion row of the job (idempotent), its trials as attempts under it.
  const championId = await ledger.propose(own)
  const rows = harborAttempts(job, { challengerId: championId, tier: req.set, scorerVersion: own.scorer_version })
  await recordRows(ledger, rows)
  const counted = { championId, attempts: rows.attempts.length, scores: rows.scores.length }
  if (req.as === 'champion') return { ...base, ...counted }

  const reruns = Math.min(...harborTrialsPerTask(job).values())
  if (!(reruns >= 3)) throw new Error(`a noise floor needs at least 3 trials per task (S1); job ${job.id} has ${reruns}`)
  const row = ledger.challenger(championId)
  if (!row) throw new Error(`champion ${championId} was proposed but is not on the ledger`)
  const entityOf = new Map(book.tasks(req.set).map((t) => [t.task_id, t.entity_key]))
  const { sd_paired, n_tasks } = noiseFloorOf(rows, entityOf, req.metric)
  const floor = {
    eval_config_sha: evalConfigShaOf(row), champion_id: championId, loop: own.route.loop, metric: req.metric, measured_at: new Date().toISOString(),
    unit: 'entity' as const, sd_paired, n_reruns: reruns, n_tasks, tier: req.set,
  }
  const id = await ledger.recordNoiseFloor(floor)
  return { ...base, ...counted, floor: { id, ...floor } }
}

export function formatImportHarbor(r: ImportHarborResult): string {
  const out = [
    `import harbor ${r.job.id}  as ${r.as}`,
    `job        ${r.job.dir}`,
    `           ${r.job.trials} trial(s) on ${r.job.tasks.length} task(s) via ${r.job.loop}${r.job.skipped.length ? `; skipped ${r.job.skipped.join(', ')}` : ''}`,
    `recorded   ${r.attempts} attempt(s), ${r.scores} score row(s) on tier ${r.tier} under ${r.challenge?.challengerId ?? r.championId}`,
  ]
  if (r.challenge) out.push(formatChallenge(r.challenge))
  else out.push(`champion   ${r.championId}`)
  if (r.missingSkills) out.push(`skills     ${r.missingSkills.join(', ')} not on this machine: no snapshot, so the challenger cannot be promoted (round closed without a decision)`)
  if (r.floor) out.push(formatCalibrate(r.floor))
  return out.join('\n')
}
