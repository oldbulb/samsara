// Limit bookkeeping for one attempt, kept pure so it can be unit-tested with
// synthetic events. The provider wires `preStep` into `agent/pre-step`, the
// duration timer into `agent.cancel`, and `observeUsage` into every
// `assistant/message`. The first limit to fire owns the stop reason.

import type { TokenUsage } from '@oldbulb/samsara-loops'

export type LimitStop = 'max_turns' | 'timeout' | 'budget' | 'aborted'

export interface PriceTable {
  /** USD per million input tokens (cache misses). */
  input: number
  /** USD per million output tokens. */
  output: number
  /** USD per million cache-read input tokens; defaults to `input`. */
  cacheRead?: number
}

export interface LimitsOptions {
  maxTurns: number
  maxBudgetUsd?: number
  price?: PriceTable
}

export interface Limits {
  /** Steps admitted so far (a step is one model call). */
  readonly steps: number
  /** Which limit (or host cancel) fired first, if any. */
  readonly stop: LimitStop | undefined
  /** Decide whether the next model step may run. */
  preStep(): 'enter' | 'reject'
  /** Record a cancellation cause; the first one wins. Returns true when it was recorded. */
  trip(stop: LimitStop): boolean
  /** Check the running total against `maxBudgetUsd`; returns true when it trips the budget. */
  observeUsage(total: TokenUsage): boolean
  costUsd(total: TokenUsage): number | undefined
}

export function addUsage(total: TokenUsage, usage: TokenUsage | undefined): TokenUsage {
  if (!usage) return total
  const opt = (a: number | undefined, b: number | undefined) => (a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0))
  const out: TokenUsage = { inputTokens: total.inputTokens + usage.inputTokens, outputTokens: total.outputTokens + usage.outputTokens }
  const cacheRead = opt(total.cacheReadTokens, usage.cacheReadTokens)
  const cacheWrite = opt(total.cacheWriteTokens, usage.cacheWriteTokens)
  const reasoning = opt(total.reasoningTokens, usage.reasoningTokens)
  if (cacheRead !== undefined) out.cacheReadTokens = cacheRead
  if (cacheWrite !== undefined) out.cacheWriteTokens = cacheWrite
  if (reasoning !== undefined) out.reasoningTokens = reasoning
  return out
}

/**
 * `inputTokens` and `cacheReadTokens` are disjoint (see TokenUsage), so each is
 * priced on its own and neither is subtracted from the other. Subtracting —
 * which an earlier gateway made look necessary, because it reported the whole
 * prompt as cache reads — bills cache-missed input at zero on any provider that
 * reports the two counts correctly.
 */
export function priceUsage(usage: TokenUsage, price: PriceTable): number {
  const cacheRead = usage.cacheReadTokens ?? 0
  const cacheReadPrice = price.cacheRead ?? price.input
  return (usage.inputTokens * price.input + cacheRead * cacheReadPrice + usage.outputTokens * price.output) / 1e6
}

export function createLimits(options: LimitsOptions): Limits {
  let steps = 0
  let stop: LimitStop | undefined
  return {
    get steps() {
      return steps
    },
    get stop() {
      return stop
    },
    preStep() {
      if (stop !== undefined) return 'reject'
      if (steps >= options.maxTurns) {
        stop = 'max_turns'
        return 'reject'
      }
      steps += 1
      return 'enter'
    },
    trip(reason) {
      if (stop !== undefined) return false
      stop = reason
      return true
    },
    observeUsage(total) {
      if (options.maxBudgetUsd === undefined || options.price === undefined) return false
      if (priceUsage(total, options.price) <= options.maxBudgetUsd) return false
      return this.trip('budget')
    },
    costUsd(total) {
      return options.price ? priceUsage(total, options.price) : undefined
    },
  }
}
