// The ledger domain: eleven tables, zod row schemas, content-addressed keys.
// Mirrors docs/design/architecture.md "Ledger data model". Rows are plain
// immutable data; every key is a sha256 over the row's coordinate tuple (see
// id.ts) so a re-submission of the same facts lands on the same row.

import { defineDomain, domainTable, z } from '@oldbulb/samsara-kernel'
import { canonicalJson, keyOf, sha256 } from './id.ts'

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
  /** Rule 0 over where the attempts ran: `environmentSha` of the environment facts (image digest, resources, network — not the provider). Absent on rows recorded before the field existed and on host-side rows. */
  environment_sha: sha.optional(),
})
export type ChallengerCoords = z.infer<typeof challengerCoordsSchema>

/** `hold:superseded`: a promote verdict that lost its round to another sibling (§ Round); it re-enters the next round. */
export const verdictValueSchema = z.enum(['invalid', 'drop', 'hold', 'hold:superseded', 'promote', 'confirmed', 'reversed'])
export const verdictSchema = z.object({
  value: verdictValueSchema,
  by: z.string(),
  rule: z.string(),
  round_id: z.string().optional(),
  consent_id: z.string().optional(),
})

const gateRefSchema = z.object({ name: z.string(), version: z.string(), policy_sha: z.string() })
export type GateRef = z.infer<typeof gateRefSchema>

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
  /** The pack name; one component of `eval_config_sha`. Defaults to '' on rows recorded before the field existed. */
  pack: z.string().default(''),
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
  /** Derived by `propose` (`evalConfigSha`), not part of the id; absent on rows recorded before the field existed. */
  eval_config_sha: sha.optional(),
  /** Evidence written when the row's scope was opened; the coordinates in the id are unchanged. */
  opened: z.object({ harness_sha: z.string(), env_sha: z.string(), profile_sha: z.string(), at: z.string() }).optional(),
  tier_reached: tierSchema.optional(),
  status: z.enum(['proposed', 'opened', 'running', 'judged', 'decided']),
  verdict: verdictSchema.optional(),
  proposed_at: z.string(),
})
export type ChallengerRow = z.infer<typeof challengerRowSchema>
/**
 * What a proposer submits: the row minus what the ledger fills in. `pack` is
 * the pack name the row was evaluated under; the lifecycle service requires it,
 * the ledger alone accepts its absence (as '') so that rows recorded by older
 * callers still land.
 */
export type ChallengerProposal = Omit<ChallengerRow, 'id' | 'status' | 'proposed_at' | 'pack' | 'eval_config_sha' | 'opened'> & {
  pack?: string
  proposed_at?: string
}

export function challengerId(coords: ChallengerCoords): string {
  const c = challengerCoordsSchema.parse(coords)
  const tuple = [c.parent_ids, c.patch_sha, c.harness_sha, c.env_sha, c.skill_sha, c.taskset_sha, c.route, c.optimizer_config_sha]
  // Joins the tuple only when present, so every id computed before the coordinate existed is unchanged.
  if (c.environment_sha !== undefined) tuple.push(c.environment_sha)
  return keyOf(...tuple)
}

/** The fields of a challenger row on the judge's side that can move a score (architecture.md § Evaluation configuration). */
export type EvalConfigFields = Pick<ChallengerRow, 'tasksets' | 'task_version' | 'scorer_version' | 'truth_snapshot_id' | 'report_rule_version' | 'judge_model_version'> & {
  pack?: string
}

/** sha256 of the canonical JSON of the evaluation configuration; equal on every row a round may compare. The metric is the round's, not the row's. */
export function evalConfigSha(row: EvalConfigFields): string {
  return sha256(canonicalJson({
    pack: row.pack ?? '',
    tasksets: row.tasksets,
    task_version: row.task_version,
    scorer_version: row.scorer_version,
    truth_snapshot_id: row.truth_snapshot_id,
    report_rule_version: row.report_rule_version,
    judge_model_version: row.judge_model_version,
  }))
}

// ------------------------------------------------------------------- attempts

export const ATTEMPT_STATUSES = ['COMPLETED', 'TRUNCATED', 'ABORTED', 'FAILED'] as const
export const attemptStatusSchema = z.enum(ATTEMPT_STATUSES)
export type AttemptStatus = z.infer<typeof attemptStatusSchema>

