// Plugin: registers the null loop on `ctx.loops` for the lifetime of its scope.

import { Context, Schema } from '@oldbulb/samsara-kernel'
import { NullLoopProvider } from './null.ts'

export const name = 'loops-null'
export const inject = ['loops']

export interface Config {}
export const Config: Schema<Config> = Schema.object({})

export function apply(ctx: Context, _config: Config): void {
  ctx.effect(() => ctx.loops.register(new NullLoopProvider()), 'loops-null')
}
