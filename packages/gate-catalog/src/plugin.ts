// Plugin: mounts catalog rules on `ctx.gate` by name for the lifetime of its
// scope. Row order is registration order: this row before gate-default makes
// them shadows (a compare row beside the promotion verdict, nameable through
// `--gate-policy`); after it, the last one is the promotion gate and needs a
// `gate_change` consent before anything opens under it.

import { Context, Schema } from '@oldbulb/samsara-kernel'
import type {} from '@oldbulb/samsara-gate'
import { CATALOG, catalogGate } from './index.ts'

export const name = 'gate-catalog'
export const inject = ['gate']

export interface Config {
  /** Catalog names (`name` or `name@version`), registered in order; default: every rule. */
  policies?: string[]
}
export const Config: Schema<Config> = Schema.object({
  policies: Schema.array(Schema.string()).default(CATALOG.map(g => g.name)),
})

export function apply(ctx: Context, config: Config): void {
  for (const policy of config.policies ?? []) {
    const rule = catalogGate(policy)
    if (!rule) throw new Error(`unknown catalog rule "${policy}"`)
    ctx.effect(() => ctx.gate.register(rule), `gate-catalog.${policy}`)
  }
}
