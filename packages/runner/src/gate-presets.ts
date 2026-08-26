// Plugin: mounts the runner's gate presets (`fast`, `permissive`) and
// @oldbulb/samsara-gate-catalog rules on `ctx.gate` by their `--gate-policy`
// names, so a command can name them. Row order is registration order: this
// row before gate-default makes them shadows (a compare row beside the
// promotion verdict); after it, the last one is the promotion gate and needs a
// `gate_change` consent before anything opens under it.

import { Context, Schema } from '@oldbulb/samsara-kernel'
import type {} from '@oldbulb/samsara-gate'
import { gatePresetOf, type GatePolicyName } from './challenge.ts'

export const name = 'gate-presets'
export const inject = ['gate']

export interface Config {
  /** `--gate-policy` names, registered in order; `default` is ctx.gate's own policy and registers nothing. */
  policies?: GatePolicyName[]
}
export const Config: Schema<Config> = Schema.object({
  policies: Schema.array(Schema.string()).default([]),
})

export function apply(ctx: Context, config: Config): void {
  for (const policy of config.policies ?? []) {
    const provider = gatePresetOf(policy)
    if (provider) ctx.effect(() => ctx.gate.register(provider), `gate-presets.${policy}`)
  }
}
