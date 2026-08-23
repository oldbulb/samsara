// @samsara/gate — the seam types, verbatim from docs/design/gate.md.
//
// The gate turns scores into a verdict. Inputs come from the ledger, never from
// the loop; the framework knows nothing about what a metric means.

export type AttemptStatus = 'COMPLETED' | 'TRUNCATED' | 'ABORTED' | 'FAILED'
export type MetricKind = 'mechanical' | 'reality' | 'judge'
export type Tier = 'smoke' | 'holdin' | 'holdout' | 'live'

export interface ScoredAttempt {
  attemptId: string
  challengerId: string
  taskId: string
  entityKey: string
  stratum?: string
  sample: number
  status: AttemptStatus
  metric: string
  value: number
  kind: MetricKind
  cost: { usd?: number; tokens: number }
  /** Output validity (smoke rule 2). Absent means valid when status is COMPLETED. */
  valid?: boolean
}

export interface GatePolicy {
  alpha: number
  power: number
  bootstrap: { B: number; method: 'bca' }
  /** S2: minimum number of distinct entities with paired data. No default: the pack declares it. */
  nEffFloor: number
  /** Pack-declared minimum effect; when absent only the noise-floor MDE applies. */
  mde?: number
  /** Smoke: output-valid rate floor (rule 2). */
  validityFloor: number
  /** S8: challenger cost / champion cost must be <= maxRatio, or the challenger must be certified on quality. */
  costBudget: { metric: 'cost_usd' | 'tokens'; maxRatio: number }
  /** S4: early stop is futility-only, on the named tier, when z < zStop. */
  futility: { tier: 'holdin'; zStop: number }
  /** S7: holdout accounting (consumed by the book; carried here so the verdict row records it). */
  holdout: { rotateAfterPromotions: number; maxRounds: number }
}

export interface CompareRequest {
  /** Same tasks, same tier, paired by (taskId, sample). */
  challenger: ScoredAttempt[]
  champion: ScoredAttempt[]
  tier: Tier
  /** Must be of kind 'reality' (or 'mechanical' for cost); any 'judge' row is rejected. */
  primaryMetric: string
  /** From >= 3 same-config reruns (S1). */
  noiseFloor: { sdPaired: number; nReruns: number }
  policy: GatePolicy
  /** Holm across the round's K siblings (S4); `index` is this sibling's rank by p-value (0 = most significant). */
  round: { k: number; index: number }
  /** Ladder (S7): the best-so-far holdout delta the proposer has been acknowledged for; absent = none yet. */
  bestSoFar?: number
  /** Seed for the bootstrap PRNG; a fixed seed makes the verdict reproducible from the ledger. */
  seed?: number
  /** Harness facts sha of each side's attempts; when both are present and differ the gate refuses (rule 0, `facts:mismatch`). */
  factsSha?: { challenger: string; champion: string }
}

export interface TaskDelta {
  taskId: string
  entityKey: string
  sample: number
  stratum?: string
  /** challenger value - champion value */
  delta: number
}

export interface Compare {
  perTask: TaskDelta[]
  mean: number
  /** [lower bound at the Holm-adjusted alpha, upper bound at 1 - alpha]; the lower bound is the one-sided test. */
  ci: [number, number]
  method: 'bca'
  clusterKey: 'entity'
  /** Distinct entities with paired data. */
  nEff: number
  /** (z_{1-a/2} + z_{1-b}) * sdPaired / sqrt(nEff), sdPaired from the noise floor. */
  mde: number
  holm: { adjustedAlpha: number }
  costRatio: number
  /** Ladder exposure: step = sd / sqrt(nEff); beatBest = mean > bestSoFar + step. */
  ladder: { step: number; beatBest: boolean }
  counts: { paired: number; unpaired: number; excluded: number; validRate: number }
  /** Which rule decided the verdict. */
  ruleFired: string
}

export type Verdict = 'invalid' | 'drop' | 'hold' | 'hold:underpowered' | 'promote'

export interface GateJudgement {
  compare: Compare
  verdict: Verdict
}

export interface GatePolicyProvider {
  name: string
  version: string
  judge(req: CompareRequest): GateJudgement
}

export const GATE_DEFAULTS = {
  alpha: 0.05,
  power: 0.8,
  bootstrap: { B: 2000, method: 'bca' },
  validityFloor: 0.9,
  costBudget: { metric: 'cost_usd', maxRatio: 1.25 },
  futility: { tier: 'holdin', zStop: -1.0 },
  holdout: { rotateAfterPromotions: 1, maxRounds: 20 },
} as const satisfies Omit<GatePolicy, 'nEffFloor' | 'mde'>

/** Build a policy from the gate.md defaults; `nEffFloor` has no default and must be declared. */
export function gatePolicy(overrides: Partial<GatePolicy> & { nEffFloor: number }): GatePolicy {
  return {
    ...GATE_DEFAULTS,
    ...overrides,
    bootstrap: { ...GATE_DEFAULTS.bootstrap, ...overrides.bootstrap },
    costBudget: { ...GATE_DEFAULTS.costBudget, ...overrides.costBudget },
    futility: { ...GATE_DEFAULTS.futility, ...overrides.futility },
    holdout: { ...GATE_DEFAULTS.holdout, ...overrides.holdout },
  }
}
