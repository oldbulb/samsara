// @samsara/loops-claude-code — LoopProvider 'claude-code'.
//
// The Claude Agent SDK's `query` drives a real `claude` CLI; that process is
// spawned through `ctx.subprocess` inside this plugin's own effect (E4). The
// credential is resolved per attempt through `ctx.credentials` and reaches
// the child only as an explicit env value (E5). Per-attempt HOME / TMPDIR /
// CLAUDE_CONFIG_DIR live under `spec.tmpdir` (E6).

import { Schema, type Context, type CredentialRef } from '@samsara/kernel'
import { startRun } from './run.ts'
import type { AttemptSpec, HarnessFacts, LoopCapabilities, LoopProvider, LoopRun } from './seam.ts'
import type {} from '@samsara/loops'

export * from './seam.ts'
export { buildEnv, configDir } from './env.ts'
export { MessageMapper, classifyResult, tokenUsage, PRESET_ID } from './mapper.ts'
export { readSubmit, submitFileInstruction, submitPath, stripFrontmatter } from './submit.ts'
export { claudeSpawnSpec, sdkEnvironmentOverlay, ManagedClaudeCodeProcess } from './process.ts'
export { startRun, queryOptions, systemPromptAppend, STREAM_FILE, type RunDeps } from './run.ts'

export const name = 'loops-claude-code'
export const inject = ['loops', 'subprocess', 'credentials']

export const SDK_VERSION = '0.3.220'
export const PROVIDER_NAME = 'claude-code'
const DEFAULT_GRACE_MS = 3_000

export interface Config {
  /** Grace in milliseconds between SIGTERM and SIGKILL on the child tree. */
  graceMs?: number
}

export const Config: Schema<Config> = Schema.object({
  graceMs: Schema.number().default(DEFAULT_GRACE_MS),
})

export const harnessFacts: HarnessFacts = {
  systemPromptMode: 'preset:claude_code',
  skillDelivery: 'prompt-inline',
  schemaEnforcement: 'permissive-tool',
  permission: 'bypassPermissions',
  reasoning: {},
  version: { loop: PROVIDER_NAME, sdk: SDK_VERSION },
}

export const capabilities: LoopCapabilities = {
  perAttemptBaseUrl: true,
  perAttemptEnv: true,
  nativeSchema: 'none',
  toolFilter: true,
  nativeMaxTurns: true,
}

type ProviderContext = Pick<Context, 'effect' | 'subprocess' | 'credentials'>

export class ClaudeCodeLoopProvider implements LoopProvider {
  readonly name = PROVIDER_NAME
  readonly harnessFacts = harnessFacts
  readonly capabilities = capabilities

  constructor(
    private readonly ctx: ProviderContext,
    private readonly graceMs: number,
  ) {}

  async start(spec: AttemptSpec): Promise<LoopRun> {
    const credential = await this.ctx.credentials.resolve(spec.route.credentialRef as CredentialRef)
    if (credential === undefined) {
      throw new Error(`loops-claude-code: credential ${spec.route.credentialRef} is not configured`)
    }
    return startRun(spec, { ctx: this.ctx, credentialValue: credential.value, graceMs: this.graceMs })
  }
}

export function apply(ctx: Context, config: Config): void {
  const graceMs = config.graceMs ?? DEFAULT_GRACE_MS
  if (!(Number.isFinite(graceMs) && graceMs > 0)) throw new Error('loops-claude-code: graceMs must be positive and finite')
  const provider = new ClaudeCodeLoopProvider(ctx, graceMs)
  ctx.effect(() => ctx.loops.register(provider), 'loops-claude-code:register')
}
