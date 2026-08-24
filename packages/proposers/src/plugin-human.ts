// Plugin: registers the 'human' adapter on `ctx.proposers` with the operator's
// patch supplied as configuration. Without a patch (the bundle's default row)
// nothing is registered; `round --proposer human --skill-dir … --intent …`
// then builds the adapter from the command line instead.

import { Schema, type Context } from '@oldbulb/samsara-kernel'
import { HumanAdapter, type HumanProposalConfig } from './human.ts'
import { SURFACES } from './types.ts'
import type {} from './index.ts'

export const name = 'proposer-human'
export const inject = ['proposers']

export type Config = HumanProposalConfig

export const Config: Schema<Config> = Schema.object({
  parent: Schema.string(),
  surface: Schema.union([...SURFACES]),
  skillDir: Schema.string(),
  rows: Schema.array(Schema.any()),
  intent: Schema.string(),
  prediction: Schema.object({
    metric: Schema.string(),
    direction: Schema.union(['up', 'down']),
    magnitude: Schema.number(),
    predicted_fixes: Schema.array(Schema.string()),
    at_risk: Schema.array(Schema.string()),
  }),
})

export function apply(ctx: Context, config: Partial<Config>): void {
  if (config.skillDir === undefined && !(config.rows?.length)) return
  if (config.intent === undefined || config.prediction?.metric === undefined || config.prediction.direction === undefined) {
    throw new Error('proposer-human: intent and prediction { metric, direction } are required with a patch')
  }
  ctx.effect(() => ctx.proposers.register(new HumanAdapter(config as Config)), 'proposer-human:register')
}
