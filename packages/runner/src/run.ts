// The runner core: tasks × repeat → materialize → loops.start → drain events →
// read/validate submit → pack truth → pack score → one attempts.jsonl row.
// Pure with respect to cordis: every dependency comes in through `RunDeps`,
// so tests drive it with fakes and the plugin (index.ts) only wires services.

import { createWriteStream, mkdirSync, readFileSync, appendFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createBook, type Book, type TaskSet } from '@samsara/book'
import { factsSha, type AttemptSpec, type FinishedEvent, type LoopEvent, type LoopProvider, type LoopRun, type TokenUsage } from '@samsara/loops'
import { loadPack, runCommand, validateSubmit, PackError, type PackDefinition, type TaskLine } from '@samsara/pack'
import { submitPath } from '@samsara/submit'
import { materialize as materializeWorkdir, SKILLS_DIR, type MaterializeOptions, type Workdir } from '@samsara/workdir'

/** The slice of `ctx.loops` the runner needs (structural, so tests pass a fake). */
export interface Loops {
  get(name: string): LoopProvider | undefined
  start(name: string, spec: AttemptSpec): Promise<LoopRun>
}

export type Materialize = (opts: MaterializeOptions) => Promise<Workdir>

export interface RunRequest {
  pack: string
  loop: string
  set: TaskSet
  limit?: number
  repeat: number
  out: string
  maxTurns: number
  maxMinutes: number
  allow?: string[]
}

export interface RouteConfig {
  provider: string
  model: string
  baseUrl?: string
  credentialRef: string
  reasoning?: Record<string, unknown>
}

export interface RunDeps {
  loops: Loops
  route: RouteConfig
  /** Defaults to @samsara/workdir's materialize; tests substitute. */
  materialize?: Materialize
  signal?: AbortSignal
  /** Injected for deterministic ids in tests. */
  runId?: string
  log?: (line: string) => void
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
 * @samsara/submit convention) and validate it against the pack contract.
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

function bookOf(def: PackDefinition): Book {
  return createBook({
    sets: { smoke: def.taskSets.smoke.tasks, holdin: def.taskSets.holdin.tasks, holdout: def.taskSets.holdout.tasks },
    entityKey: 'entity_key',
    holdoutPolicy: { mde: def.manifest.holdout?.mde ?? 0.05, budget: def.manifest.holdout?.budget ?? 0 },
  })
}

function failedFinish(at: number): FinishedEvent {
  return { t: 'finished', at, status: 'FAILED', stopReason: 'error', usage: { inputTokens: 0, outputTokens: 0 }, cost: { source: 'unknown' }, turns: 0, toolCalls: 0, artifacts: [] }
}

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

