// @oldbulb/samsara-pack — load a pack.yaml, run its commands as subprocesses, validate
// what comes back. The framework never imports pack code: every command is a
// child process speaking jsonl on stdin/stdout.

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve, dirname, isAbsolute, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Ajv2020, type ValidateFunction, type ErrorObject } from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { parse as parseYaml } from 'yaml'

// ---------------------------------------------------------------- types

export type TruthLatency = 'immediate' | 'delayed'
export type Tier = 'smoke' | 'holdin' | 'holdout'
export type CommandName = 'truth' | 'score' | 'data' | 'materialize'

export interface SurfaceBoundary {
  globs: string[]
  config_keys: string[]
}

/** Where attempts and `in_environment` commands run, as pack.yaml (and a task row's `environment` column) writes it. */
export interface PackEnvironment {
  image?: string
  dockerfile?: string
  resources?: { cpus?: number; memory_mb?: number; timeout_s?: number }
  network?: 'none' | 'allowlist' | 'public'
  allowed_hosts?: string[]
}

/** A command as pack.yaml writes it: a shell line, or `{ run, in_environment }`. */
export type CommandDeclaration = string | { run: string; in_environment?: boolean }

/** A command as the loader normalizes it. */
export interface CommandSpec {
  run: string
  inEnvironment: boolean
}

export interface TaskLine {
  task_id: string
  entity_key: string
  stratum?: string
  /** Overrides the pack's `environment` for this task; passed through untouched. */
  environment?: PackEnvironment
  [k: string]: unknown
}

/** pack.yaml as written, after schema validation (paths still relative). */
export interface PackManifest {
  name: string
  truth_latency: TruthLatency
  skill: { dir: string; name: string }
  contract: string
  tasks: {
    sets: Record<Tier, string>
    entity_key: string
    version?: number
    stratum_key?: string
    protocol?: { stage?: string; contracts?: string[] }
  }
  metrics?: { primary: { name: string; unit?: string; direction?: 'up' | 'down' }; cost?: string }
  /** What the commands and the attempts execute from: read-only roots for the sandbox, the globs of the files that pin them (hashed into env_sha), and the host environment names the commands may see. */
  runtime?: { dirs?: string[]; locks?: string[]; env?: string[] }
  holdout?: { mde?: number; budget?: number; retention_tolerance?: number; auto_demote?: boolean }
  surfaces?: Record<string, { globs?: string[]; config_keys?: string[] }>
  /** The pack's default environment; undeclared, the provider's default (local: the host). */
  environment?: PackEnvironment
  commands: Partial<Record<CommandName, CommandDeclaration>> & { truth: CommandDeclaration; score: CommandDeclaration }
  guards?: { deny_patterns?: string[] }
}

/** Resolved view of a pack: absolute paths, loaded contract, parsed task sets. */
export interface PackDefinition {
  dir: string
  manifest: PackManifest
  name: string
  truthLatency: TruthLatency
  skillDir: string
  contractPath: string
  contractSchema: Record<string, unknown>
  taskSets: Record<Tier, { path: string; tasks: TaskLine[] }>
  /** Each command's shell line, whichever form the manifest used. */
  commands: Partial<Record<CommandName, string>>
  /** Each command normalized: its line and whether it runs inside the environment. */
  commandSpecs: Partial<Record<CommandName, CommandSpec>>
  surfaces: Record<string, SurfaceBoundary>
  denyPatterns: string[]
}

/** How an `in_environment` command reaches its environment: the caller binds `Environment.exec` here. */
export type CommandExec = (
  argv: string[],
  stdin: string,
  opts: { cwd?: string; env: Record<string, string>; timeoutMs: number },
) => Promise<{ code: number | null; signal?: string; stdout: string; stderr: string }>

export interface RunOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  args?: string[]
  /** Runs an `in_environment` command; without it such a command is refused (`spawn`). Commands not so marked always run on the host. */
  exec?: CommandExec
}

export type PackErrorCode =
  | 'manifest'
  | 'contract'
  | 'tasks'
  | 'command-missing'
  | 'spawn'
  | 'exit'
  | 'timeout'
  | 'invalid-line'
  | 'submit'

