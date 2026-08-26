// Harbor job directories as ledger rows, pure: `readHarborJob` walks
// `<job>/<trial>/` (config.json + result.json, the reward file when the result
// carries none) into a typed job, `harborAttempts` maps its trials to attempt
// and score rows, `harborChampion` / `harborChallenger` name the job's
// agent/model as the route of a challenger row (design note
// environments-harbor-modal § 3 and its appendix). Harbor is never imported:
// the on-disk JSON is the contract, read tolerantly (unknown fields ignored,
// optional ones may be absent or null, as Pydantic writes them).

import { cpSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import type { Book, TaskSet } from '@oldbulb/samsara-book'
import { z } from '@oldbulb/samsara-kernel'
import { canonicalJson, sha256, type AttemptRow, type ChallengerProposal, type ScoreRow, type Tier } from '@oldbulb/samsara-ledger'
import type { PackDefinition } from '@oldbulb/samsara-pack'
import type { RunResultRow } from '@oldbulb/samsara-lifecycle'
import { hashDir } from '@oldbulb/samsara-workdir'

// ------------------------------------------------------------------ contract

const timing = z.object({ started_at: z.string().nullish(), finished_at: z.string().nullish() })
/** harbor.models.agent.context.AgentContext: `n_input_tokens` includes the cache tokens. */
const agentContext = z.object({
  n_input_tokens: z.number().nullish(),
  n_cache_tokens: z.number().nullish(),
  n_output_tokens: z.number().nullish(),
  cost_usd: z.number().nullish(),
})
const verifierResult = z.object({ rewards: z.record(z.string(), z.number()).nullish() })
const exceptionInfo = z.object({
  exception_type: z.string(),
  exception_message: z.string(),
  exception_traceback: z.string().nullish(),
  occurred_at: z.string().nullish(),
})
const modelInfo = z.object({ name: z.string(), provider: z.string().nullish() })
const agentInfo = z.object({ name: z.string(), version: z.string(), model_info: modelInfo.nullish() })

/** harbor.models.trial.config.TrialConfig: the fields the mapping reads; config.json is written with defaults excluded. */
export const trialConfigSchema = z.object({
  task: z.object({
    path: z.string().nullish(),
    git_url: z.string().nullish(),
    git_commit_id: z.string().nullish(),
    name: z.string().nullish(),
    source: z.string().nullish(),
  }).optional(),
  trial_name: z.string().optional(),
  job_id: z.string().nullish(),
  agent: z.object({
    name: z.string().nullish(),
    import_path: z.string().nullish(),
    model_name: z.string().nullish(),
    kwargs: z.record(z.string(), z.unknown()).optional(),
    skills: z.array(z.string()).optional(),
    override_timeout_sec: z.number().nullish(),
  }).optional(),
  environment: z.object({
    type: z.string().nullish(),
    kwargs: z.record(z.string(), z.unknown()).optional(),
    override_cpus: z.number().nullish(),
    override_memory_mb: z.number().nullish(),
  }).optional(),
  timeout_multiplier: z.number().optional(),
  agent_timeout_multiplier: z.number().nullish(),
})

/** harbor.models.trial.result.TrialResult as result.json holds it (every field written, None as null). */
export const trialResultSchema = z.object({
  id: z.string(),
  task_name: z.string(),
  trial_name: z.string(),
  trial_uri: z.string().optional(),
  source: z.string().nullish(),
  task_checksum: z.string(),
  config: trialConfigSchema.optional(),
  agent_info: agentInfo,
  agent_result: agentContext.nullish(),
  verifier_result: verifierResult.nullish(),
  verifier_environment_mode: z.string().nullish(),
  exception_info: exceptionInfo.nullish(),
  started_at: z.string().nullish(),
  finished_at: z.string().nullish(),
  environment_setup: timing.nullish(),
  agent_setup: timing.nullish(),
  agent_execution: timing.nullish(),
  verifier: timing.nullish(),
  /** Multi-step trials: one agent context / verifier result per step, none at the trial level. */
  step_results: z.array(z.object({
    step_name: z.string(),
    agent_result: agentContext.nullish(),
    verifier_result: verifierResult.nullish(),
    exception_info: exceptionInfo.nullish(),
  })).nullish(),
})

export type TrialConfig = z.infer<typeof trialConfigSchema>
export type TrialResult = z.infer<typeof trialResultSchema>
export type HarborAgentInfo = z.infer<typeof agentInfo>

/** Where a trial's reward came from: the result, a reward file the result did not carry, or nowhere (no verifier ran). */
export type RewardSource = 'result' | 'reward.json' | 'reward.txt' | 'none'

export interface HarborTrial {
  /** The trial directory. */
  dir: string
  /** Its name (the directory's, which Harbor sets to `<task>__<id>`). */
  name: string
  result: TrialResult
  /** The trial's config: the one embedded in result.json, else config.json. */
  config: TrialConfig
  /** One entry per reward key (`reward` from reward.txt; the keys of reward.json); absent when the trial has none. */
  rewards?: Record<string, number>
  rewardSource: RewardSource
  /** The trial's index among the trials of the same task, in creation order: the attempt's `sample`. */
  sample: number
}

export interface HarborJob {
  dir: string
  /** `config.job_id` of the trials, else the directory name. */
  id: string
  /** Trials in creation order (started_at, then name). */
  trials: HarborTrial[]
  /** The one agent the job ran (every trial that got past agent setup must agree). */
  agent: HarborAgentInfo
  /** The environment type the job ran in (`docker` when the config names none, Harbor's default). */
  environment: string
  /** Subdirectories with no result.json: not trials (or trials that never finished). */
  skipped: string[]
}

const DEFAULT_ENVIRONMENT = 'docker'
const NONE_SHA = sha256('')
/** Harbor's `AgentInfo.version` until an installed agent's setup ran its version command. */
const UNKNOWN_VERSION = 'unknown'
/** The file that makes a directory one skill, as Harbor resolves skill sources. */
const SKILL_FILE = 'SKILL.md'

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    throw new Error(`${file}: ${(e as Error).message}`)
  }
}

