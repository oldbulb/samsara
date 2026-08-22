// The ledger domain: six tables, zod row schemas, content-addressed keys.
// Mirrors docs/design/architecture.md "Ledger data model". Rows are plain
// immutable data; every key is a sha256 over the row's coordinate tuple (see
// id.ts) so a re-submission of the same facts lands on the same row.

import { defineDomain, domainTable, z } from '@samsara/kernel'
import { keyOf } from './id.ts'

const sha = z.string().regex(/^[0-9a-f]{64}$/)
export const TIERS = ['smoke', 'holdin', 'holdout', 'live'] as const
export const tierSchema = z.enum(TIERS)
export type Tier = z.infer<typeof tierSchema>

// ---------------------------------------------------------------- challengers

/** The coordinate tuple a challenger id is computed from (every field is a content address or a pinned value). */
export const challengerCoordsSchema = z.object({
  parent_ids: z.array(sha),
  patch_sha: sha,
  harness_sha: sha,
  env_sha: sha,
  skill_sha: sha,
  taskset_sha: sha,
  route: z.object({
    loop: z.string(),
    loop_adapter_version: z.string(),
    model_id: z.string(),
    effort: z.string().optional(),
    model_pool_sha: sha,
    base_url_kind: z.string(),
  }),
  optimizer_config_sha: sha,
})
export type ChallengerCoords = z.infer<typeof challengerCoordsSchema>

export const verdictValueSchema = z.enum(['invalid', 'drop', 'hold', 'promote', 'confirmed', 'reversed'])
export const verdictSchema = z.object({
  value: verdictValueSchema,
  by: z.string(),
  rule: z.string(),
  consent_id: z.string().optional(),
})

export const challengerRowSchema = challengerCoordsSchema.extend({
  id: sha,
  lineage: z.string(),
  surface: z.string(),
  patch: z.object({
    cordis: z.unknown().optional(),
    skill_ref: z.string().optional(),
    before: z.string().optional(),
  }),
  intent: z.string(),
  prediction: z.object({
    metric: z.string(),
    direction: z.enum(['up', 'down']),
    magnitude: z.number().optional(),
    predicted_fixes: z.array(z.string()).optional(),
    at_risk: z.array(z.string()).optional(),
  }),
  scorer_version: z.string(),
  task_version: z.number().int(),
  truth_snapshot_id: z.string(),
  report_rule_version: z.string(),
  judge_model_version: z.string().optional(),
  runtime: z.object({ timeout_s: z.number(), step_cap: z.number().int() }),
  tasksets: z.object({ smoke: sha, holdin: sha, holdout: sha }),
  budget: z.number(),
  tier_reached: tierSchema.optional(),
  status: z.enum(['proposed', 'running', 'judged', 'decided']),
  verdict: verdictSchema.optional(),
  proposed_at: z.string(),
})
export type ChallengerRow = z.infer<typeof challengerRowSchema>
/** What a proposer submits: the row minus what the ledger fills in. */
export type ChallengerProposal = Omit<ChallengerRow, 'id' | 'status' | 'proposed_at'> & { proposed_at?: string }

export function challengerId(coords: ChallengerCoords): string {
  const c = challengerCoordsSchema.parse(coords)
  return keyOf(c.parent_ids, c.patch_sha, c.harness_sha, c.env_sha, c.skill_sha, c.taskset_sha, c.route, c.optimizer_config_sha)
}

// ------------------------------------------------------------------- attempts

export const ATTEMPT_STATUSES = ['COMPLETED', 'TRUNCATED', 'ABORTED', 'FAILED'] as const
export const attemptStatusSchema = z.enum(ATTEMPT_STATUSES)
export type AttemptStatus = z.infer<typeof attemptStatusSchema>