export class PackError extends Error {
  override readonly name = 'PackError'
  readonly code: PackErrorCode
  readonly command: string | undefined
  readonly exitCode: number | null | undefined
  readonly signal: NodeJS.Signals | null | undefined
  readonly lineNo: number | undefined
  readonly line: string | undefined
  readonly stderr: string | undefined
  readonly errors: ErrorObject[] | undefined

  constructor(
    code: PackErrorCode,
    message: string,
    extra: {
      command?: string
      exitCode?: number | null
      signal?: NodeJS.Signals | null
      lineNo?: number
      line?: string
      stderr?: string
      errors?: ErrorObject[] | null | undefined
    } = {},
  ) {
    super(message)
    this.code = code
    this.command = extra.command
    this.exitCode = extra.exitCode
    this.signal = extra.signal
    this.lineNo = extra.lineNo
    this.line = extra.line
    this.stderr = extra.stderr
    this.errors = extra.errors ?? undefined
  }
}

// ---------------------------------------------------------------- schemas

const SCHEMA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'schema')

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

function newAjv(): Ajv2020 {
  const ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true })
  addFormats.default ? addFormats.default(ajv) : (addFormats as unknown as (a: Ajv2020) => void)(ajv)
  return ajv
}

let cachedValidators: Record<'pack' | 'truth' | 'score', ValidateFunction> | undefined

function builtinValidators() {
  if (!cachedValidators) {
    const ajv = newAjv()
    cachedValidators = {
      pack: ajv.compile(readJson(resolve(SCHEMA_DIR, 'pack.schema.json'))),
      truth: ajv.compile(readJson(resolve(SCHEMA_DIR, 'truth-output.schema.json'))),
      score: ajv.compile(readJson(resolve(SCHEMA_DIR, 'score-output.schema.json'))),
    }
  }
  return cachedValidators
}

function formatErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors?.length) return 'unknown validation error'
  return errors.map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`.trim()).join('; ')
}

// ---------------------------------------------------------------- jsonl

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Parse jsonl text; `onBad(lineNo, raw, why)` is invoked for the first bad line and its result thrown. */
function parseJsonl(text: string, onBad: (lineNo: number, raw: string, why: string) => Error): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? ''
    if (raw.trim() === '') continue
    let v: unknown
    try {
      v = JSON.parse(raw)
    } catch (e) {
      throw onBad(i + 1, raw, `not JSON: ${(e as Error).message}`)
    }
    if (!isRecord(v)) throw onBad(i + 1, raw, 'not a JSON object')
    out.push(v)
  }
  return out
}

// ---------------------------------------------------------------- loadPack

export function loadPack(dir: string): PackDefinition {
  const packDir = resolve(dir)
  const manifestPath = resolve(packDir, 'pack.yaml')
  if (!existsSync(manifestPath)) throw new PackError('manifest', `no pack.yaml in ${packDir}`)

  let manifest: unknown
  try {
    manifest = parseYaml(readFileSync(manifestPath, 'utf8'))
  } catch (e) {
    throw new PackError('manifest', `${manifestPath}: ${(e as Error).message}`)
  }
  const { pack: validatePackSchema } = builtinValidators()
  if (!validatePackSchema(manifest)) {
    throw new PackError('manifest', `${manifestPath}: ${formatErrors(validatePackSchema.errors)}`, {
      errors: validatePackSchema.errors,
    })
  }
  const m = manifest as PackManifest
  const abs = (p: string) => (isAbsolute(p) ? p : resolve(packDir, p))

  const contractPath = abs(m.contract)
  if (!existsSync(contractPath)) throw new PackError('contract', `contract schema not found: ${contractPath}`)
  let contractSchema: Record<string, unknown>
  try {
    contractSchema = readJson(contractPath)
  } catch (e) {
    throw new PackError('contract', `${contractPath}: ${(e as Error).message}`)
  }
  try {
    newAjv().compile(contractSchema)
  } catch (e) {
    throw new PackError('contract', `${contractPath}: not a valid JSON schema: ${(e as Error).message}`)
  }

  const taskSets = {} as PackDefinition['taskSets']
  for (const tier of ['smoke', 'holdin', 'holdout'] as const) {
    const path = abs(m.tasks.sets[tier])
    if (!existsSync(path)) throw new PackError('tasks', `task set ${tier} not found: ${path}`)
    const rows = parseJsonl(
      readFileSync(path, 'utf8'),
      (lineNo, line, why) => new PackError('tasks', `${path}:${lineNo}: ${why}`, { lineNo, line }),
    )
    const tasks: TaskLine[] = []
    rows.forEach((row, i) => {
      const bad = (why: string) =>
        new PackError('tasks', `${path}:${i + 1}: ${why}`, { lineNo: i + 1, line: JSON.stringify(row) })
      if (typeof row['task_id'] !== 'string' || row['task_id'] === '') throw bad('task_id must be a non-empty string')
      if (typeof row['entity_key'] !== 'string' || row['entity_key'] === '') throw bad('entity_key must be a non-empty string')
      if (row['stratum'] !== undefined && typeof row['stratum'] !== 'string') throw bad('stratum must be a string when present')
      if (row['environment'] !== undefined && !isRecord(row['environment'])) throw bad('environment must be an object when present')
      tasks.push(row as TaskLine)
    })
    taskSets[tier] = { path, tasks }
  }

  const commands: Partial<Record<CommandName, string>> = {}
  const commandSpecs: Partial<Record<CommandName, CommandSpec>> = {}
  for (const [k, v] of Object.entries(m.commands) as [CommandName, CommandDeclaration | undefined][]) {
    if (v === undefined) continue
    const spec = typeof v === 'string' ? { run: v, inEnvironment: false } : { run: v.run, inEnvironment: v.in_environment ?? false }
    commands[k] = spec.run
    commandSpecs[k] = spec
  }

  return {
    dir: packDir,
    manifest: m,
    name: m.name,
    truthLatency: m.truth_latency,
    skillDir: abs(m.skill.dir),
    contractPath,
    contractSchema,
    taskSets,
    commands,
    commandSpecs,
    surfaces: surfaceBoundariesOf(m),
    denyPatterns: m.guards?.deny_patterns ?? [],
  }
}

// ---------------------------------------------------------------- surfaces

function surfaceBoundariesOf(m: PackManifest): Record<string, SurfaceBoundary> {
  const out: Record<string, SurfaceBoundary> = {}
  for (const [name, b] of Object.entries(m.surfaces ?? {})) {
    out[name] = { globs: [...(b.globs ?? [])], config_keys: [...(b.config_keys ?? [])] }
  }
  return out
}

/** Declared machine-checkable boundary per surface this pack exposes. */
export function surfaceBoundaries(def: PackDefinition): Record<string, SurfaceBoundary> {
  return surfaceBoundariesOf(def.manifest)
}

// ---------------------------------------------------------------- protected paths

/**
 * What no attempt, proposer or patch may reach, as the manifest declares it:
 * the manifest itself, the contract, the task sets, and every file a command
 * line names inside the pack (its judge). Pack-relative posix paths, sorted.
 */
export function protectedPaths(def: Pick<PackDefinition, 'dir' | 'contractPath' | 'taskSets' | 'commands'>): string[] {
  const dir = resolve(def.dir)
  const rel = (abs: string): string | undefined => {
    const r = relative(dir, abs)
    return r === '' || r.startsWith('..') || isAbsolute(r) ? undefined : r.split(sep).join('/')
  }
  const out = new Set<string>(['pack.yaml'])
  const add = (abs: string) => { const r = rel(abs); if (r !== undefined) out.add(r) }
  add(def.contractPath)
  for (const set of Object.values(def.taskSets)) add(set.path)
  for (const cmd of Object.values(def.commands)) {
    for (const token of cmd.split(/\s+/)) {
      if (token === '') continue
      const abs = resolve(dir, token)
      if (existsSync(abs)) add(abs)
    }
  }
  return [...out].sort()
}

// ---------------------------------------------------------------- validateSubmit

/** How long `exit` waits for the pipes to close before settling the call anyway. */
const DRAIN_AFTER_EXIT_MS = 500

const contractValidators = new WeakMap<PackDefinition, ValidateFunction>()

/** Validate a structured submit object against the pack's contract schema. Throws PackError('submit'). */
export function validateSubmit(def: PackDefinition, obj: unknown): void {
  let v = contractValidators.get(def)
  if (!v) {
    v = newAjv().compile(def.contractSchema)
    contractValidators.set(def, v)
  }
  if (!v(obj)) {
    throw new PackError('submit', `submit does not satisfy ${def.contractPath}: ${formatErrors(v.errors)}`, {
      errors: v.errors,
    })
  }
}

// ---------------------------------------------------------------- runCommand

/** Host environment names every pack command sees; everything else (credentials, harness identity, the operator's shell) is withheld (E5/E8). */
export const COMMAND_ENV_ALLOWLIST: readonly string[] = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM', 'TMPDIR']

/**
 * The environment a pack command runs under: the allow-list above plus the
 * names the pack declares in `runtime.env`, read from `source` (the host's
 * `process.env`), with `extra` layered last (the per-attempt `TMPDIR`). Never
 * the host's whole environment.
 */
export function commandEnv(def: Pick<PackDefinition, 'manifest'>, extra: Record<string, string> = {}, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of [...COMMAND_ENV_ALLOWLIST, ...(def.manifest.runtime?.env ?? [])]) {
    const value = source[name]
    if (value !== undefined) env[name] = value
  }
  return { ...env, ...extra }
}

function outputValidator(name: string): (line: Record<string, unknown>) => string | undefined {
  const v = builtinValidators()
  if (name === 'truth') return (l) => (v.truth(l) ? undefined : formatErrors(v.truth.errors))
  if (name === 'score') return (l) => (v.score(l) ? undefined : formatErrors(v.score.errors))
  if (name === 'materialize')
    return (l) => {
      if (typeof l['task_id'] !== 'string') return 'task_id must be a string'
      if (typeof l['ok'] !== 'boolean') return 'ok must be a boolean'
      return undefined
    }
  return () => undefined
}

/** Bounds an `in_environment` command when neither the caller nor the pack's `environment.resources.timeout_s` says. */
const IN_ENVIRONMENT_TIMEOUT_MS = 60 * 60 * 1000

/** Parse and validate a finished command's stdout; the exit code is already known to be zero. */
function settle(
  name: CommandName,
  stdout: string,
  stderr: string,
  validate: (line: Record<string, unknown>) => string | undefined,
): Record<string, unknown>[] {
  const rows = parseJsonl(
    stdout,
    (lineNo, line, why) =>
      new PackError('invalid-line', `${name}: stdout line ${lineNo} ${why}`, { command: name, exitCode: 0, lineNo, line, stderr }),
  )
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!
    const why = validate(row)
    if (why) {
      throw new PackError('invalid-line', `${name}: stdout line ${i + 1} invalid: ${why}`, {
        command: name, exitCode: 0, lineNo: i + 1, line: JSON.stringify(row), stderr,
      })
    }
  }
  return rows
}

/**
 * Run a pack command: `lines` go to stdin as jsonl, stdout is parsed as jsonl
 * and every line is validated against the schema for `name`. A command the
 * manifest marks `in_environment` runs through `opts.exec` (the attempt's
 * environment) with the same protocol; every other command is a subprocess
 * on the host.
 */
export function runCommand(
  def: PackDefinition,
  name: CommandName,
  lines: object[],
  opts: RunOptions = {},
): Promise<Record<string, unknown>[]> {
  const spec = def.commandSpecs[name]
  if (!spec) {
    return Promise.reject(new PackError('command-missing', `pack ${def.name} declares no "${name}" command`, { command: name }))
  }
  const validate = outputValidator(name)
  const input = lines.map((l) => JSON.stringify(l)).join('\n') + (lines.length ? '\n' : '')
  if (spec.inEnvironment) {
    if (!opts.exec) {
      const where = def.manifest.environment?.image ?? def.manifest.environment?.dockerfile ?? "the provider's default"
      return Promise.reject(new PackError('spawn', `${name}: runs in the pack's environment (${where}) but none was given`, { command: name }))
    }
    return runInEnvironment(spec, name, input, opts.exec, opts, def.manifest.environment, validate)
  }
  return runOnHost(spec, name, input, def, opts, validate)
}

