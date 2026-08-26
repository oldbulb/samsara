// Adapter 'command': a proposer written in any language, run as one process
// per proposal under the directory-in / directory-out contract
// (examples/proposers/README.md):
//
//   <command> [args…] --view <viewDir> --out <workDir>
//
// The child reads the rendered view, writes `<workDir>/proposal.json` (and,
// for the skill surface, a skill directory) and exits 0; stderr is its log.
// Spawned through a spawn function the plugin binds to `ctx.subprocess.spawn`
// (E4) with an explicit environment (E5); a credential, when configured,
// reaches this module only as an already-resolved env map.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { type SubprocessHandle, type SubprocessSpawnSpec } from '@oldbulb/samsara-kernel'
import { apply as applySandbox, type SandboxHost } from '@oldbulb/samsara-sandbox'
import { canonicalJson, sha256, validateDraft, validateProposal, type Proposal, type ProposeInput, type ProposerAdapter } from './types.ts'
import { PROPOSAL_FILE, type SpawnFn } from './claude-p.ts'

export const DEFAULT_COMMAND_TIMEOUT_MS = 600_000
export const COMMAND_STDOUT_FILE = 'proposer.stdout.txt'
export const COMMAND_STDERR_FILE = 'proposer.stderr.txt'
const DEFAULT_GRACE_MS = 3_000
const COLLECT_MAX_BYTES = 8 * 1024 * 1024

export interface CommandConfig {
  /** Name the adapter registers under and stamps as `proposer.name`. */
  name: string
  command: string
  args?: string[]
  /** Stamped as `proposer.version`; the command's own versioning is opaque to the host. */
  version?: string
  timeoutMs?: number
  /** Grace between SIGTERM and SIGKILL. */
  graceMs?: number
  /** Extra child environment, explicit and hashed into config_sha (E5): the command sees nothing of the host shell beyond PATH/LANG. */
  env?: Record<string, string>
}

export interface CommandDeps {
  spawn: SpawnFn
  /** Env entries carrying the credential the plugin resolved (E5); empty when none is configured. */
  credentialEnv?: () => Promise<Record<string, string>>
  /** The sandbox host the run is wrapped for; defaults to the detected one. */
  host?: SandboxHost
}

export type ResolvedCommandConfig = Required<CommandConfig>

const PASSTHROUGH_ENV = ['PATH', 'LANG', 'LC_ALL'] as const

/** The host variables a command proposer may see (E5): a locale and a way to find its interpreter, nothing else. */
function passthroughEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const k of PASSTHROUGH_ENV) {
    const v = process.env[k]
    if (v !== undefined) env[k] = v
  }
  return env
}

export function resolveCommandConfig(config: CommandConfig): ResolvedCommandConfig {
  if (!config.name) throw new Error('proposers/command: name is required')
  if (!config.command) throw new Error('proposers/command: command is required')
  const out: ResolvedCommandConfig = {
    name: config.name,
    command: config.command,
    args: [...(config.args ?? [])],
    version: config.version ?? 'unknown',
    timeoutMs: config.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
    graceMs: config.graceMs ?? DEFAULT_GRACE_MS,
    env: { ...(config.env ?? {}) },
  }
  for (const k of ['timeoutMs', 'graceMs'] as const) {
    if (!(Number.isFinite(out[k]) && out[k] > 0)) throw new Error(`proposers/command: ${k} must be positive and finite`)
  }
  return out
}

export function commandArgvOf(config: Pick<ResolvedCommandConfig, 'command' | 'args'>, viewDir: string, outDir: string): string[] {
  return [config.command, ...config.args, '--view', viewDir, '--out', outDir]
}

function readCollected(handle: SubprocessHandle, stream: 'stdout' | 'stderr'): string {
  return handle.collected[stream]?.readFrom(0).text ?? ''
}

export class CommandAdapter implements ProposerAdapter {
  readonly name: string
  readonly version: string
  readonly configSha: string
  readonly config: ResolvedCommandConfig

  constructor(config: CommandConfig, private readonly deps: CommandDeps) {
    this.config = resolveCommandConfig(config)
    this.name = this.config.name
    this.version = this.config.version
    this.configSha = sha256(canonicalJson({ command: this.config.command, args: this.config.args, env: this.config.env }))
  }

