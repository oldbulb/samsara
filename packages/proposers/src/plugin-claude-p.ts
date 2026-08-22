// Plugin: registers the 'claude-p' adapter on `ctx.proposers`. The child is
// spawned through `ctx.subprocess` inside this plugin's own effect (E4); the
// credential is resolved per proposal through `ctx.credentials` and reaches the
// adapter only as an env map (E5).

import { type Context, type CredentialRef, type SubprocessHandle, type SubprocessSpawnSpec } from '@samsara/kernel'
import { ClaudePAdapter, Config } from './claude-p.ts'
import type {} from './index.ts'

export { Config }
export type { Config as ConfigType } from './claude-p.ts'

export const name = 'proposer-claude-p'
export const inject = ['proposers', 'subprocess', 'credentials']

type PluginContext = Pick<Context, 'effect' | 'subprocess' | 'credentials' | 'proposers'>

export function createAdapter(ctx: PluginContext, config: Config): ClaudePAdapter {
  const spawn = (spec: SubprocessSpawnSpec): SubprocessHandle => {
    let child: SubprocessHandle | undefined
    const dispose = ctx.effect(() => {
      child = ctx.subprocess.spawn(spec)
      return () => { child?.terminate() }
    }, 'proposer-claude-p:child')
    child!.done.then(() => dispose(), () => dispose())
    return child!
  }
  const credentialEnv = async (): Promise<Record<string, string>> => {
    if (config.credentialRef === undefined) return {}
    const credential = await ctx.credentials.resolve(config.credentialRef as CredentialRef)
    if (credential === undefined) throw new Error(`proposer-claude-p: credential ${config.credentialRef} is not configured`)
    return { ANTHROPIC_AUTH_TOKEN: credential.value }
  }
  return new ClaudePAdapter(config, { spawn, credentialEnv })
}

export function apply(ctx: Context, config: Config): void {
  const adapter = createAdapter(ctx, config)
  ctx.effect(() => ctx.proposers.register(adapter), 'proposer-claude-p:register')
}
