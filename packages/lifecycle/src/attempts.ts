// Ledger attempts as the gate reads them, pure: the latest attempt per
// (task, sample) among the rows on the tasks in question, joined with its
// primary-metric score.

import type { ScoredAttempt } from '@oldbulb/samsara-gate'
import type { AttemptRow, ScoreRow } from '@oldbulb/samsara-ledger'

/** Latest attempt per (task, sample) on these tasks; run ids sort by time, so the highest id wins. */
export function latestAttempts(attempts: readonly AttemptRow[], tasks: ReadonlyMap<string, string>): AttemptRow[] {
  const latest = new Map<string, AttemptRow>()
  for (const a of [...attempts].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))) {
    if (tasks.has(a.task_id)) latest.set(`${a.task_id}\0${a.sample}`, a)
  }
  return [...latest.values()]
}

export function scoredAttemptsOf(
  attempts: readonly AttemptRow[],
  scoresOf: (attemptId: string) => ScoreRow[],
  tasks: ReadonlyMap<string, string>,
  metric: string,
): ScoredAttempt[] {
  const out: ScoredAttempt[] = []
  for (const a of latestAttempts(attempts, tasks)) {
    const score = scoresOf(a.id).find((s) => s.metric === metric)
    if (!score) continue
    out.push({
      attemptId: a.id,
      challengerId: a.challenger_id,
      taskId: a.task_id,
      entityKey: tasks.get(a.task_id) ?? a.task_id,
      ...(score.stratum !== undefined ? { stratum: score.stratum } : {}),
      sample: a.sample,
      status: a.status,
      metric: score.metric,
      value: score.value,
      kind: score.kind,
      cost: { tokens: a.cost.tokens ?? a.usage.input_tokens + a.usage.output_tokens, ...(a.cost.usd !== undefined ? { usd: a.cost.usd } : {}) },
      valid: a.output.valid,
    })
  }
  return out
}
