// The JSON forms of the seam types in types.ts: what a gate written in any
// language reads on stdin (CompareRequest) and must print on stdout
// (GateJudgement). A TypeScript policy sees the same shapes; these schemas
// only exist so a subprocess gate is held to them. `method` is an open string
// here because a foreign gate names its own procedure.

import { z } from '@oldbulb/samsara-kernel'
import type { GateJudgement } from './types.ts'

export const attemptStatusSchema = z.enum(['COMPLETED', 'TRUNCATED', 'ABORTED', 'FAILED'])
export const metricKindSchema = z.enum(['mechanical', 'reality', 'judge'])
export const tierSchema = z.enum(['smoke', 'holdin', 'holdout', 'live'])

export const scoredAttemptSchema = z.object({
  attemptId: z.string(),
  challengerId: z.string(),
  taskId: z.string(),
  entityKey: z.string(),
  stratum: z.string().optional(),
  sample: z.number(),
  status: attemptStatusSchema,
  metric: z.string(),
  value: z.number(),
  kind: metricKindSchema,
  cost: z.object({ usd: z.number().optional(), tokens: z.number() }),
  valid: z.boolean().optional(),
})

export const gatePolicySchema = z.object({
  alpha: z.number(),
  power: z.number(),
  bootstrap: z.object({ B: z.number(), method: z.literal('bca') }),
  nEffFloor: z.number(),
  mde: z.number().optional(),
  validityFloor: z.number(),
  costBudget: z.object({ metric: z.enum(['cost_usd', 'tokens']), maxRatio: z.number() }),
  futility: z.object({ tier: z.literal('holdin'), zStop: z.number() }),
  holdout: z.object({ rotateAfterPromotions: z.number(), maxRounds: z.number() }),
})

export const compareRequestSchema = z.object({
  challenger: z.array(scoredAttemptSchema),
  champion: z.array(scoredAttemptSchema),
  tier: tierSchema,
  primaryMetric: z.string(),
  noiseFloor: z.object({ sdPaired: z.number(), nReruns: z.number() }),
  policy: gatePolicySchema,
  round: z.object({ k: z.number(), index: z.number() }),
  bestSoFar: z.number().optional(),
  seed: z.number().optional(),
  factsSha: z.object({ challenger: z.string(), champion: z.string() }).optional(),
})

export const taskDeltaSchema = z.object({
  taskId: z.string(),
  entityKey: z.string(),
  sample: z.number(),
  stratum: z.string().optional(),
  delta: z.number(),
})

export const compareSchema = z.object({
  perTask: z.array(taskDeltaSchema),
  mean: z.number(),
  ci: z.tuple([z.number(), z.number()]),
  method: z.string(),
  clusterKey: z.literal('entity'),
  nEff: z.number(),
  mde: z.number(),
  replicates: z.number(),
  minEffect: z.number(),
  holm: z.object({ adjustedAlpha: z.number() }),
  costRatio: z.number(),
  ladder: z.object({ step: z.number(), beatBest: z.boolean() }),
  counts: z.object({ paired: z.number(), unpaired: z.number(), excluded: z.number(), validRate: z.number() }),
  ruleFired: z.string(),
})

export const verdictSchema = z.enum(['invalid', 'drop', 'hold', 'hold:underpowered', 'promote'])

export const gateJudgementSchema = z.object({
  compare: compareSchema,
  verdict: verdictSchema,
})

export type CompareRequestJson = z.infer<typeof compareRequestSchema>
export type GateJudgementJson = z.infer<typeof gateJudgementSchema>

/**
 * Parse a gate's stdout as a GateJudgement. Throws an Error whose message
 * names the offending field (`compare.ci[1]: expected number, received string`)
 * so a gate author can read it without knowing the schema library.
 */
export function parseGateJudgement(text: string): GateJudgement {
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch (e) {
    throw new Error(`gate output is not JSON: ${(e as Error).message}`)
  }
  const r = gateJudgementSchema.safeParse(doc)
  if (!r.success) {
    const issues = r.error.issues.map(i => `${i.path.length ? i.path.map(String).join('.').replace(/\.(\d+)/g, '[$1]') : '<root>'}: ${i.message}`)
    throw new Error(`gate output is not a GateJudgement: ${issues.join('; ')}`)
  }
  return r.data as GateJudgement
}