/** The environment an attempt ran in, as its provider reported it (the shape of `EnvironmentFacts` in `@oldbulb/samsara-environments`, kept here so the ledger imports nothing of it). */
export const attemptEnvironmentSchema = z.object({
  provider: z.string(),
  version: z.string(),
  image: z.object({ ref: z.string().optional(), digest: z.string().optional() }).optional(),
  resources: z.object({ cpus: z.number().optional(), memoryMb: z.number().optional(), timeoutS: z.number() }),
  network: z.enum(['none', 'allowlist', 'public']),
  allowedHosts: z.array(z.string()).optional(),
})
export type AttemptEnvironment = z.infer<typeof attemptEnvironmentSchema>

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
  /** `usd` is the loop's (tokens); `wall_s` the agent's wall time in its environment; `compute_usd` the environment provider's charge for the attempt where it reports one (S8: the cost ratio between arms on different providers is wrong without it). */
  cost: z.object({ tokens: z.number().optional(), wall_s: z.number().optional(), usd: z.number().optional(), compute_usd: z.number().optional() }),
  output: z.object({ source: z.string(), valid: z.boolean() }),
  artifacts: z.array(z.object({ name: z.string(), sha: z.string(), path: z.string().optional() })),
  ephemeral_tools: z.array(z.string()).optional(),
  skill_utilization: z.record(z.string(), z.unknown()).optional(),
  /** Where the attempt ran; the provider is evidence here, not a coordinate (rule 0). Absent on host-side attempts and on rows recorded before the field existed. */
  environment: attemptEnvironmentSchema.optional(),
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
  /** `m` and `rank` are real when the row's round has k > 1 siblings. */
  holm: z.object({ m: z.number().int(), rank: z.number().int(), alpha_adj: z.number() }).optional(),
  n_eff: z.number(),
  mde: z.number(),
  /** The round the judgement belongs to; absent on rows recorded before rounds existed. */
  round_id: z.string().optional(),
  /** Samples per task in the comparison; absent on rows recorded before the field existed. */
  replicates: z.number().int().optional(),
  /** The smallest effect the verdict rule treated as real (SESOI); absent on rows recorded before the field existed. */
  min_effect: z.number().optional(),
  /** Where the sd behind `mde` came from: the round's noise floor row, or the comparison's own spread. */
  sd_source: z.enum(['noise_floor', 'comparison']).optional(),
  cost_budget: z.number().optional(),
  rule_fired: z.string(),
  verdict: verdictSchema,
  holdout_budget_remaining: z.number().int().optional(),
  predicted_vs_observed: z.object({ fixes_hit: z.number(), at_risk_hit: z.number() }).optional(),
  /** `name@version` of the policy that judged; absent on rows recorded before the field existed, which read as the promotion gate. */
  gate: z.string().optional(),
  /** A gate other than the promotion gate judged without a `gate_change` consent: the row never feeds a decision. Absent reads as false. */
  shadow: z.boolean().optional(),
  /** The gate's Ladder output (S7): `beat_best` against `best_so_far` (the round's, absent when none yet) by `step`. Absent on rows recorded before the field existed. */
  ladder: z.object({ step: z.number(), beat_best: z.boolean(), best_so_far: z.number().optional() }).optional(),
  at: z.string(),
})
export type CompareRow = z.infer<typeof compareRowSchema>

/**
 * The promotion verdict has one slot per (challenger, vs, tier, truth,
 * replicates — 1 when absent), so a re-judgement over more replicates lands
 * as its own row; a shadow verdict is keyed by its gate too, so it sits
 * beside that slot.
 */
export function compareKey(row: Pick<CompareRow, 'challenger_id' | 'vs_id' | 'tier' | 'truth_snapshot_id' | 'replicates' | 'gate' | 'shadow'>): string {
  const replicates = row.replicates ?? 1
  if (row.shadow) return keyOf(row.challenger_id, row.vs_id, row.tier, row.truth_snapshot_id, replicates, row.gate ?? '')
  return keyOf(row.challenger_id, row.vs_id, row.tier, row.truth_snapshot_id, replicates)
}

// ------------------------------------------------------------------- consents

/** Closed set, mirrored by `SIGNOFF_ACTIONS` in packages/signoff: every change to a fixed point has an action. */
export const CONSENT_ACTIONS = ['promote', 'demote', 'reject', 'reopen', 'eval_config_change', 'gate_change', 'holdout_reveal'] as const

