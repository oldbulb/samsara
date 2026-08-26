// The runner core: tasks × repeat → open an environment → materialize →
// loops.start → drain events → read/validate submit → pack truth → pack score
// → one attempts.jsonl row. An attempt runs in one environment opened on
// `deps.environments` (`req.env`, `local` by default): the sealed workdir is
// put into it, the loop and the pack's `in_environment` commands run there,
// its facts land on the row, and it is disposed with the attempt (E4). The
// `local` provider is opened on the attempt dir itself (`<out>/attempts/<id>`),
// so on this host the layout, the sandbox roots and what a run leaves behind
// are what they were before the seam. Without the registry (the tests) the
// attempt runs in the host workdir.
// Attempts run through a bounded pool (`parallel`); pack subprocess stages
// (materialize / truth / score) share a smaller semaphore; every row goes
// through one serialized writer (attempts.jsonl + ledger) in completion order
// and the result rows come back in task × sample order.
// Pure with respect to cordis: every dependency comes in through `RunDeps`,
// so tests drive it with fakes and the plugin (index.ts) only wires services.

import { createWriteStream, mkdirSync, readFileSync, appendFileSync, existsSync, writeFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { relative, resolve } from 'node:path'
import { createBook, type Book, type Task, type TaskSet } from '@oldbulb/samsara-book'
import { environmentSha, type Environment, type EnvironmentFacts, type EnvironmentSpec, type Environments } from '@oldbulb/samsara-environments'
import { attemptRowOf, sha256, canonicalJson, type ChallengerProposal, type Ledger, type Tier } from '@oldbulb/samsara-ledger'
import { factsSha, type AttemptSpec, type FinishedEvent, type LoopEvent, type LoopProvider, type LoopRun, type TokenUsage } from '@oldbulb/samsara-loops'
import { commandEnv, loadPack, runCommand, validateSubmit, PackError, type CommandExec, type PackDefinition, type PackEnvironment, type TaskLine } from '@oldbulb/samsara-pack'
import { envLock, findRepoRoot, type EnvLock } from '@oldbulb/samsara-scope'
import { policyFor } from '@oldbulb/samsara-sandbox'
import { submitPath } from '@oldbulb/samsara-submit'
import { materialize as materializeWorkdir, hashDir, policyPaths, SKILLS_DIR, TMP_DIR, type MaterializeOptions, type Workdir } from '@oldbulb/samsara-workdir'
import { Semaphore, WriterQueue, runPool } from './pool.ts'
import { isComplete, readRunRecord, readStep, stepPath, writeRunRecord, writeStep, type StepData, type StepMarker } from './steps.ts'

/** The slice of `ctx.loops` the runner needs (structural, so tests pass a fake). */
export interface Loops {
  get(name: string): LoopProvider | undefined
  start(name: string, spec: AttemptSpec): Promise<LoopRun>
}

export type Materialize = (opts: MaterializeOptions) => Promise<Workdir>

/** The slice of `ctx.ledger` the runner writes through (structural, so tests pass a fake). */
export type LedgerSink = Pick<Ledger, 'propose' | 'recordAttempt' | 'appendScores'>

export interface RunRequest {
  pack: string
  loop: string
  set: TaskSet
  limit?: number
  /** Only tasks whose `stratum` (the pack's `stratum_key`) is one of these; absent = every stratum. Applied before `limit`. */
  stratum?: string[]
  repeat: number
  out: string
  maxTurns: number
  maxMinutes: number
  allow?: string[]
  /** Skill directory to run instead of the pack's (a challenger's snapshot). */
  skillDir?: string
  /** Attempts in flight at once (default 1); pack subprocess stages are capped at min(parallel, PACK_STAGE_CAP). */
  parallel?: number
  /** The environment provider the attempts run in (as registered on ctx.environments); default `local`. */
  env?: string
  /**
   * Re-enter the run recorded in `<out>/run.json` (same run id; every other
   * field of this request is replaced by the recorded one) and skip the steps
   * whose `.steps/<step>.json` marker exists. See steps.ts.
   */
  resume?: boolean
}

/** Upper bound on concurrent pack commands (materialize / truth / score) whatever `parallel` says. */
export const PACK_STAGE_CAP = 8
/** Interval of the stderr heartbeat while attempts are in flight. */
export const HEARTBEAT_MS = 10_000

export interface RouteConfig {
  provider: string
  model: string
  baseUrl?: string
  /** Declared kind for the ledger; inferred from `baseUrl` when absent. */
  baseUrlKind?: 'direct' | 'proxy'
  credentialRef: string
  reasoning?: Record<string, unknown>
}

/** The route as it enters `env_sha`: everything that changes behaviour, nothing that only changes a label. */
export function envRoute(route: RouteConfig): Omit<RouteConfig, 'baseUrlKind'> {
  const { baseUrlKind: _label, ...rest } = route
  return rest
}

export interface RunDeps {
  loops: Loops
  route: RouteConfig
  /** Defaults to @oldbulb/samsara-workdir's materialize; tests substitute. */
  materialize?: Materialize
  /** When present, every attempt and its scores are also recorded under a champion challenger row. */
  ledger?: LedgerSink
  /** Record attempts under this existing challenger row instead of proposing the champion row. */
  challengerId?: string
  /** The champion's kept skill snapshot (ctx.champion.current().skill_ref); runs instead of the pack's when `req.skillDir` is unset. */
  championSkillDir?: string
  signal?: AbortSignal
  /** Injected for deterministic ids in tests. */
  runId?: string
  log?: (line: string) => void
  /** Heartbeat period while attempts are in flight; tests shorten it. */
  heartbeatMs?: number
  /** `ctx.environments`: one environment per attempt is opened on `req.env`. Absent, attempts run in the host workdir with no environment (the tests). */
  environments?: Pick<Environments, 'open'>
  /** E4: registers an environment's dispose on the challenger's scope so a disposed scope kills what it opened; returns the unregister. */
  track?: (dispose: () => Promise<void>) => () => void
}

export interface ScoreLine {
  task_id: string
  metric: string
  value: number
  kind: 'mechanical' | 'reality' | 'judge'
  stratum?: string
}

export interface AttemptRow {
  attemptId: string
  task_id: string
  loop: string
  facts_sha: string
  status: FinishedEvent['status']
  stopReason: FinishedEvent['stopReason'] | 'host_error'
  usage: TokenUsage
  /** The loop's cost, plus the agent's wall time in its environment (sealed workdir → loop finished; S8): the ledger keeps it as `wall_s`. */
  cost: FinishedEvent['cost'] & { wallMs?: number }
  toolCalls: number
  /** From the loop's finished event: 'inline' or the read fraction; absent when the loop did not report. */
  skillUtilization?: number | 'inline'
  output: { valid: boolean; file?: string; error?: string }
  truth: { status: 'settled' | 'pending' | 'error'; truth_sha?: string; error?: string }
  scores: ScoreLine[]
  /** Set when the host itself failed around the loop (environment, materialize, truth, score); the loop's own failure is `status: FAILED`. */
  error?: string
  /** What the attempt ran in, as its provider reported it; absent without an environment. */
  environment?: EnvironmentFacts
}

export interface RunResult {
  runId: string
  pack: string
  set: TaskSet
  tasksetSha: string
  /** Set when a ledger recorded the run. */
  challengerId?: string
  rows: AttemptRow[]
  attemptsPath: string
}

export function sanitizeId(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, '_')
}

