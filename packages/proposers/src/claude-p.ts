// Adapter 'claude-p': one `claude -p` process per proposal, spawned through a
// spawn function the plugin binds to `ctx.subprocess.spawn`, with an explicit
// child environment (E5/E6). The credential reaches this module only as an
// already-resolved env map and is never logged or written anywhere.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Schema, scrubbedParentEnv, type SubprocessHandle, type SubprocessSpawnSpec } from '@oldbulb/samsara-kernel'
import { apply as applySandbox, type SandboxHost } from '@oldbulb/samsara-sandbox'
import {
  PROPOSAL_DRAFT_SCHEMA,
  canonicalJson,
  sha256,
  validateDraft,
  validateProposal,
  type Proposal,
  type ProposeInput,
  type ProposerAdapter,
} from './types.ts'

export const CLAUDE_P_NAME = 'claude-p'
export const PROPOSAL_FILE = 'proposal.json'
export const SKILL_DIR = 'skill'
export const CONFIG_DIR_NAME = '.claude-config'
export const STDOUT_FILE = 'claude-p.stdout.json'
export const STDERR_FILE = 'claude-p.stderr.txt'
export const DEFAULT_TEMPLATE = fileURLToPath(new URL('../templates/propose.md', import.meta.url))

const DEFAULT_COMMAND = 'claude'
const DEFAULT_MAX_TURNS = 25
const DEFAULT_TIMEOUT_MS = 600_000
const DEFAULT_GRACE_MS = 3_000
const COLLECT_MAX_BYTES = 8 * 1024 * 1024

export interface Config {
  command?: string
  args?: string[]
  model?: string
  baseUrl?: string
  /** Credential reference the plugin resolves into ANTHROPIC_AUTH_TOKEN. */
  credentialRef?: string
  maxTurns?: number
  timeoutMs?: number
  /** Path to a prompt template; defaults to the one shipped with the package. */
  promptTemplate?: string
  /** Grace between SIGTERM and SIGKILL. */
  graceMs?: number
}

export const Config: Schema<Config> = Schema.object({
  command: Schema.string().default(DEFAULT_COMMAND),
  args: Schema.array(Schema.string()).default([]),
  model: Schema.string(),
  baseUrl: Schema.string(),
  credentialRef: Schema.string(),
  maxTurns: Schema.number().default(DEFAULT_MAX_TURNS),
  timeoutMs: Schema.number().default(DEFAULT_TIMEOUT_MS),
  promptTemplate: Schema.string(),
  graceMs: Schema.number().default(DEFAULT_GRACE_MS),
})

export type ResolvedConfig = Required<Pick<Config, 'command' | 'args' | 'maxTurns' | 'timeoutMs' | 'graceMs' | 'promptTemplate'>> &
  Pick<Config, 'model' | 'baseUrl' | 'credentialRef'>

export function resolveConfig(config: Config): ResolvedConfig {
  const out: ResolvedConfig = {
    command: config.command ?? DEFAULT_COMMAND,
    args: config.args ?? [],
    maxTurns: config.maxTurns ?? DEFAULT_MAX_TURNS,
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    graceMs: config.graceMs ?? DEFAULT_GRACE_MS,
    promptTemplate: config.promptTemplate ?? DEFAULT_TEMPLATE,
  }
  if (config.model !== undefined) out.model = config.model
  if (config.baseUrl !== undefined) out.baseUrl = config.baseUrl
  if (config.credentialRef !== undefined) out.credentialRef = config.credentialRef
  for (const k of ['maxTurns', 'timeoutMs', 'graceMs'] as const) {
    if (!(Number.isFinite(out[k]) && out[k] > 0)) throw new Error(`proposers/claude-p: ${k} must be positive and finite`)
  }
  return out
}

export type SpawnFn = (spec: SubprocessSpawnSpec) => SubprocessHandle

export interface ClaudePDeps {
  spawn: SpawnFn
  /** Resolves the credential into the env entries the child needs (ANTHROPIC_AUTH_TOKEN). Empty when none is configured. */
  credentialEnv: () => Promise<Record<string, string>>
  /** The sandbox host the proposal run is wrapped for; defaults to the detected one. */
  host?: SandboxHost
}

/** Explicit child environment (E5/E6) minus the credential; pure. */
export function buildEnv(config: Pick<ResolvedConfig, 'model' | 'baseUrl'>, workDir: string): Record<string, string> {
  const env: Record<string, string> = {
    CLAUDE_CONFIG_DIR: join(workDir, CONFIG_DIR_NAME),
    HOME: workDir,
    TMPDIR: workDir,
    DISABLE_TELEMETRY: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  }
  if (config.baseUrl !== undefined) env['ANTHROPIC_BASE_URL'] = config.baseUrl
  if (config.model !== undefined) {
    env['ANTHROPIC_MODEL'] = config.model
    env['ANTHROPIC_SMALL_FAST_MODEL'] = config.model
  }
  return env
}

export function renderPrompt(template: string, input: Pick<ProposeInput, 'viewDir' | 'workDir'>): string {
  const vars: Record<string, string> = {
    viewDir: input.viewDir,
    workDir: input.workDir,
    schema: JSON.stringify(PROPOSAL_DRAFT_SCHEMA, null, 2),
  }
  return template.replace(/\{\{(\w+)\}\}/g, (m, k: string) => vars[k] ?? m)
}

