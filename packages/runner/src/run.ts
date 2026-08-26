// The runner core: tasks × repeat → materialize → loops.start → drain events →
// read/validate submit → pack truth → pack score → one attempts.jsonl row.
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
import { attemptRowOf, sha256, canonicalJson, type ChallengerProposal, type Ledger, type Tier } from '@oldbulb/samsara-ledger'
import { factsSha, type AttemptSpec, type FinishedEvent, type LoopEvent, type LoopProvider, type LoopRun, type TokenUsage } from '@oldbulb/samsara-loops'
import { commandEnv, loadPack, runCommand, validateSubmit, PackError, type PackDefinition, type TaskLine } from '@oldbulb/samsara-pack'
import { envLock, findRepoRoot, type EnvLock } from '@oldbulb/samsara-scope'
import { policyFor } from '@oldbulb/samsara-sandbox'
import { submitPath } from '@oldbulb/samsara-submit'
import { materialize as materializeWorkdir, hashDir, policyPaths, SKILLS_DIR, TMP_DIR, type MaterializeOptions, type Workdir } from '@oldbulb/samsara-workdir'
import { Semaphore, WriterQueue, runPool } from './pool.ts'
import { isComplete, readRunRecord, readStep, stepPath, writeRunRecord, writeStep } from './steps.ts'

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
  cost: FinishedEvent['cost']
  toolCalls: number
  /** From the loop's finished event: 'inline' or the read fraction; absent when the loop did not report. */
  skillUtilization?: number | 'inline'
  output: { valid: boolean; file?: string; error?: string }
  truth: { status: 'settled' | 'pending' | 'error'; truth_sha?: string; error?: string }
  scores: ScoreLine[]
  /** Set when the host itself failed around the loop (materialize, truth, score); the loop's own failure is `status: FAILED`. */
  error?: string
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
  const attemptsDir = resolve(req.out, 'attempts')
  const skillDir = req.skillDir ?? deps.championSkillDir ?? def.skillDir
  const challengerId = deps.challengerId ?? 'champion'
  const provider = deps.loops.get(req.loop)
  const facts_sha = provider ? factsSha(provider.harnessFacts) : ''
  const row = emptyRow(attemptId, task, req.loop, facts_sha)
  const signal = stages.signal
  const attemptDir = resolve(attemptsDir, attemptId)
  // Durable steps: on resume a step whose marker exists is skipped. A finished
  // loop is never re-run; an attempt without a loop marker starts from scratch.
  const loopDone = req.resume ? readStep(attemptDir, 'loop') : undefined

  let wd: Pick<Workdir, 'path' | 'tmpdir' | 'skillSha'>
  if (loopDone) {
    const mat = readStep(attemptDir, 'materialize')
    wd = { path: attemptDir, tmpdir: resolve(attemptDir, mat?.tmpdir ?? TMP_DIR), skillSha: mat?.skillSha ?? '' }
  } else {
    if (req.resume && existsSync(attemptDir)) rmSync(attemptDir, { recursive: true, force: true })
    try {
      wd = await stages.pack.run(() => (deps.materialize ?? materializeWorkdir)({
        attemptId, taskId: task.task_id, challengerId, sample: r, pack: def, baseDir: attemptsDir,
        skill: { name: def.manifest.skill.name, dir: skillDir },
        extraSkillDirs: ['.claude/skills'],
      }))
      writeStep(attemptDir, attemptId, 'materialize', { tmpdir: relative(wd.path, wd.tmpdir), skillSha: wd.skillSha })
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
      limits: { maxTurns: req.maxTurns, maxDurationMs: Math.round(req.maxMinutes * 60_000) },
      tmpdir: wd.tmpdir,
      signal: controller.signal,
      // E9: the loop's subprocesses see the workdir, the pack's skill/ and loader/, and its runtimes; enforced on Linux only.
      sandbox: policyFor({ ...policyPaths(wd.path, def), homeDir: homedir() }),
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
  row.cost = finished.cost
  row.toolCalls = finished.toolCalls
  if (finished.skillUtilization !== undefined) row.skillUtilization = finished.skillUtilization

  const submitDone = loopDone ? readStep(attemptDir, 'submit') : undefined
  const sub: SubmitRead = submitDone ?? readSubmit(def, wd.path)
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
    // E5/E8: the judge sees the pack's declared environment and the attempt's TMPDIR, never the host's credentials.
    const env = commandEnv(def, { TMPDIR: wd.tmpdir })
    let truthValue: unknown
    if (truthDone) {
      row.truth = truthDone.truth
      truthValue = truthDone.value
    } else {
      const [truth] = await stages.pack.run(() => runCommand(def, 'truth', [{ task_id: task.task_id, workdir: wd.path }], { env }))
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
        const scores = await stages.pack.run(() => runCommand(def, 'score', [{ task_id: task.task_id, truth: truthValue, output }], { env }))
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
  const limits = { maxTurns: req.maxTurns, maxDurationMs: Math.round(req.maxMinutes * 60_000) }
  const effort = deps.route.reasoning?.['effort']
  const skill_sha = hashDir(req.skillDir ?? deps.championSkillDir ?? def.skillDir)
  return {
    parent_ids: [],
    patch_sha: NONE_SHA,
    harness_sha,
    // The lock-file fingerprint plus the route and limits this deployment runs
    // under. `baseUrlKind` is only how the route is labelled in the ledger, so
    // it stays out: relabelling must not make earlier rows incomparable.
    env_sha: sha256(canonicalJson({ env_lock: lock.sha, route: envRoute(deps.route), limits })),
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
    runtime: { timeout_s: Math.round(req.maxMinutes * 60), step_cap: req.maxTurns },
    tasksets: { smoke: book.tasksetSha('smoke'), holdin: book.tasksetSha('holdin'), holdout: book.tasksetSha('holdout') },
    budget: def.manifest.holdout?.budget ?? 0,
  }
}

async function recordInLedger(ledger: LedgerSink, row: AttemptRow, challengerId: string, tier: Tier, scorerVersion: string): Promise<void> {
  await ledger.recordAttempt({
    ...attemptRowOf(row, { challengerId, loop: row.loop, tier, scorerVersion }),
    ...(row.skillUtilization !== undefined ? { skill_utilization: { value: row.skillUtilization } } : {}),
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