export function newRunId(now = new Date()): string {
  const ts = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  return `run-${ts}`
}

export function submitToolName(def: PackDefinition): string {
  return `submit_${def.manifest.skill.name}`
}

export interface SubmitRead {
  valid: boolean
  file?: string
  submit?: unknown
  error?: string
}

/**
 * Read the submit file the loop left at `<workdir>/<submitTool>.json` (the
 * @oldbulb/samsara-submit convention) and validate it against the pack contract.
 */
export function readSubmit(def: PackDefinition, workdir: string): SubmitRead {
  const file = submitPath(workdir, submitToolName(def))
  if (!existsSync(file)) return { valid: false, error: `no submit file ${file.slice(workdir.length + 1)}` }
  let submit: unknown
  try {
    submit = JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    return { valid: false, file, error: `submit file is not JSON: ${(e as Error).message}` }
  }
  try {
    validateSubmit(def, submit)
  } catch (e) {
    return { valid: false, file, submit, error: (e as PackError).message }
  }
  return { valid: true, file, submit }
}

/** The tasks a request addresses: the set, narrowed to `stratum` when given, then the first `limit`. */
export function selectTasks(book: Book, req: Pick<RunRequest, 'set' | 'limit' | 'stratum'>): readonly Task[] {
  const all = book.tasks(req.set)
  const chosen = req.stratum ? all.filter((t) => req.stratum!.includes(t.stratum ?? '')) : all
  return chosen.slice(0, req.limit ?? undefined)
}

export function bookOf(def: PackDefinition): Book {
  const book = createBook({
    sets: { smoke: def.taskSets.smoke.tasks, holdin: def.taskSets.holdin.tasks, holdout: def.taskSets.holdout.tasks },
    entityKey: 'entity_key',
    holdoutPolicy: { mde: def.manifest.holdout?.mde ?? 0.05, budget: def.manifest.holdout?.budget ?? 0 },
  })
  // S2/S7: a held-out set sharing an entity with the visible sets is refused (HoldoutNotDisjoint).
  book.assertDisjointHoldout()
  return book
}

/** The default when the pack declares no network policy: nothing reaches out unless a pack says so. */
const DEFAULT_NETWORK: EnvironmentSpec['network'] = 'none'
/** The provider that is this host: no design choice (rule 0), opened on the attempt dir itself, the default. */
const HOST_PROVIDER = 'local'