/**
 * The line protocol over an environment's `exec`: the command line and its
 * args go through the environment's shell, the cwd is the environment's own
 * unless given, and the env is what the caller passes on top of the
 * environment's (E5: never the host's). A null exit code is the time limit.
 */
async function runInEnvironment(
  spec: CommandSpec,
  name: CommandName,
  input: string,
  exec: CommandExec,
  opts: RunOptions,
  environment: PackEnvironment | undefined,
  validate: (line: Record<string, unknown>) => string | undefined,
): Promise<Record<string, unknown>[]> {
  const timeoutMs = opts.timeoutMs ?? (environment?.resources?.timeout_s !== undefined ? environment.resources.timeout_s * 1000 : IN_ENVIRONMENT_TIMEOUT_MS)
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(opts.env ?? {})) if (v !== undefined) env[k] = v
  let result: Awaited<ReturnType<CommandExec>>
  try {
    result = await exec(['sh', '-c', [spec.run, ...(opts.args ?? [])].join(' ')], input, {
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      env,
      timeoutMs,
    })
  } catch (e) {
    throw new PackError('spawn', `${name}: ${(e as Error).message}`, { command: name })
  }
  if (result.code === null) {
    const signal = result.signal as NodeJS.Signals | undefined
    const timedOut = signal === undefined || signal === 'SIGKILL'
    throw new PackError(
      timedOut ? 'timeout' : 'exit',
      `${name}: ${timedOut ? `timed out after ${timeoutMs}ms` : `killed by ${signal}`}`,
      { command: name, exitCode: null, signal: signal ?? null, stderr: result.stderr },
    )
  }
  if (result.code !== 0) {
    throw new PackError('exit', `${name}: exited with code ${result.code}${result.stderr ? `: ${result.stderr.trim()}` : ''}`, {
      command: name, exitCode: result.code, signal: null, stderr: result.stderr,
    })
  }
  return settle(name, result.stdout, result.stderr, validate)
}

