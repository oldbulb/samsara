// Plugin: mounts gate-default on `ctx.gate` for the lifetime of its scope.

import { Context, Schema } from '@samsara/kernel'
import { gateDefault, GATE_DEFAULT_NAME, GATE_DEFAULT_VERSION } from './default.ts'

export const name = 'gate-default'
export const inject = ['gate']

export interface Config {}
export const Config: Schema<Config> = Schema.object({})

export function apply(ctx: Context, _config: Config): void {
  ctx.effect(
    () => ctx.gate.register({ name: GATE_DEFAULT_NAME, version: GATE_DEFAULT_VERSION, judge: gateDefault }),
    'gate-default',
  )
}