/**
 * The environment an attempt asks for: the pack's `environment` block (a task
 * row's overrides it) in the seam's terms. The lifetime is the block's
 * `timeout_s`, else the attempt's wall-clock limit; the env is empty (E5: each
 * exec passes what it needs). The sealed workdir is put in, not mounted; the
 * pack dir is mounted read-only at its own path when a command runs inside,
 * so `sh -c <run>` resolves from it as it does on the host. A task row's
 * `workdir` column is where the attempt runs inside (the image's working
 * directory, which its tests may assume); absent, the provider's default.
 */
export function environmentSpecOf(def: PackDefinition, block: PackEnvironment | undefined, attemptId: string, req: Pick<RunRequest, 'maxMinutes'>, workdir?: string): EnvironmentSpec {
  const resources = block?.resources
  return {
    attemptId,
    ...(workdir !== undefined ? { workdir } : {}),
    ...(block?.image !== undefined ? { image: { ref: block.image } } : block?.dockerfile !== undefined ? { image: { dockerfileDir: resolve(def.dir, block.dockerfile) } } : {}),
    resources: {
      ...(resources?.cpus !== undefined ? { cpus: resources.cpus } : {}),
      ...(resources?.memory_mb !== undefined ? { memoryMb: resources.memory_mb } : {}),
      timeoutS: resources?.timeout_s ?? Math.round(req.maxMinutes * 60),
    },
    network: block?.network ?? DEFAULT_NETWORK,
    ...(block?.allowed_hosts !== undefined ? { allowedHosts: block.allowed_hosts } : {}),
    env: {},
    mounts: Object.values(def.commandSpecs).some((c) => c?.inEnvironment) ? [{ from: def.dir, to: def.dir, readOnly: true }] : [],
  }
}

/**
 * One deadline bounds the attempt, so the exec's clock and the environment's
 * lifetime never disagree: the request's wall-clock cap (`--max-minutes`),
 * tightened to the environment block's `timeout_s` when it declares a smaller
 * one — the loop's `maxDurationMs`, the challenger's declared limits and its
 * `runtime.timeout_s` all derive from it.
 */
export function attemptDeadlineMs(req: Pick<RunRequest, 'maxMinutes'>, block: PackEnvironment | undefined): number {
  const wallMs = Math.round(req.maxMinutes * 60_000)
  const declared = block?.resources?.timeout_s
  return declared === undefined ? wallMs : Math.min(wallMs, declared * 1000)
}

/**
 * The environment coordinate (rule 0) a request declares: absent on the local
 * provider (the host is no design choice), else the pack's block as the
 * provider would report it — computed from the declaration, not from a probe
 * open: a row must exist before any image is built or pulled. A `ref` is
 * declared as written (a tag re-pulled to another digest is caught after the
 * run by the attempt facts); a `dockerfile` build has no digest before it is
 * built, so the content hash of its build context stands in — two Dockerfiles
 * are two designs. What actually ran is on every attempt row.
 */
export function declaredEnvironmentSha(def: PackDefinition, req: Pick<RunRequest, 'env' | 'maxMinutes'>): string | undefined {
  const provider = req.env ?? HOST_PROVIDER
  if (provider === HOST_PROVIDER) return undefined
  const spec = environmentSpecOf(def, def.manifest.environment, '', req)
  return environmentSha({
    provider, version: '',
    ...(spec.image?.ref !== undefined ? { image: { ref: spec.image.ref } } : spec.image?.dockerfileDir !== undefined ? { image: { digest: hashDir(spec.image.dockerfileDir) } } : {}),
    resources: spec.resources, network: spec.network,
    ...(spec.allowedHosts !== undefined ? { allowedHosts: spec.allowedHosts } : {}),
  })
}

/**
 * What an `in_environment` command gets on top of the image's own environment
 * (E5): the names the pack declares in `runtime.env`, read from the host, and
 * the attempt's TMPDIR — none of the host's PATH, HOME or shell.
 */
export function environmentCommandEnv(def: Pick<PackDefinition, 'manifest'>, tmpdir: string, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of def.manifest.runtime?.env ?? []) {
    const value = source[name]
    if (value !== undefined) env[name] = value
  }
  return { ...env, TMPDIR: tmpdir }
}

/**
 * The finished loop a resume re-enters, when what the later steps need is
 * still on disk. In the host workdir (no environment, or the host provider's,
 * which is the attempt dir) everything is; in another environment the agent's
 * workdir went with its dispose, so the loop is re-entered only past the truth
 * marker (and past the score marker when score runs inside too) — otherwise
 * the attempt starts from scratch, as a cancelled one does.
 */
export function resumableLoop(def: PackDefinition, attemptDir: string): (StepMarker & StepData['loop']) | undefined {
  const loop = readStep(attemptDir, 'loop')
  if (!loop || (readStep(attemptDir, 'materialize')?.environment?.provider ?? HOST_PROVIDER) === HOST_PROVIDER) return loop
  if (!readStep(attemptDir, 'truth')) return undefined
  if (def.commandSpecs.score?.inEnvironment && !readStep(attemptDir, 'score')) return undefined
  return loop
}