/** The reward Harbor's verifier parsed, as it does: reward.json (a flat object of numbers) before reward.txt (one float). */
function readRewardFile(dir: string): { rewards: Record<string, number>; source: RewardSource } | undefined {
  const json = resolve(dir, 'verifier', 'reward.json')
  if (existsSync(json)) {
    const parsed = readJson(json)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error(`${json}: not an object of rewards`)
    const rewards: Record<string, number> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${json}: reward ${key} is not a number`)
      rewards[key] = value
    }
    return { rewards, source: 'reward.json' }
  }
  const text = resolve(dir, 'verifier', 'reward.txt')
  if (existsSync(text)) {
    const raw = readFileSync(text, 'utf8').trim()
    const value = Number(raw)
    if (raw === '' || !Number.isFinite(value)) throw new Error(`${text}: not a float (${JSON.stringify(raw)})`)
    return { rewards: { reward: value }, source: 'reward.txt' }
  }
  return undefined
}

function readTrial(dir: string): Omit<HarborTrial, 'sample'> {
  const result = trialResultSchema.parse(readJson(resolve(dir, 'result.json')))
  const configFile = resolve(dir, 'config.json')
  const config = result.config ?? (existsSync(configFile) ? trialConfigSchema.parse(readJson(configFile)) : {})
  const rewards = result.verifier_result?.rewards
  const fromResult = rewards && Object.keys(rewards).length > 0 ? { rewards, source: 'result' as const } : readRewardFile(dir)
  return {
    dir, name: basename(dir), result, config,
    ...(fromResult ? { rewards: fromResult.rewards, rewardSource: fromResult.source } : { rewardSource: 'none' }),
  }
}

function sameAgent(a: HarborAgentInfo, b: HarborAgentInfo): boolean {
  return canonicalJson(a) === canonicalJson(b)
}

/** A trial that raised before its agent's setup finished: Harbor wrote the agent info before setup, with the version still unknown. */
function failedBeforeSetup(t: Omit<HarborTrial, 'sample'>): boolean {
  return t.result.exception_info != null && t.result.agent_info.version === UNKNOWN_VERSION
}

/**
 * Walk `<job>/<trial>/` and read every trial; a job is one agent in one
 * environment type, so trials that disagree refuse the job. The agent is the
 * one the trials past setup report; a trial that raised before setup carries
 * the version `unknown` and inherits it.
 */
export function readHarborJob(dir: string): HarborJob {
  const root = resolve(dir)
  if (!existsSync(root)) throw new Error(`no Harbor job directory at ${root}`)
  const read: Omit<HarborTrial, 'sample'>[] = []
  const skipped: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const trialDir = resolve(root, entry.name)
    if (!existsSync(resolve(trialDir, 'result.json'))) {
      skipped.push(entry.name)
      continue
    }
    read.push(readTrial(trialDir))
  }
  if (read.length === 0) throw new Error(`${root} holds no trial (no <trial>/result.json)`)
  const key = (t: Omit<HarborTrial, 'sample'>) => `${t.result.started_at ?? ''}\0${t.name}`
  read.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
  const first = read[0]!
  const reference = read.find((t) => !failedBeforeSetup(t)) ?? first
  const agent = reference.result.agent_info
  const environment = first.config.environment?.type ?? DEFAULT_ENVIRONMENT
  for (const t of read) {
    const info = failedBeforeSetup(t) ? { ...t.result.agent_info, version: agent.version } : t.result.agent_info
    if (!sameAgent(info, agent)) throw new Error(`${root}: trial ${t.name} ran agent ${t.result.agent_info.name}@${t.result.agent_info.version}, trial ${reference.name} ran ${agent.name}@${agent.version}; one job is one agent`)
    const env = t.config.environment?.type ?? DEFAULT_ENVIRONMENT
    if (env !== environment) throw new Error(`${root}: trial ${t.name} ran in ${env}, trial ${first.name} in ${environment}; one job is one environment`)
  }
  const perTask = new Map<string, number>()
  const trials = read.map((t) => {
    const sample = perTask.get(t.result.task_name) ?? 0
    perTask.set(t.result.task_name, sample + 1)
    return { ...t, sample }
  })
  return { dir: root, id: first.config.job_id ?? basename(root), trials, agent, environment, skipped: skipped.sort() }
}

// ------------------------------------------------------------------- mapping

/** `harbor:<agent name>@<version>`: the loop an imported attempt ran through. */
export function harborLoop(agent: HarborAgentInfo): string {
  return `harbor:${agent.name}@${agent.version}`
}

/** The task ids the job ran, in first-seen order. */
export function harborTasks(job: HarborJob): string[] {
  return [...new Set(job.trials.map((t) => t.result.task_name))]
}

/** Trials per task: the number of samples an import records for each task. */
export function harborTrialsPerTask(job: HarborJob): Map<string, number> {
  const counts = new Map<string, number>()
  for (const t of job.trials) counts.set(t.result.task_name, (counts.get(t.result.task_name) ?? 0) + 1)
  return counts
}

/** The facts behind an attempt (rule 0 on the attempts): the job's agent, its environment type, the task as verified. */
export function harborFactsSha(job: HarborJob, trial: HarborTrial): string {
  return sha256(canonicalJson({ agent_info: job.agent, environment: job.environment, task_checksum: trial.result.task_checksum }))
}

/** Tokens and cost as TrialResult.compute_token_cost_totals sums them: the trial's context, else its steps'. */
function usageOf(result: TrialResult): { input: number; cache: number | undefined; output: number; usd: number | undefined } {
  const contexts = result.agent_result ? [result.agent_result] : (result.step_results ?? []).flatMap((s) => (s.agent_result ? [s.agent_result] : []))
  let input = 0
  let output = 0
  let cache: number | undefined
  let usd: number | undefined
  for (const c of contexts) {
    input += c.n_input_tokens ?? 0
    output += c.n_output_tokens ?? 0
    if (c.n_cache_tokens != null) cache = (cache ?? 0) + c.n_cache_tokens
    if (c.cost_usd != null) usd = (usd ?? 0) + c.cost_usd
  }
  return { input, cache, output, usd }
}

/** The agent's wall time in its environment (S8), from the agent_execution timing when both ends were recorded. */
function wallSecondsOf(result: TrialResult): number | undefined {
  const started = result.agent_execution?.started_at
  const finished = result.agent_execution?.finished_at
  if (started == null || finished == null) return undefined
  const ms = Date.parse(finished) - Date.parse(started)
  return Number.isFinite(ms) && ms >= 0 ? ms / 1000 : undefined
}

export interface HarborMapOptions {
  /** The challenger row the attempts land under. */
  challengerId: string
  tier: Tier
  /** The pack's scorer version (`String(manifest.tasks.version ?? 0)`, as the runner records it). */
  scorerVersion: string
}

export interface HarborRows {
  attempts: AttemptRow[]
  scores: ScoreRow[]
}

/** The attempt row id of a trial under a challenger row: stable across imports of the same job in the same role, one per role (an id belongs to one row). */
export function harborAttemptId(challengerId: string, trial: HarborTrial): string {
  return `harbor-${trial.result.id}-${challengerId}`
}

/**
 * The attempt's status, as Harbor counts the trial: a reward is a scored
 * trial whatever the agent did (Harbor's verifier runs after an agent timeout
 * or a non-zero exit, and its stats count the reward), so the trial is
 * TRUNCATED on a timeout and COMPLETED otherwise, the exception type as the
 * stop reason; FAILED only when no reward was produced.
 */
function statusOf(trial: HarborTrial): Pick<AttemptRow, 'status' | 'stop_reason'> {
  const exception = trial.result.exception_info
  if (!exception) return { status: 'COMPLETED', stop_reason: 'completed' }
  const status = trial.rewards === undefined ? 'FAILED' : exception.exception_type === 'AgentTimeoutError' ? 'TRUNCATED' : 'COMPLETED'
  return { status, stop_reason: exception.exception_type }
}

/**
 * One attempt row per trial and one score row per reward key. `sample` is the
 * trial's index among its task's trials; `status` follows the reward and the
 * exception (`statusOf`); a reward makes the output valid; each score's truth
 * is the task's checksum, the one its verifier ran against (S6 pairs on it).
 */
export function harborAttempts(job: HarborJob, opts: HarborMapOptions): HarborRows {
  const loop = harborLoop(job.agent)
  const attempts: AttemptRow[] = []
  const scores: ScoreRow[] = []
  for (const trial of job.trials) {
    const { result } = trial
    const id = harborAttemptId(opts.challengerId, trial)
    const usage = usageOf(result)
    const wall = wallSecondsOf(result)
    attempts.push({
      id,
      challenger_id: opts.challengerId,
      task_id: result.task_name,
      sample: trial.sample,
      loop,
      tier: opts.tier,
      ...statusOf(trial),
      facts_sha: harborFactsSha(job, trial),
      usage: { input_tokens: usage.input, output_tokens: usage.output, ...(usage.cache !== undefined ? { cache_tokens: usage.cache } : {}) },
      cost: {
        tokens: usage.input + usage.output,
        ...(usage.usd !== undefined ? { usd: usage.usd } : {}),
        ...(wall !== undefined ? { wall_s: wall } : {}),
      },
      output: { source: 'harbor', valid: trial.rewards !== undefined },
      artifacts: [{ name: 'trial', sha: '', path: trial.dir }],
    })
    for (const [metric, value] of Object.entries(trial.rewards ?? {})) {
      scores.push({ attempt_id: id, scorer_version: opts.scorerVersion, truth_snapshot_id: result.task_checksum, metric, value, kind: 'reality' })
    }
  }
  return { attempts, scores }
}

/** The runner's result rows for imported attempts (what the executor hands the lifecycle). */
export function harborResultRows(rows: HarborRows): RunResultRow[] {
  return rows.attempts.map((a) => ({
    attemptId: a.id, task_id: a.task_id, loop: a.loop, facts_sha: a.facts_sha, status: a.status,
    cost: { ...(a.cost.usd !== undefined ? { usd: a.cost.usd } : {}) },
    scores: rows.scores.filter((s) => s.attempt_id === a.id).map((s) => ({ task_id: a.task_id, metric: s.metric, value: s.value, kind: s.kind })),
  }))
}

// --------------------------------------------------------------- coordinates

export interface HarborProposalOptions {
  set: TaskSet
  /** Primary metric (kind reality) the rows are judged on. */
  metric: string
}

/** The provider/model the job's agent ran on, as `RunOptions.route` wants it (the executor that replays a job reads nothing of it). */
export function harborRoute(job: HarborJob): { provider: string; model: string; credentialRef: string } {
  const info = job.agent.model_info
  const config = job.trials[0]?.config
  return { provider: info?.provider ?? '', model: info?.name ?? config?.agent?.model_name ?? '', credentialRef: '' }
}

/**
 * The job as a champion row: no patch, no parent, the job id as
 * `optimizer_config_sha`; the agent/model is the route, its identity the
 * harness, the environment and agent config the env, the declared skill
 * sources the skill, the set's truth the snapshot (each score carries its
 * task's checksum, so a job on some of the set's tasks judges against one on
 * all of them). Coordinates are the job's own, so rule 0 refuses two jobs of
 * different agents or environments (the gate compares patches, not agents).
 */
export function harborChampion(job: HarborJob, def: PackDefinition, book: Book, opts: HarborProposalOptions): ChallengerProposal {
  const config = job.trials[0]!.config
  const route = harborRoute(job)
  const skill_sha = sha256(canonicalJson(config.agent?.skills ?? []))
  const timeoutS = Math.round((config.agent?.override_timeout_sec ?? 0) * (config.timeout_multiplier ?? 1) * (config.agent_timeout_multiplier ?? 1))
  return {
    parent_ids: [],
    patch_sha: NONE_SHA,
    harness_sha: sha256(canonicalJson(job.agent)),
    env_sha: sha256(canonicalJson({
      environment: {
        type: job.environment,
        kwargs: config.environment?.kwargs ?? {},
        cpus: config.environment?.override_cpus ?? null,
        memory_mb: config.environment?.override_memory_mb ?? null,
      },
      agent: { kwargs: config.agent?.kwargs ?? {} },
    })),
    skill_sha,
    taskset_sha: book.tasksetSha(opts.set),
    route: {
      loop: harborLoop(job.agent),
      loop_adapter_version: job.agent.version,
      model_id: route.model,
      model_pool_sha: sha256(canonicalJson({ provider: route.provider, model: route.model })),
      base_url_kind: 'direct',
    },
    optimizer_config_sha: sha256(job.id),
    lineage: 'main',
    surface: 'skill',
    patch: { skill_ref: `skill:${skill_sha}` },
    intent: 'champion',
    prediction: { metric: opts.metric, direction: 'up' },
    pack: def.name,
    scorer_version: String(def.manifest.tasks.version ?? 0),
    task_version: def.manifest.tasks.version ?? 0,
    truth_snapshot_id: book.tasksetSha(opts.set),
    report_rule_version: '0',
    runtime: { timeout_s: timeoutS, step_cap: 0 },
    tasksets: { smoke: book.tasksetSha('smoke'), holdin: book.tasksetSha('holdin'), holdout: book.tasksetSha('holdout') },
    budget: def.manifest.holdout?.budget ?? 0,
  }
}

export type HarborSkillSnapshot = { sha: string } | { missing: string[] }

/**
 * The job's declared skills copied into `dest` in the layout the agent read
 * them in (`<skills dir>/<skill name>/`, as Harbor uploads them: a source
 * holding SKILL.md is one skill, else each of its child directories is one;
 * a later source wins a name). Sources are the job's, relative to the
 * working directory as Harbor resolves them; when one is not on this
 * machine nothing is copied and the missing sources are returned.
 */
export function snapshotHarborSkills(job: HarborJob, dest: string): HarborSkillSnapshot {
  const sources = (job.trials[0]?.config.agent?.skills ?? []).map((s) => resolve(s))
  const missing = sources.filter((s) => !existsSync(s) || !statSync(s).isDirectory())
  if (missing.length > 0) return { missing }
  const skills = new Map<string, string>()
  for (const source of sources) {
    if (existsSync(resolve(source, SKILL_FILE))) {
      skills.set(basename(source), source)
      continue
    }
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) skills.set(entry.name, resolve(source, entry.name))
    }
  }
  for (const [name, source] of skills) cpSync(source, resolve(dest, name), { recursive: true })
  return { sha: hashDir(dest) }
}

/**
 * The job as a challenger of `championId`: the job's own coordinates (rule 0
 * is the service's), the job id as `optimizer_config_sha`, `skillDir` as the
 * patch the scope opens on. With the snapshot of the job's skills in it
 * (`snapshotHarborSkills`), its hash is the skill and patch sha, so the diff
 * scan reads what the agent read (S5) and a promotion applies it (E7);
 * without one the declared sources stand as the sha and the row cannot be
 * promoted.
 */
export function harborChallenger(job: HarborJob, def: PackDefinition, book: Book, championId: string, championSkillRef: string, opts: HarborProposalOptions & { intent: string; skillDir: string; skillSha?: string }): ChallengerProposal {
  const own = harborChampion(job, def, book, opts)
  const skill_sha = opts.skillSha ?? own.skill_sha
  return {
    ...own,
    parent_ids: [championId],
    patch_sha: skill_sha,
    skill_sha,
    patch: { skill_ref: opts.skillDir, before: championSkillRef },
    intent: opts.intent,
  }
}
