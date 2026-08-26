// Plugin: registers the null loop on `ctx.loops` for the lifetime of its scope.

import { Context, Schema } from '@oldbulb/samsara-kernel'
import { NullLoopProvider, type NullLoopOptions } from './null.ts'

export const name = 'loops-null'
export const inject = ['loops']

export interface Config {
  /** A canned submission every attempt leaves in its workdir (any JSON object); null, the default, submits nothing. */
  submit?: NullLoopOptions['submit']
}
export const Config: Schema<Config> = Schema.object({
  submit: Schema.any().default(null),
})

export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => ctx.loops.register(new NullLoopProvider({ submit: config.submit ?? null })), 'loops-null')
}
