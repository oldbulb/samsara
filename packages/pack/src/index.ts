// @oldbulb/samsara-pack — load a pack.yaml, run its commands as subprocesses, validate
// what comes back. The framework never imports pack code: every command is a
// child process speaking jsonl on stdin/stdout.

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve, dirname, isAbsolute } from 'node:path'
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

export interface TaskLine {
  task_id: string
  entity_key: string
  stratum?: string
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
  }
  holdout?: { mde?: number; budget?: number }
  surfaces?: Record<string, { globs?: string[]; config_keys?: string[] }>
  commands: Partial<Record<CommandName, string>> & { truth: string; score: string }
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
  commands: Partial<Record<CommandName, string>>
  surfaces: Record<string, SurfaceBoundary>
  denyPatterns: string[]
}

export interface RunOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  args?: string[]
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
      tasks.push(row as TaskLine)
    })
    taskSets[tier] = { path, tasks }
  }

  const commands: Partial<Record<CommandName, string>> = {}
  for (const [k, v] of Object.entries(m.commands)) if (typeof v === 'string') commands[k as CommandName] = v

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

/**
 * Run a pack command as a subprocess: `lines` go to stdin as jsonl, stdout is
 * parsed as jsonl and every line is validated against the schema for `name`.
 */
export function runCommand(
  def: PackDefinition,
  name: CommandName,
  lines: object[],
  opts: RunOptions = {},
): Promise<Record<string, unknown>[]> {
  const cmd = def.commands[name]
  if (!cmd) {
    return Promise.reject(new PackError('command-missing', `pack ${def.name} declares no "${name}" command`, { command: name }))
  }
  const cwd = opts.cwd ?? def.dir
  const validate = outputValidator(name)
  const input = lines.map((l) => JSON.stringify(l)).join('\n') + (lines.length ? '\n' : '')

  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, opts.args ?? [], {
      cwd,
      env: opts.env ?? process.env,
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
      let rows: Record<string, unknown>[]
      try {
        rows = parseJsonl(
          Buffer.concat(out).toString('utf8'),
          (lineNo, line, why) =>
            new PackError('invalid-line', `${name}: stdout line ${lineNo} ${why}`, { command: name, exitCode, lineNo, line, stderr }),
        )
      } catch (e) {
        reject(e)
        return
      }
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]!
        const why = validate(row)
        if (why) {
          reject(
            new PackError('invalid-line', `${name}: stdout line ${i + 1} invalid: ${why}`, {
              command: name, exitCode, lineNo: i + 1, line: JSON.stringify(row), stderr,
            }),
          )
          return
        }
      }
      resolvePromise(rows)
    }
    child.stdin.end(input)
  })
}