  async propose(input: ProposeInput): Promise<Proposal> {
    if (input.signal.aborted) throw new Error(`proposers/${this.name}: aborted before startup`)
    const workDir = resolve(input.workDir)
    const viewDir = resolve(input.viewDir)
    mkdirSync(workDir, { recursive: true })
    // E5: explicit environment — PATH/LANG from the host, the configured extras (part of config_sha), the sandboxed HOME/TMPDIR and the resolved credential; never the parent env.
    const env = { ...passthroughEnv(), ...this.config.env, HOME: workDir, TMPDIR: workDir, ...(await this.deps.credentialEnv?.()) }
    // E9: confined where the host enforces; the view is read-only, the work directory writable.
    const spec: SubprocessSpawnSpec = {
      argv: commandArgvOf(this.config, viewDir, workDir),
      cwd: workDir,
      stdio: { stdin: 'ignore', stdout: { maxBytes: COLLECT_MAX_BYTES }, stderr: { maxBytes: COLLECT_MAX_BYTES } },
      graceMs: this.config.graceMs,
      env,
    }
    const handle = this.deps.spawn(this.deps.host === undefined ? applySandbox(spec, input.sandbox) : applySandbox(spec, input.sandbox, this.deps.host))

    let timedOut = false
    let aborted = false
    const timer = setTimeout(() => { timedOut = true; handle.terminate() }, this.config.timeoutMs)
    const onAbort = (): void => { aborted = true; handle.terminate() }
    input.signal.addEventListener('abort', onAbort, { once: true })
    let outcome
    try {
      outcome = await handle.done
    } finally {
      clearTimeout(timer)
      input.signal.removeEventListener('abort', onAbort)
    }
    writeFileSync(join(workDir, COMMAND_STDOUT_FILE), readCollected(handle, 'stdout'))
    writeFileSync(join(workDir, COMMAND_STDERR_FILE), readCollected(handle, 'stderr'))

    if (timedOut) throw new Error(`proposers/${this.name}: exceeded timeoutMs=${this.config.timeoutMs}`)
    if (aborted) throw new Error(`proposers/${this.name}: aborted`)
    if (outcome.exitCode !== 0) {
      throw new Error(`proposers/${this.name}: ${this.config.command} exited with code ${outcome.exitCode ?? 'null'} signal ${outcome.signal ?? 'none'}`)
    }
    return this.collect(workDir, input.parent)
  }

  private collect(workDir: string, parentFromInput: string | undefined): Proposal {
    const proposalPath = join(workDir, PROPOSAL_FILE)
    if (!existsSync(proposalPath)) throw new Error(`proposers/${this.name}: the proposer did not write ${PROPOSAL_FILE}`)
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(proposalPath, 'utf8'))
    } catch (error: unknown) {
      throw new Error(`proposers/${this.name}: ${PROPOSAL_FILE} is not JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
    const draft = validateDraft(raw)
    const parent = parentFromInput ?? draft.parent
    if (parent === undefined) throw new Error(`proposers/${this.name}: parent is required (input or draft)`)
    const proposer = { name: this.name, version: this.version, config_sha: this.configSha }
    if (draft.patch.surface !== 'skill') {
      return validateProposal({ parent, surface: draft.surface, patch: draft.patch, intent: draft.intent, prediction: draft.prediction, proposer })
    }
    const skillDir = isAbsolute(draft.patch.skill_dir) ? draft.patch.skill_dir : resolve(workDir, draft.patch.skill_dir)
    const rel = relative(workDir, skillDir)
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`proposers/${this.name}: skill_dir ${draft.patch.skill_dir} escapes the out directory`)
    if (!existsSync(skillDir) || !statSync(skillDir).isDirectory() || !existsSync(join(skillDir, 'SKILL.md'))) {
      throw new Error(`proposers/${this.name}: ${skillDir} is not a skill directory (no SKILL.md)`)
    }
    return validateProposal({
      parent,
      surface: 'skill',
      patch: { surface: 'skill', skill_dir: skillDir },
      intent: draft.intent,
      prediction: draft.prediction,
      proposer,
    })
  }
}
