// What a consumer can do next with one row, pure: data from the ledger in,
// a list of actions with the numbers the verdict rule used and a cost
// estimate out. The service gathers the inputs; nothing here reads a context.

import type { TaskSet } from '@oldbulb/samsara-book'
import type { ChallengerRow, CompareRow, Tier } from '@oldbulb/samsara-ledger'

export type NextActionKind = 'open' | 'run' | 'judge' | 'replicate' | 'holdout' | 'drop' | 'decide'

export interface NextAction {
  kind: NextActionKind
  tier?: Tier
  /** Attempts the action runs, and what they cost when the ledger knows a per-attempt cost. */
  estimate?: { attempts: number; usd?: number }
  /** The numbers the verdict rule used. */
  numbers?: { rule: string; mde: number; n_eff: number; replicates: number; min_effect: number; sd?: number }
  /** The pack's holdout budget, when it declares one. */
  budget?: { remaining: number; spent: number }
}

export interface NextActionsInput {
  row: ChallengerRow
  /** The promotion-gate compare row on the tier reached; absent when none was recorded. */
  compare?: CompareRow
  /** sd_paired of the noise floor the row was judged under, when one exists. */
  sd?: number
  /** Tasks per set the pack declares. */
  taskCounts: Record<TaskSet, number>
  /** Mean usd per attempt of the champion on the tier reached, when the ledger knows one. */
  meanUsd?: number
  budget?: { remaining: number; spent: number }
}

function estimate(attempts: number, meanUsd: number | undefined): NonNullable<NextAction['estimate']> {
  return { attempts, ...(meanUsd !== undefined ? { usd: attempts * meanUsd } : {}) }
}

export function nextActionsOf(input: NextActionsInput): NextAction[] {
  const { row, compare } = input
  if (row.status === 'proposed') return [{ kind: 'open' }]
  if (row.status === 'opened') return [{ kind: 'run', tier: 'smoke' }]
  if (row.status === 'running') return [{ kind: 'judge', ...(row.tier_reached !== undefined ? { tier: row.tier_reached } : {}) }]
  if (row.status !== 'judged' || !row.verdict) return []
  const value = row.verdict.value
  if (value === 'promote') return [{ kind: 'decide' }]
  if (value !== 'hold' && value !== 'hold:superseded') return []
  const tier = row.tier_reached
  if (tier === undefined || tier === 'live') return [{ kind: 'drop' }]
  const numbers = compare
    ? { rule: compare.rule_fired, mde: compare.mde, n_eff: compare.n_eff, replicates: compare.replicates ?? 0, min_effect: compare.min_effect ?? 0, ...(input.sd !== undefined ? { sd: input.sd } : {}) }
    : undefined
  const out: NextAction[] = []
  out.push({ kind: 'replicate', tier, estimate: estimate(input.taskCounts[tier], input.meanUsd), ...(numbers ? { numbers } : {}) })
  if (tier !== 'holdout') {
    const replicates = Math.max(1, Math.round(compare?.replicates ?? 1))
    out.push({
      kind: 'holdout', tier: 'holdout',
      estimate: estimate(input.taskCounts.holdout * replicates, input.meanUsd),
      ...(numbers ? { numbers } : {}),
      ...(input.budget ? { budget: input.budget } : {}),
    })
  }
  out.push({ kind: 'drop' })
  return out
}