export const consentRowSchema = z.object({
  id: z.string().min(1),
  /** The consent's subject: the row id the sign-off named. For `gate_change` it is the gate's `name@version`. */
  challenger_id: z.string().min(1),
  action: z.enum(CONSENT_ACTIONS),
  who: z.string(),
  channel: z.string(),
  proof_sha: z.string(),
  at: z.string(),
  /** The round a `promote` consent decides (E2): `lifecycle.decide` accepts only a consent bound to its round. */
  round_id: z.string().optional(),
  /** The signed proof itself (payload + signature), so the row can be verified again against the public key before it is acted on. */
  proof: z.object({
    payload: z.object({ nonce: z.string(), rowId: z.string(), action: z.string(), who: z.string(), issuedAt: z.string(), roundId: z.string().optional() }),
    signature: z.string(),
  }).optional(),
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

// --------------------------------------------------------------------- rounds

/** What a round id is computed from: the evaluation configuration, the champion judged against, the gate, when, and the experiment (if any). */
export const roundCoordsSchema = z.object({
  eval_config_sha: sha,
  champion_id: z.string().min(1),
  gate: gateRefSchema,
  opened_at: z.string(),
  experiment_id: z.string().optional(),
})
export type RoundCoords = z.infer<typeof roundCoordsSchema>

export const roundRowSchema = roundCoordsSchema.extend({
  id: sha,
  shadow_gates: z.array(gateRefSchema),
  noise_floor_id: z.string().optional(),
  /** The number of siblings Holm runs over; always `sibling_ids.length`. */
  k: z.number().int().nonnegative(),
  sibling_ids: z.array(z.string()),
  best_so_far: z.number().optional(),
  /** The champion state sha the round opened against; a decision under another state is refused. Absent on rows recorded before the field existed. */
  profile_sha: z.string().optional(),
  operator: z.object({ session_id: z.string().optional(), provider: z.string().optional(), model: z.string().optional() }).optional(),
  status: z.enum(['open', 'judged', 'decided']),
  closed_at: z.string().optional(),
  /** `aborted`: closed by reconciliation, its running siblings judged invalid; nothing in it was decided. */
  outcome: z.object({ promoted: z.string().optional(), superseded: z.array(z.string()), consent_id: z.string().optional(), aborted: z.literal(true).optional() }).optional(),
})
export type RoundRow = z.infer<typeof roundRowSchema>
/** What opens a round: the row minus what the ledger fills in (`k` follows `sibling_ids`). */
export type RoundInput = Omit<RoundRow, 'id' | 'status' | 'k' | 'sibling_ids' | 'opened_at' | 'closed_at' | 'outcome'> & {
  opened_at?: string
  sibling_ids?: string[]
}

export function roundId(coords: RoundCoords): string {
  const c = roundCoordsSchema.parse(coords)
  return sha256(canonicalJson({ eval_config_sha: c.eval_config_sha, champion_id: c.champion_id, gate: c.gate, opened_at: c.opened_at, experiment_id: c.experiment_id }))
}

// --------------------------------------------------------------- noise floors

export const noiseFloorCoordsSchema = z.object({
  eval_config_sha: sha,
  champion_id: z.string().min(1),
  loop: z.string(),
  metric: z.string().min(1),
  measured_at: z.string(),
})
export type NoiseFloorCoords = z.infer<typeof noiseFloorCoordsSchema>

export const noiseFloorRowSchema = noiseFloorCoordsSchema.extend({
  id: sha,
  unit: z.enum(['task', 'entity']),
  /** sd of the paired per-unit difference between two reruns of the same champion. */
  sd_paired: z.number().nonnegative(),
  n_reruns: z.number().int().nonnegative(),
  n_tasks: z.number().int().nonnegative(),
  tier: tierSchema,
})
export type NoiseFloorRow = z.infer<typeof noiseFloorRowSchema>
export type NoiseFloorInput = Omit<NoiseFloorRow, 'id'>

export function noiseFloorId(coords: NoiseFloorCoords): string {
  const c = noiseFloorCoordsSchema.parse(coords)
  return sha256(canonicalJson({ eval_config_sha: c.eval_config_sha, champion_id: c.champion_id, loop: c.loop, metric: c.metric, measured_at: c.measured_at }))
}

// ------------------------------------------------------------------- servings

export const servingRowSchema = z.object({
  id: z.string().min(1),
  champion_id: z.string().min(1),
  from: z.string(),
  /** When the serving ended; absent while it is the one served. */
  to: z.string().optional(),
  by: z.enum(['promote', 'demote', 'reversed']),
  consent_id: z.string().optional(),
  profile_sha: z.string(),
})
export type ServingRow = z.infer<typeof servingRowSchema>

// ---------------------------------------------------------------- experiments

export const experimentBudgetSchema = z.object({
  usd: z.number().optional(),
  attempts: z.number().int().optional(),
  rounds: z.number().int().optional(),
  holdout_reveals: z.number().int().optional(),
})
export const experimentSpentSchema = z.object({
  usd: z.number(),
  attempts: z.number().int(),
  rounds: z.number().int(),
  holdout_reveals: z.number().int(),
})

/**
 * What an experiment id is computed from: the pre-registered content that
 * never changes and who registered it when. The budget is not in it: a raise
 * through `updateExperiment` keeps the id (`budget_changes` records the raise).
 */
export const experimentCoordsSchema = z.object({
  hypothesis: z.string(),
  prediction: z.object({ metric: z.string(), direction: z.enum(['up', 'down']), magnitude: z.number().optional() }),
  pack: z.string(),
  gate: gateRefSchema,
  /** Pre-registered by the person: the campaign runs the held-out tier after a held-in hold without a `holdout_reveal` consent per row. */
  auto_reveal: z.boolean().optional(),
  created_by: z.object({ who: z.string().optional(), session_id: z.string().optional(), command_id: z.string().optional(), channel: z.string() }),
  created_at: z.string(),
})
export type ExperimentCoords = z.infer<typeof experimentCoordsSchema>

/** One raise of the budget after pre-registration: the budget it became, and the session and command that set it, when. */
export const budgetChangeSchema = z.object({
  at: z.string(),
  session_id: z.string().optional(),
  command_id: z.string().optional(),
  budget: experimentBudgetSchema,
})
export type BudgetChange = z.infer<typeof budgetChangeSchema>

export const experimentRowSchema = experimentCoordsSchema.extend({
  id: sha,
  budget: experimentBudgetSchema,
  spent: experimentSpentSchema,
  status: z.enum(['active', 'closed']),
  closed_at: z.string().optional(),
  round_ids: z.array(z.string()),
  /** Every budget the row has had after the pre-registered one, oldest first; absent when it was never raised. */
  budget_changes: z.array(budgetChangeSchema).optional(),
})
export type ExperimentRow = z.infer<typeof experimentRowSchema>
/** What pre-registers an experiment: the row minus what the ledger fills in. */
export type ExperimentInput = Omit<ExperimentRow, 'id' | 'status' | 'spent' | 'closed_at' | 'round_ids' | 'budget_changes' | 'created_at'> & { created_at?: string }

export function experimentId(coords: ExperimentCoords): string {
  const c = experimentCoordsSchema.parse(coords)
  return sha256(canonicalJson({
    hypothesis: c.hypothesis, prediction: c.prediction, pack: c.pack, gate: c.gate, auto_reveal: c.auto_reveal, created_by: c.created_by, created_at: c.created_at,
  }))
}

// ------------------------------------------------------------------- notebook

/**
 * The session events the workbench mirrors: a call to or result of a framework
 * tool, the spend approval it asked and its answer, a framework command
 * starting or finishing; and `job/done`, the settled outcome of a job a
 * framework tool started (no session event: the tools write it).
 */
export const NOTEBOOK_KINDS = ['tool/call', 'tool/result', 'approval/asked', 'approval/decided', 'command/run', 'command/done', 'job/done'] as const
export const notebookKindSchema = z.enum(NOTEBOOK_KINDS)
export type NotebookKind = z.infer<typeof notebookKindSchema>

/** One decision-relevant event of an operator session; the row carries content addresses of what was said, never the content. */
export const notebookRowSchema = z.object({
  id: z.string().min(1),
  session_id: z.string().min(1),
  /** The event's position in its session; `notebookOf` orders by it. */
  seq: z.number().int().nonnegative(),
  at: z.string(),
  kind: notebookKindSchema,
  /** The tool or command name. */
  name: z.string(),
  args_sha: z.string(),
  result_sha: z.string().optional(),
  /** A result that failed: the harness error code (`UNKNOWN_TOOL` for a name no tool answers to), else `ERROR`. */
  error: z.string().optional(),
  round_id: z.string().optional(),
  experiment_id: z.string().optional(),
  /** The route the operator session ran on. */
  operator: z.object({ provider: z.string().optional(), model: z.string().optional() }),
})
export type NotebookRow = z.infer<typeof notebookRowSchema>

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
    rounds: domainTable<string, RoundRow>(roundRowSchema),
    noise_floors: domainTable<string, NoiseFloorRow>(noiseFloorRowSchema),
    servings: domainTable<string, ServingRow>(servingRowSchema),
    experiments: domainTable<string, ExperimentRow>(experimentRowSchema),
    notebook: domainTable<string, NotebookRow>(notebookRowSchema),
  },
})
export type LedgerDomainSpec = typeof ledgerDomainSpec