async function runOne(def: PackDefinition, task: TaskLine, r: number, req: RunRequest, deps: RunDeps, runId: string): Promise<AttemptRow> {
  const attemptId = `${runId}-${sanitizeId(task.task_id)}-${r}`
  const attemptsDir = resolve(req.out, 'attempts')
  const provider = deps.loops.get(req.loop)
  const facts_sha = provider ? factsSha(provider.harnessFacts) : ''
  const row: AttemptRow = {
    attemptId, task_id: task.task_id, loop: req.loop, facts_sha,
    status: 'FAILED', stopReason: 'host_error',
    usage: { inputTokens: 0, outputTokens: 0 }, cost: { source: 'unknown' }, toolCalls: 0,
    output: { valid: false }, truth: { status: 'error' }, scores: [],
  }

  let wd: Workdir
  try {
    wd = await (deps.materialize ?? materializeWorkdir)({
      attemptId, taskId: task.task_id, challengerId: 'champion', pack: def, baseDir: attemptsDir,
      skill: { name: def.manifest.skill.name, dir: def.skillDir },
      extraSkillDirs: ['.claude/skills'],
    })
  } catch (e) {
    row.error = `materialize: ${msg(e)}`
    return row
  }

  const controller = new AbortController()
  const onAbort = () => controller.abort(deps.signal?.reason)
  deps.signal?.addEventListener('abort', onAbort, { once: true })
  const spec: AttemptSpec = {
    attemptId, challengerId: 'champion', workdir: wd.path,
    skill: { name: def.manifest.skill.name, dir: resolve(wd.path, SKILLS_DIR, def.manifest.skill.name), sha: wd.skillSha },
    prompt: readFileSync(resolve(def.skillDir, 'SKILL.md'), 'utf8'),
    route: { ...deps.route },
    outputSchema: def.contractSchema,
    tools: { allow: req.allow ?? [], deny: def.denyPatterns, submitTool: { name: submitToolName(def), schema: def.contractSchema } },
    limits: { maxTurns: req.maxTurns, maxDurationMs: Math.round(req.maxMinutes * 60_000) },
    tmpdir: wd.tmpdir,
    signal: controller.signal,
  }

  let finished: FinishedEvent
  try {
    const run = await deps.loops.start(req.loop, spec)
    try {
      await drainEvents(run.events, resolve(attemptsDir, attemptId, 'events.jsonl'))
      finished = await run.result
    } finally {
      await run.dispose().catch(() => {})
    }
  } catch (e) {
    finished = failedFinish(Date.now())
    row.error = `loop: ${msg(e)}`
  } finally {
    deps.signal?.removeEventListener('abort', onAbort)
  }
  row.status = finished.status
  row.stopReason = finished.stopReason
  row.usage = finished.usage
  row.cost = finished.cost
  row.toolCalls = finished.toolCalls

  const sub = readSubmit(def, wd.path)
  row.output = { valid: sub.valid, ...(sub.file ? { file: sub.file } : {}), ...(sub.error ? { error: sub.error } : {}) }

  try {
    const [truth] = await runCommand(def, 'truth', [{ task_id: task.task_id, workdir: wd.path }], { env: { ...process.env, TMPDIR: wd.tmpdir } })
    if (!truth) throw new Error('truth returned no line')
    row.truth = { status: truth['status'] as 'settled' | 'pending', truth_sha: truth['truth_sha'] as string }
    if (truth['status'] === 'settled') {
      const output = {
        usage: { input_tokens: finished.usage.inputTokens, output_tokens: finished.usage.outputTokens, cost_usd: finished.cost.usd ?? null },
        cost_usd: finished.cost.usd ?? null,
        tool_calls: finished.toolCalls,
        submit: sub.valid ? sub.submit : null,
        valid: sub.valid,
        status: finished.status,
      }
      const scores = await runCommand(def, 'score', [{ task_id: task.task_id, truth: truth['truth'], output }], { env: { ...process.env, TMPDIR: wd.tmpdir } })
      row.scores = scores as unknown as ScoreLine[]
    }
  } catch (e) {
    row.truth = { status: 'error', error: msg(e) }
    row.error ??= `${(e as PackError).command ?? 'truth'}: ${msg(e)}`
  }
  return row
}

export async function runSet(req: RunRequest, deps: RunDeps): Promise<RunResult> {
  const def = loadPack(req.pack)
  const book = bookOf(def)
  const runId = deps.runId ?? newRunId()
  const log = deps.log ?? (() => {})
  const tasks = book.tasks(req.set).slice(0, req.limit ?? undefined)
  mkdirSync(resolve(req.out, 'attempts'), { recursive: true })
  const attemptsPath = resolve(req.out, 'attempts.jsonl')
  const rows: AttemptRow[] = []
  log(`${runId}: pack ${def.name} set ${req.set} (${tasks.length} tasks × ${req.repeat}) via loop ${req.loop}`)
  for (const task of tasks) {
    for (let r = 0; r < req.repeat; r++) {
      if (deps.signal?.aborted) break
      const row = await runOne(def, task as TaskLine, r, req, deps, runId)
      appendFileSync(attemptsPath, JSON.stringify(row) + '\n')
      rows.push(row)
      log(`  ${row.attemptId}: ${row.status}/${row.stopReason} valid=${row.output.valid} ${row.error ?? ''}`.trimEnd())
    }
  }
  return { runId, pack: def.name, set: req.set, tasksetSha: book.tasksetSha(req.set), rows, attemptsPath }
}