function failedFinish(at: number, status: FinishedEvent['status'] = 'FAILED', stopReason: FinishedEvent['stopReason'] = 'error'): FinishedEvent {
  return { t: 'finished', at, status, stopReason, usage: { inputTokens: 0, outputTokens: 0 }, cost: { source: 'unknown' }, turns: 0, toolCalls: 0, artifacts: [] }
}

/** Stream events to disk as they arrive; nothing is kept in memory once written. */
async function drainEvents(events: AsyncIterable<LoopEvent>, file: string): Promise<void> {
  mkdirSync(resolve(file, '..'), { recursive: true })
  const ws = createWriteStream(file, { flags: 'a' })
  try {
    for await (const ev of events) ws.write(JSON.stringify(ev) + '\n')
  } finally {
    await new Promise<void>((done) => ws.end(done))
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Per-run shared state for one attempt: the pack-stage semaphore and the abort signal. */
interface Stages {
  pack: Semaphore
  signal?: AbortSignal
}

function emptyRow(attemptId: string, task: TaskLine, loop: string, facts_sha: string): AttemptRow {
  return {
    attemptId, task_id: task.task_id, loop, facts_sha,
    status: 'FAILED', stopReason: 'host_error',
    usage: { inputTokens: 0, outputTokens: 0 }, cost: { source: 'unknown' }, toolCalls: 0,
    output: { valid: false }, truth: { status: 'error' }, scores: [],
  }
}

async function runOne(def: PackDefinition, task: TaskLine, r: number, req: RunRequest, deps: RunDeps, runId: string, stages: Stages): Promise<AttemptRow> {
  const attemptId = `${runId}-${sanitizeId(task.task_id)}-${r}`
  const attemptDir = resolve(req.out, 'attempts', attemptId)
  const provider = deps.loops.get(req.loop)
  // Durable steps: on resume a step whose marker exists is skipped. A finished
  // loop is re-run only when its environment took the agent's work with it
  // (resumableLoop); an attempt without a loop marker starts from scratch.
  const loopDone = req.resume ? resumableLoop(def, attemptDir) : undefined
  // An attempt re-entered from scratch starts from an empty attempt dir, whatever a killed host left in it.
  if (!loopDone && req.resume && existsSync(attemptDir)) rmSync(attemptDir, { recursive: true, force: true })

  // The environment's facts join the harness facts on a provider that is a design choice: rows from different
  // environments never pool, and host-side rows (`local`, the default) keep the sha they had before the seam.
  const designed = (req.env ?? HOST_PROVIDER) !== HOST_PROVIDER
  // A finished loop keeps the facts its materialize step recorded (its environment is gone); a fresh attempt opens one —
  // the host provider on the attempt dir itself, so the loop's tree is where it was before the seam and stays after.
  let environment: Environment | undefined
  let facts: EnvironmentFacts | undefined
  if (loopDone) {
    facts = readStep(attemptDir, 'materialize')?.environment
  } else if (deps.environments) {
    try {
      const spec = environmentSpecOf(def, task.environment ?? def.manifest.environment, attemptId, req, typeof task['workdir'] === 'string' ? task['workdir'] : undefined)
      environment = await deps.environments.open(req.env ?? HOST_PROVIDER, designed ? spec : { ...spec, workdir: attemptDir })
    } catch (e) {
      const row = emptyRow(attemptId, task, req.loop, provider ? factsSha(provider.harnessFacts) : '')
      row.error = `environment: ${msg(e)}`
      return row
    }
    facts = environment.facts()
  }
  const facts_sha = provider ? factsSha(facts && designed ? { ...provider.harnessFacts, environment: facts } : provider.harnessFacts) : ''
  const row = emptyRow(attemptId, task, req.loop, facts_sha)
  if (facts) row.environment = facts
  // E4: the challenger's scope reaches the environment too, so a disposed scope kills what it opened.
  const untrack = environment && deps.track ? deps.track(() => environment.dispose()) : undefined
  try {
    return await attempt(def, task, r, req, deps, stages, { attemptId, attemptDir, row, loopDone, environment })
  } finally {
    await environment?.dispose().catch(() => {})
    untrack?.()
  }
}

/** One attempt's pipeline inside its environment (or the host workdir): materialize → loop → submit → truth → score. */
async function attempt(
  def: PackDefinition, task: TaskLine, r: number, req: RunRequest, deps: RunDeps, stages: Stages,
  at: { attemptId: string; attemptDir: string; row: AttemptRow; loopDone: (StepMarker & StepData['loop']) | undefined; environment: Environment | undefined },
): Promise<AttemptRow> {
  const { attemptId, attemptDir, row, loopDone, environment } = at
  const attemptsDir = resolve(req.out, 'attempts')
  const skillDir = req.skillDir ?? deps.championSkillDir ?? def.skillDir
  const challengerId = deps.challengerId ?? 'champion'
  const signal = stages.signal

  let wd: Pick<Workdir, 'path' | 'localPath' | 'tmpdir' | 'skillSha'>
  if (loopDone) {
    const mat = readStep(attemptDir, 'materialize')
    wd = { path: attemptDir, localPath: attemptDir, tmpdir: resolve(attemptDir, mat?.tmpdir ?? TMP_DIR), skillSha: mat?.skillSha ?? '' }
  } else {
    try {
      wd = await stages.pack.run(() => (deps.materialize ?? materializeWorkdir)({
        attemptId, taskId: task.task_id, challengerId, sample: r, pack: def, baseDir: attemptsDir,
        skill: { name: def.manifest.skill.name, dir: skillDir },
        extraSkillDirs: ['.claude/skills'],
        ...(environment ? { environment } : {}),
      }))
      writeStep(attemptDir, attemptId, 'materialize', { tmpdir: relative(wd.path, wd.tmpdir), skillSha: wd.skillSha, ...(row.environment ? { environment: row.environment } : {}) })
    } catch (e) {
      row.error = `materialize: ${msg(e)}`
      return row
    }
  }

  let finished: FinishedEvent
  if (loopDone) {
    finished = loopDone.finished
    if (loopDone.error !== undefined) row.error = loopDone.error
  } else {
    // Cancellation: the attempt's own signal is aborted and, once the run exists, run.cancel() is called too.
    const controller = new AbortController()
    let run: LoopRun | undefined
    const onAbort = () => {
      controller.abort(signal?.reason)
      run?.cancel(String(signal?.reason ?? 'aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    const spec: AttemptSpec = {
      attemptId, challengerId, workdir: wd.path,
      skill: { name: def.manifest.skill.name, dir: resolve(wd.path, SKILLS_DIR, def.manifest.skill.name), sha: wd.skillSha },
      prompt: readFileSync(resolve(skillDir, 'SKILL.md'), 'utf8'),
      route: { ...deps.route },
      outputSchema: def.contractSchema,
      tools: { allow: req.allow ?? [], deny: def.denyPatterns, submitTool: { name: submitToolName(def), schema: def.contractSchema } },
      limits: { maxTurns: req.maxTurns, maxDurationMs: attemptDeadlineMs(req, task.environment ?? def.manifest.environment) },
      tmpdir: wd.tmpdir,
      // The host copy of the workdir: where an installed loop lands what it fetches back (its transcript, the submit).
      localWorkdir: wd.localPath,
      signal: controller.signal,
      // E9: the loop's subprocesses see the workdir, the pack's skill/ and loader/, and its runtimes; enforced on Linux only.
      sandbox: policyFor({ ...policyPaths(wd.path, def), homeDir: homedir() }),
      ...(environment ? { environment } : {}),
    }

    try {
      run = await deps.loops.start(req.loop, spec)
      if (signal?.aborted) onAbort()
      try {
        await drainEvents(run.events, resolve(attemptDir, 'events.jsonl'))
        finished = await run.result
      } finally {
        // Dispose as soon as the loop has published its result: the events are on disk already.
        await run.dispose().catch(() => {})
        run = undefined
      }
    } catch (e) {
      finished = signal?.aborted ? failedFinish(Date.now(), 'ABORTED', 'aborted') : failedFinish(Date.now())
      row.error = `loop: ${msg(e)}`
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
    // A loop the host cancelled is not finished: no marker, so a resume re-runs the attempt from scratch.
    if (!signal?.aborted) writeStep(attemptDir, attemptId, 'loop', { finished, ...(row.error !== undefined ? { error: row.error } : {}) })
  }
  row.status = finished.status
  row.stopReason = finished.stopReason
  row.usage = finished.usage
  // S8: the agent's wall time in its environment, from the markers so a resumed row carries it too.
  const materialized = readStep(attemptDir, 'materialize')
  const looped = loopDone ?? readStep(attemptDir, 'loop')
  row.cost = materialized && looped ? { ...finished.cost, wallMs: Date.parse(looped.at) - Date.parse(materialized.at) } : finished.cost
  row.toolCalls = finished.toolCalls
  if (finished.skillUtilization !== undefined) row.skillUtilization = finished.skillUtilization

  const submitDone = loopDone ? readStep(attemptDir, 'submit') : undefined
  // The submit is read from the host copy; an environment elsewhere hands its file back first (nothing there is not a submit).
  if (!submitDone && environment && wd.path !== wd.localPath) {
    const file = relative(wd.localPath, submitPath(wd.localPath, submitToolName(def)))
    await environment.get(file, resolve(wd.localPath, file)).catch(() => {})
  }
  const sub: SubmitRead = submitDone ?? readSubmit(def, wd.localPath)
  if (!submitDone && !signal?.aborted) {
    writeStep(attemptDir, attemptId, 'submit', { valid: sub.valid, ...(sub.file !== undefined ? { file: sub.file } : {}), ...(sub.submit !== undefined ? { submit: sub.submit } : {}), ...(sub.error !== undefined ? { error: sub.error } : {}) })
  }
  row.output = { valid: sub.valid, ...(sub.file ? { file: sub.file } : {}), ...(sub.error ? { error: sub.error } : {}) }

  if (signal?.aborted) {
    // Do not fork pack commands for a run the host is tearing down; the row still lands.
    row.truth = { status: 'error', error: 'aborted before truth' }
    return row
  }
  const truthDone = loopDone ? readStep(attemptDir, 'truth') : undefined
  const scoreDone = truthDone ? readStep(attemptDir, 'score') : undefined
  try {
    // E5/E8: the host-side judge sees the pack's declared environment and the attempt's TMPDIR, never the host's credentials.
    const env = commandEnv(def, { TMPDIR: wd.tmpdir })
    // A command the pack marks `in_environment` runs through the attempt's environment over the same line protocol, from
    // the pack dir (mounted there), on the image's own environment plus environmentCommandEnv — not the host env above (E5).
    const exec: CommandExec | undefined = environment ? (argv, stdin, o) => environment.exec(argv, { cwd: def.dir, ...o, env: environmentCommandEnv(def, wd.tmpdir), stdin }) : undefined
    const command = { env, ...(exec ? { exec } : {}) }
    let truthValue: unknown
    if (truthDone) {
      row.truth = truthDone.truth
      truthValue = truthDone.value
    } else {
      const [truth] = await stages.pack.run(() => runCommand(def, 'truth', [{ task_id: task.task_id, workdir: wd.path }], command))
      if (!truth) throw new Error('truth returned no line')
      row.truth = { status: truth['status'] as 'settled' | 'pending', truth_sha: truth['truth_sha'] as string }
      truthValue = truth['truth']
      writeStep(attemptDir, attemptId, 'truth', { truth: row.truth, ...(truthValue !== undefined ? { value: truthValue } : {}) })
    }
    if (scoreDone) {
      row.scores = scoreDone.scores
    } else {
      if (row.truth.status === 'settled') {
        const output = {
          usage: { input_tokens: finished.usage.inputTokens, output_tokens: finished.usage.outputTokens, cost_usd: finished.cost.usd ?? null },
          cost_usd: finished.cost.usd ?? null,
          tool_calls: finished.toolCalls,
          submit: sub.valid ? sub.submit : null,
          valid: sub.valid,
          status: finished.status,
        }
        const scores = await stages.pack.run(() => runCommand(def, 'score', [{ task_id: task.task_id, truth: truthValue, output }], command))
        row.scores = scores as unknown as ScoreLine[]
      }
      writeStep(attemptDir, attemptId, 'score', { scores: row.scores })
    }
  } catch (e) {
    row.truth = { status: 'error', error: msg(e) }
    row.error ??= `${(e as PackError).command ?? 'truth'}: ${msg(e)}`
  }
  return row
}

const NONE_SHA = sha256('')

/** The lock-file environment fingerprint for this pack + loop (adoptions item 3). */
export function envLockOf(def: PackDefinition, loop: string): EnvLock {
  return envLock({ repoRoot: findRepoRoot(def.dir), packDir: def.dir, packLocks: def.manifest.runtime?.locks ?? [], loops: [loop] })
}

/** Write `<runDir>/env-lock.json` (the lock inputs and sha) and return the lock. */
export function writeEnvLock(runDir: string, lock: EnvLock): EnvLock {
  mkdirSync(runDir, { recursive: true })
  writeFileSync(resolve(runDir, 'env-lock.json'), JSON.stringify(lock, null, 2) + '\n')
  return lock
}

/**
 * The champion as a challenger row: no patch, no parents, no optimizer; its
 * coordinates are the harness facts, the route + limits, the skill directory
 * and the task set, so the same deployment always lands on the same id. The
 * pack name is on it too: the ledger derives `eval_config_sha` from the first
 * writer, and a row `run` recorded must be the one a round later opens on.
 */
export function championProposal(def: PackDefinition, book: Book, req: RunRequest, deps: Pick<RunDeps, 'loops' | 'route' | 'championSkillDir'>, lock: EnvLock = envLockOf(def, req.loop)): ChallengerProposal {
  const provider = deps.loops.get(req.loop)
  const harness_sha = provider ? factsSha(provider.harnessFacts) : NONE_SHA
  const limits = { maxTurns: req.maxTurns, maxDurationMs: attemptDeadlineMs(req, def.manifest.environment) }
  const effort = deps.route.reasoning?.['effort']
  const skill_sha = hashDir(req.skillDir ?? deps.championSkillDir ?? def.skillDir)
  const environment_sha = declaredEnvironmentSha(def, req)
  return {
    parent_ids: [],
    patch_sha: NONE_SHA,
    harness_sha,
    // The lock-file fingerprint plus the route and limits this deployment runs
    // under. `baseUrlKind` is only how the route is labelled in the ledger, so
    // it stays out: relabelling must not make earlier rows incomparable.
    env_sha: sha256(canonicalJson({ env_lock: lock.sha, route: envRoute(deps.route), limits })),
    // Rule 0 over where the attempts run: absent on the local provider, so earlier rows keep their ids.
    ...(environment_sha !== undefined ? { environment_sha } : {}),
    skill_sha,
    taskset_sha: book.tasksetSha(req.set),
    route: {
      loop: req.loop,
      loop_adapter_version: provider?.harnessFacts.version.loop ?? '',
      model_id: deps.route.model,
      ...(effort !== undefined ? { effort: String(effort) } : {}),
      model_pool_sha: sha256(canonicalJson({ provider: deps.route.provider, model: deps.route.model })),
      base_url_kind: deps.route.baseUrlKind ?? (deps.route.baseUrl ? 'proxy' : 'direct'),
    },
    optimizer_config_sha: NONE_SHA,
    lineage: 'main',
    surface: 'skill',
    patch: { skill_ref: `skill:${skill_sha}` },
    intent: 'champion',
    prediction: { metric: '', direction: 'up' },
    pack: def.name,
    scorer_version: String(def.manifest.tasks.version ?? 0),
    task_version: def.manifest.tasks.version ?? 0,
    truth_snapshot_id: book.tasksetSha(req.set),
    report_rule_version: '0',
    runtime: { timeout_s: Math.round(limits.maxDurationMs / 1000), step_cap: req.maxTurns },
    tasksets: { smoke: book.tasksetSha('smoke'), holdin: book.tasksetSha('holdin'), holdout: book.tasksetSha('holdout') },
    budget: def.manifest.holdout?.budget ?? 0,
  }
}

async function recordInLedger(ledger: LedgerSink, row: AttemptRow, challengerId: string, tier: Tier, scorerVersion: string): Promise<void> {
  await ledger.recordAttempt({
    ...attemptRowOf(row, { challengerId, loop: row.loop, tier, scorerVersion }),
    ...(row.skillUtilization !== undefined ? { skill_utilization: { value: row.skillUtilization } } : {}),
    ...(row.environment !== undefined ? { environment: row.environment } : {}),
  })
  const truth_snapshot_id = row.truth.truth_sha ?? 'unsettled'
  await ledger.appendScores(row.scores.map((s) => ({
    attempt_id: row.attemptId,
    scorer_version: scorerVersion,
    truth_snapshot_id,
    metric: s.metric,
    value: s.value,
    kind: s.kind,
    ...(s.stratum !== undefined ? { stratum: s.stratum } : {}),
  })))
}

/** `<out>/attempts.jsonl` as attemptId → last row; a missing file is an empty run. */
function readAttemptsJsonl(file: string): Map<string, AttemptRow> {
  const rows = new Map<string, AttemptRow>()
  if (!existsSync(file)) return rows
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line) as AttemptRow
      rows.set(row.attemptId, row)
    } catch {
      // a torn last line from a killed run: the attempt's record marker is missing too, so it is re-recorded
    }
  }
  return rows
}

export async function runSet(input: RunRequest, deps: RunDeps): Promise<RunResult> {
  // --resume: the recorded request and run id win over the caller's; only `out` comes from the caller.
  const record = input.resume ? readRunRecord(input.out) : undefined
  const req: RunRequest = record ? { ...record.request, out: input.out, resume: true } : input
  if (req.env !== undefined && deps.environments === undefined) throw new Error(`environment provider ${req.env} was asked for but no environments registry is mounted`)
  // A host-side loop runs the agent on this host: another provider's workdir is not a path here, so refuse before anything opens.
  const loopProvider = deps.loops.get(req.loop)
  if (loopProvider && !loopProvider.capabilities.installed && (req.env ?? HOST_PROVIDER) !== HOST_PROVIDER) {
    throw new Error(`loop ${req.loop} runs on the host; --env ${req.env} needs an installed loop`)
  }
  const def = loadPack(req.pack)
  const book = bookOf(def)
  const runId = record?.runId ?? deps.runId ?? newRunId()
  const log = deps.log ?? (() => {})
  const lock = writeEnvLock(req.out, envLockOf(def, req.loop))
  const proposal = deps.ledger ? championProposal(def, book, req, deps, lock) : undefined
  const challengerId = deps.challengerId ?? (deps.ledger && proposal ? await deps.ledger.propose(proposal) : undefined)
  const tasks = selectTasks(book, req)
  const parallel = Math.max(1, Math.floor(req.parallel ?? 1))
  mkdirSync(resolve(req.out, 'attempts'), { recursive: true })
  const attemptsPath = resolve(req.out, 'attempts.jsonl')
  if (record) {
    const ids = tasks.map((t) => t.task_id)
    if (ids.join('\n') !== record.tasks.join('\n')) throw new Error(`cannot resume ${runId}: the book's ${req.set} tasks no longer match run.json (${ids.length} vs ${record.tasks.length})`)
  } else {
    const { out: _out, resume: _resume, ...request } = req
    writeRunRecord(req.out, { runId, at: new Date().toISOString(), request, tasks: tasks.map((t) => t.task_id) })
  }
  log(`${runId}: ${record ? 'resume ' : ''}pack ${def.name} set ${req.set} (${tasks.length} tasks × ${req.repeat}) via loop ${req.loop} skill ${req.skillDir ?? deps.championSkillDir ?? def.skillDir} parallel ${parallel}`)
  if (deps.environments) log(`  environments: one per attempt on provider ${req.env ?? 'local'}`)

  // The work list in task × sample order; `slots[i]` receives row i so the result is ordered whatever finishes first.
  const items: { task: TaskLine; r: number }[] = []
  for (const task of tasks) for (let r = 0; r < req.repeat; r++) items.push({ task: task as TaskLine, r })
  const slots: (AttemptRow | undefined)[] = new Array(items.length).fill(undefined)
  const attemptDirOf = (attemptId: string) => resolve(req.out, 'attempts', attemptId)

  // Resume: an attempt with every marker and a row is done; its row is kept as is.
  // Everything else re-enters the pipeline, so attempts.jsonl is compacted to the
  // done rows first and the rest are appended again (one row per attempt).
  const done = new Map<string, AttemptRow>()
  if (record) {
    const prior = readAttemptsJsonl(attemptsPath)
    for (const { task, r } of items) {
      const attemptId = `${runId}-${sanitizeId(task.task_id)}-${r}`
      const row = prior.get(attemptId)
      if (row && isComplete(attemptDirOf(attemptId))) done.set(attemptId, row)
    }
    // Rewritten in the file's own (completion) order, so resuming a complete run leaves it byte-identical.
    writeFileSync(attemptsPath, [...prior.keys()].filter((id) => done.has(id)).map((id) => JSON.stringify(done.get(id)) + '\n').join(''))
    log(`  resume: ${done.size}/${items.length} attempts complete, ${items.length - done.size} to finish`)
  }
  const stages: Stages = { pack: new Semaphore(Math.min(parallel, PACK_STAGE_CAP)), ...(deps.signal ? { signal: deps.signal } : {}) }
  const writer = new WriterQueue()
  const writeErrors: string[] = []
  const counter = { done: 0, running: 0, failed: 0, total: items.length }
  const progress = () => `${counter.done}/${counter.total} done, ${counter.running} running, ${counter.failed} failed`
  const started = Date.now()
  const heartbeat = setInterval(() => {
    if (counter.running > 0) log(`  … ${progress()} (${Math.round((Date.now() - started) / 1000)}s)`)
  }, deps.heartbeatMs ?? HEARTBEAT_MS)
  heartbeat.unref?.()

  const sink = (row: AttemptRow) => writer.enqueue(async () => {
    appendFileSync(attemptsPath, JSON.stringify(row) + '\n')
    // The ledger keys attempts by id, so re-recording after a resume overwrites rather than duplicates.
    if (deps.ledger && challengerId && proposal) await recordInLedger(deps.ledger, row, challengerId, req.set, proposal.scorer_version)
    // The record marker closes the journal; an attempt without a loop marker (never materialized, or cancelled) stays open.
    const dir = attemptDirOf(row.attemptId)
    if (existsSync(stepPath(dir, 'loop'))) writeStep(dir, row.attemptId, 'record', { ledger: deps.ledger !== undefined })
  })

  try {
    await runPool(items, parallel, async ({ task, r }, i) => {
      const attemptId = `${runId}-${sanitizeId(task.task_id)}-${r}`
      const kept = done.get(attemptId)
      if (kept) {
        slots[i] = kept
        counter.done++
        if (kept.status === 'FAILED') counter.failed++
        return
      }
      counter.running++
      let row: AttemptRow
      try {
        row = await runOne(def, task, r, req, deps, runId, stages)
      } catch (e) {
        // runOne catches per stage; this is the belt for anything it did not expect.
        const provider = deps.loops.get(req.loop)
        row = emptyRow(`${runId}-${sanitizeId(task.task_id)}-${r}`, task, req.loop, provider ? factsSha(provider.harnessFacts) : '')
        row.error = `host: ${msg(e)}`
      }
      slots[i] = row
      counter.running--
      counter.done++
      if (row.status === 'FAILED') counter.failed++
      try {
        await sink(row)
      } catch (e) {
        writeErrors.push(`${row.attemptId}: ${msg(e)}`)
      }
      log(`  [${progress()}] ${row.attemptId}: ${row.status}/${row.stopReason} valid=${row.output.valid} ${row.error ?? ''}`.trimEnd())
    }, () => deps.signal?.aborted === true)
  } finally {
    clearInterval(heartbeat)
    await writer.drain()
  }
  if (writeErrors.length) log(`  ${writeErrors.length} row(s) failed to record: ${writeErrors.join('; ')}`)
  const rows = slots.filter((r): r is AttemptRow => r !== undefined)
  return { runId, pack: def.name, set: req.set, tasksetSha: book.tasksetSha(req.set), ...(challengerId ? { challengerId } : {}), rows, attemptsPath }
}
