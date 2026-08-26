// Plugin: registers a 'command' adapter on `ctx.proposers` under the configured
// name. The child is spawned through `ctx.subprocess` inside this plugin's own
// effect (E4); a credential, when configured, is resolved per proposal through
// `ctx.credentials` and reaches the adapter only as an env map (E5).

import { Schema, type Context, type CredentialRef, type SubprocessHandle, type SubprocessSpawnSpec } from '@oldbulb/samsara-kernel'
import { CommandAdapter, DEFAULT_COMMAND_TIMEOUT_MS } from './command.ts'
import type {} from './index.ts'

export const name = 'proposer-command'
export const inject = ['proposers', 'subprocess', 'credentials']

export interface Config {
  command: string
  args?: string[]
  name: string
  version?: string
  timeoutMs?: number
  /** Credential reference resolved through ctx.credentials into `credentialVar` for the child. */
  credentialRef?: string
  /** Environment variable the credential is injected as. */
  credentialVar?: string
}

export const Config: Schema<Config> = Schema.object({
  command: Schema.string().required(),
  args: Schema.array(Schema.string()).default([]),
  name: Schema.string().required(),
  version: Schema.string(),
  timeoutMs: Schema.number().default(DEFAULT_COMMAND_TIMEOUT_MS),
  env: Schema.dict(Schema.string()).default({}),
  credentialRef: Schema.string(),
  credentialVar: Schema.string(),
})

type PluginContext = Pick<Context, 'effect' | 'subprocess' | 'credentials' | 'proposers'>

export function createAdapter(ctx: PluginContext, config: Config): CommandAdapter {
  const spawn = (spec: SubprocessSpawnSpec): SubprocessHandle => {
    let child: SubprocessHandle | undefined
    const dispose = ctx.effect(() => {
      child = ctx.subprocess.spawn(spec)
      return () => { child?.terminate() }
    }, 'proposer-command:child')
    child!.done.then(() => dispose(), () => dispose())
    return child!
  }
  const credentialEnv = async (): Promise<Record<string, string>> => {
    if (config.credentialRef === undefined) return {}
    if (config.credentialVar === undefined) throw new Error(`proposer-command: credentialVar is required with credentialRef (${config.name})`)
    const credential = await ctx.credentials.resolve(config.credentialRef as CredentialRef)
    if (credential === undefined) throw new Error(`proposer-command: credential ${config.credentialRef} is not configured`)
    return { [config.credentialVar]: credential.value }
  }
  const { credentialRef: _ref, credentialVar: _var, ...adapterConfig } = config
  return new CommandAdapter(adapterConfig, { spawn, credentialEnv })
}

export function apply(ctx: Context, config: Config): void {
  const adapter = createAdapter(ctx, config)
  ctx.effect(() => ctx.proposers.register(adapter), 'proposer-command:register')
}
