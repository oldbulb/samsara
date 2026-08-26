// Plugin: registers the installed loop on `ctx.loops` for the lifetime of its
// scope. A credential, when configured, is resolved per attempt through
// `ctx.credentials` and reaches the agent only as the one named variable (E5).

import { Context, Schema, type CredentialRef } from '@oldbulb/samsara-kernel'
import { InstalledLoopProvider, type InstalledLoopOptions } from './installed.ts'

export const name = 'loops-installed'
export const inject = ['loops', 'credentials']

export type Config = InstalledLoopOptions
export const Config: Schema<Config> = Schema.object({
  command: Schema.array(Schema.string()).required(),
  cwd: Schema.string(),
  transcript: Schema.string(),
  submit: Schema.string(),
  env: Schema.dict(Schema.string()),
  credentialRef: Schema.string(),
  credentialVar: Schema.string(),
})

export function apply(ctx: Context, config: Config): void {
  const resolveCredential = async (ref: string): Promise<string> => {
    const credential = await ctx.credentials.resolve(ref as CredentialRef)
    if (credential === undefined) throw new Error(`loops-installed: credential ${ref} is not configured`)
    return credential.value
  }
  ctx.effect(() => ctx.loops.register(new InstalledLoopProvider(config, { resolveCredential })), 'loops-installed')
}