function runOnHost(
  spec: CommandSpec,
  name: CommandName,
  input: string,
  def: PackDefinition,
  opts: RunOptions,
  validate: (line: Record<string, unknown>) => string | undefined,
): Promise<Record<string, unknown>[]> {
  const cwd = opts.cwd ?? def.dir

  return new Promise((resolvePromise, reject) => {
    const child = spawn(spec.run, opts.args ?? [], {
      cwd,
      env: opts.env ?? commandEnv(def),
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs, killSignal: 'SIGKILL' as const } : {}),
    })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout.on('data', (b: Buffer) => out.push(b))
    child.stderr.on('data', (b: Buffer) => err.push(b))
    child.on('error', (e) => reject(new PackError('spawn', `${name}: ${e.message}`, { command: name })))
    child.stdin.on('error', () => {}) // EPIPE when the command exits early; surfaced via exit code
    // `close` waits for every writer on the pipes, so a command that leaves a
    // grandchild holding stdout (a shell that forked, a runner that spawned a
    // helper) would keep this promise pending forever — a timeout would fire
    // inside the command and never be reported. `exit` always fires, so it
    // settles the call after a short drain if `close` does not follow. Killing
    // the command does not reap such a grandchild; the caller sees the verdict,
    // the stray process is the operating system's to clean up.
    let settled = false
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return
      settled = true
      onClose(exitCode, signal)
    }
    child.on('exit', (exitCode, signal) => { setTimeout(() => finish(exitCode, signal), DRAIN_AFTER_EXIT_MS).unref() })
    child.on('close', (exitCode, signal) => { finish(exitCode, signal) })
    const onClose = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      const stderr = Buffer.concat(err).toString('utf8')
      if (signal) {
        const timedOut = opts.timeoutMs !== undefined && signal === 'SIGKILL'
        reject(
          new PackError(
            timedOut ? 'timeout' : 'exit',
            `${name}: ${timedOut ? `timed out after ${opts.timeoutMs}ms` : `killed by ${signal}`}`,
            { command: name, exitCode, signal, stderr },
          ),
        )
        return
      }
      if (exitCode !== 0) {
        reject(new PackError('exit', `${name}: exited with code ${exitCode}${stderr ? `: ${stderr.trim()}` : ''}`, {
          command: name, exitCode, signal, stderr,
        }))
        return
      }
      try {
        resolvePromise(settle(name, Buffer.concat(out).toString('utf8'), stderr, validate))
      } catch (e) {
        reject(e)
      }
    }
    child.stdin.end(input)
  })
}