export const attemptRowSchema = z.object({
  id: z.string().min(1),
  challenger_id: z.string().min(1),
  task_id: z.string().min(1),
  sample: z.number().int().nonnegative(),
  loop: z.string(),
  /** Which task set the attempt ran on; drives viewer redaction. */
  tier: tierSchema,
  status: attemptStatusSchema,
  stop_reason: z.string(),
  facts_sha: z.string(),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).passthrough(),
  cost: z.object({ tokens: z.number().optional(), wall_s: z.number().optional(), usd: z.number().optional() }),
  output: z.object({ source: z.string(), valid: z.boolean() }),
  artifacts: z.array(z.object({ name: z.string(), sha: z.string(), path: z.string().optional() })),
  ephemeral_tools: z.array(z.string()).optional(),
  skill_utilization: z.record(z.string(), z.unknown()).optional(),
})
export type AttemptRow = z.infer<typeof attemptRowSchema>

// --------------------------------------------------------------------- scores

export const scoreKindSchema = z.enum(['mechanical', 'reality', 'judge'])
export const scoreRowSchema = z.object({
  attempt_id: z.string().min(1),
  scorer_version: z.string(),
  truth_snapshot_id: z.string(),
  metric: z.string().min(1),
  value: z.number(),
  kind: scoreKindSchema,
  stratum: z.string().optional(),
})
export type ScoreRow = z.infer<typeof scoreRowSchema>

export function scoreKey(row: Pick<ScoreRow, 'attempt_id' | 'scorer_version' | 'truth_snapshot_id' | 'metric'>): string {
  return keyOf(row.attempt_id, row.scorer_version, row.truth_snapshot_id, row.metric)
}

// ------------------------------------------------------------------- compares

export const compareRowSchema = z.object({
  challenger_id: z.string().min(1),
  vs_id: z.string().min(1),
  tier: tierSchema,
  truth_snapshot_id: z.string(),
  per_task: z.array(z.object({ task_id: z.string(), delta: z.number() })),
  mean: z.number(),
  ci: z.tuple([z.number(), z.number()]),
  method: z.string(),
  cluster_key: z.string(),
  holm: z.object({ m: z.number().int(), rank: z.number().int(), alpha_adj: z.number() }).optional(),
  n_eff: z.number(),
  mde: z.number(),
  cost_budget: z.number().optional(),
  rule_fired: z.string(),
  verdict: verdictSchema,
  holdout_budget_remaining: z.number().int().optional(),
  predicted_vs_observed: z.object({ fixes_hit: z.number(), at_risk_hit: z.number() }).optional(),
  at: z.string(),
})
export type CompareRow = z.infer<typeof compareRowSchema>

export function compareKey(row: Pick<CompareRow, 'challenger_id' | 'vs_id' | 'tier' | 'truth_snapshot_id'>): string {
  return keyOf(row.challenger_id, row.vs_id, row.tier, row.truth_snapshot_id)
}

// ------------------------------------------------------------------- consents

export const consentRowSchema = z.object({
  id: z.string().min(1),
  challenger_id: z.string().min(1),
  action: z.enum(['promote', 'reject', 'reopen', 'scorer_bump']),
  who: z.string(),
  channel: z.string(),
  proof_sha: z.string(),
  at: z.string(),
})
export type ConsentRow = z.infer<typeof consentRowSchema>

// ---------------------------------------------------------------- settlements

export const settlementRowSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['truth', 'scorer', 'model', 'taskset']),
  taskset_sha: z.string(),
  as_of: z.string(),
  truth_snapshot_id: z.string(),
  n_settled: z.number().int(),
  n_pending: z.number().int(),
  triggered_rescoring: z.array(z.string()),
})
export type SettlementRow = z.infer<typeof settlementRowSchema>

// --------------------------------------------------------------------- domain

export const ledgerDomainSpec = defineDomain({
  name: 'samsara_ledger',
  version: 0,
  tables: {
    challengers: domainTable<string, ChallengerRow>(challengerRowSchema),
    attempts: domainTable<string, AttemptRow>(attemptRowSchema),
    scores: domainTable<string, ScoreRow>(scoreRowSchema),
    compares: domainTable<string, CompareRow>(compareRowSchema),
    consents: domainTable<string, ConsentRow>(consentRowSchema),
    settlements: domainTable<string, SettlementRow>(settlementRowSchema),
  },
})
export type LedgerDomainSpec = typeof ledgerDomainSpec