export function argvOf(config: Pick<ResolvedConfig, 'command' | 'args' | 'maxTurns'>, prompt: string): string[] {
  return [
    config.command,
    ...config.args,
    '-p', prompt,
    '--output-format', 'json',
    '--max-turns', String(config.maxTurns),
    '--permission-mode', 'bypassPermissions',
  ]
}

function parseVersion(text: string): string {
  return /(\d+\.\d+\.\d+[\w.-]*)/.exec(text)?.[1] ?? 'unknown'
}

function readCollected(handle: SubprocessHandle, stream: 'stdout' | 'stderr'): string {
  return handle.collected[stream]?.readFrom(0).text ?? ''
}

export class ClaudePAdapter implements ProposerAdapter {
  readonly name = CLAUDE_P_NAME
  version = 'unknown'
  readonly configSha: string
  readonly config: ResolvedConfig
  readonly template: string
  readonly templateSha: string
  private versionProbe: Promise<string> | undefined

  constructor(config: Config, private readonly deps: ClaudePDeps) {
    this.config = resolveConfig(config)
    this.template = readFileSync(this.config.promptTemplate, 'utf8')
    this.templateSha = sha256(this.template)
    const { credentialRef: _ref, ...hashed } = this.config
    this.configSha = sha256(canonicalJson({ ...hashed, promptTemplate: this.templateSha }))
  }

  /** `<command> --version`, once; 'unknown' when it cannot be parsed. */
  probeVersion(): Promise<string> {
    this.versionProbe ??= (async () => {
      try {
        const handle = this.deps.spawn({
          argv: [this.config.command, '--version'],
          cwd: process.cwd(),
          stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
          graceMs: this.config.graceMs,
          env: { ...scrubbedParentEnv(), DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
        })
        const timer = setTimeout(() => handle.terminate(), 15_000)
        const outcome = await handle.done
        clearTimeout(timer)
        this.version = outcome.exitCode === 0 ? parseVersion(readCollected(handle, 'stdout')) : 'unknown'
      } catch {
        this.version = 'unknown'
      }
      return this.version
    })()
    return this.versionProbe
  }

  async propose(input: ProposeInput): Promise<Proposal> {
    if (input.signal.aborted) throw new Error('proposers/claude-p: aborted before startup')
    const workDir = resolve(input.workDir)
    mkdirSync(join(workDir, CONFIG_DIR_NAME), { recursive: true })
    await this.probeVersion()

    const prompt = renderPrompt(this.template, { viewDir: resolve(input.viewDir), workDir })
    const env = { ...scrubbedParentEnv(), ...buildEnv(this.config, workDir), ...(await this.deps.credentialEnv()) }
    // E9: the proposal run is confined where the host enforces; the version probe above is not (no prompt, no view).
    const spec: SubprocessSpawnSpec = {
      argv: argvOf(this.config, prompt),
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
    writeFileSync(join(workDir, STDOUT_FILE), readCollected(handle, 'stdout'))
    writeFileSync(join(workDir, STDERR_FILE), readCollected(handle, 'stderr'))

    if (timedOut) throw new Error(`proposers/claude-p: exceeded timeoutMs=${this.config.timeoutMs}`)
    if (aborted) throw new Error('proposers/claude-p: aborted')
    if (outcome.exitCode !== 0) {
      throw new Error(`proposers/claude-p: ${this.config.command} exited with code ${outcome.exitCode ?? 'null'} signal ${outcome.signal ?? 'none'}`)
    }
    return this.collect(workDir, input.parent)
  }

  private collect(workDir: string, parentFromInput: string | undefined): Proposal {
    const proposalPath = join(workDir, PROPOSAL_FILE)
    if (!existsSync(proposalPath)) throw new Error(`proposers/claude-p: the proposer did not write ${PROPOSAL_FILE}`)
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(proposalPath, 'utf8'))
    } catch (error: unknown) {
      throw new Error(`proposers/claude-p: ${PROPOSAL_FILE} is not JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
    const draft = validateDraft(raw)
    const parent = parentFromInput ?? draft.parent
    if (parent === undefined) throw new Error('proposers/claude-p: parent is required (input or draft)')
    if (draft.surface !== 'skill' || draft.patch.surface !== 'skill') {
      throw new Error(`proposers/claude-p: only the skill surface is supported, got "${draft.surface}"`)
    }
    const skillDir = isAbsolute(draft.patch.skill_dir) ? draft.patch.skill_dir : resolve(workDir, draft.patch.skill_dir)
    const rel = relative(workDir, skillDir)
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`proposers/claude-p: skill_dir ${draft.patch.skill_dir} escapes the work directory`)
    if (!existsSync(skillDir) || !statSync(skillDir).isDirectory() || !existsSync(join(skillDir, 'SKILL.md'))) {
      throw new Error(`proposers/claude-p: ${skillDir} is not a skill directory (no SKILL.md)`)
    }
    return validateProposal({
      parent,
      surface: 'skill',
      patch: { surface: 'skill', skill_dir: skillDir },
      intent: draft.intent,
      prediction: draft.prediction,
      proposer: { name: this.name, version: this.version, config_sha: this.configSha },
    })
  }
}
