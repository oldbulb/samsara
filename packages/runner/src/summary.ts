// Text summary of one run: per-task status and aggregate pass_rate / cost.

import type { AttemptRow, RunResult } from './run.ts'

export interface Summary {
  attempts: number
  passRateMean: number | undefined
  costUsd: number
  byStatus: Record<string, number>
}

function metric(row: AttemptRow, name: string): number | undefined {
  return row.scores.find((s) => s.metric === name)?.value
}

export function summarize(rows: readonly AttemptRow[]): Summary {
  const rates = rows.map((r) => metric(r, 'pass_rate')).filter((v): v is number => v !== undefined)
  const byStatus: Record<string, number> = {}
  let cost = 0
  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1
    cost += r.cost.usd ?? metric(r, 'cost_usd') ?? 0
  }
  return {
    attempts: rows.length,
    passRateMean: rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : undefined,
    costUsd: cost,
    byStatus,
  }
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length)
}

export function formatSummary(result: RunResult): string {
  const s = summarize(result.rows)
  const cols: [string, (r: AttemptRow) => string][] = [
    ['task', (r) => r.task_id],
    ['status', (r) => `${r.status}/${r.stopReason}`],
    ['valid', (r) => String(r.output.valid)],
    ['truth', (r) => r.truth.status],
    ['pass_rate', (r) => fmt(metric(r, 'pass_rate'))],
    ['cost_usd', (r) => fmt(r.cost.usd ?? metric(r, 'cost_usd'), 4)],
    ['tools', (r) => String(r.toolCalls)],
  ]
  const widths = cols.map(([h, f]) => Math.max(h.length, ...result.rows.map((r) => f(r).length)))
  const line = (cells: string[]) => cells.map((c, i) => pad(c, widths[i] ?? 0)).join('  ')
  const out = [
    `run ${result.runId}  pack ${result.pack}  set ${result.set}  taskset ${result.tasksetSha.slice(0, 12)}`,
    line(cols.map(([h]) => h)),
    line(widths.map((w) => '-'.repeat(w))),
    ...result.rows.map((r) => line(cols.map(([, f]) => f(r)))),
    '',
    `attempts ${s.attempts}  pass_rate mean ${fmt(s.passRateMean)}  cost_usd ${s.costUsd.toFixed(4)}  ` +
      Object.entries(s.byStatus).map(([k, v]) => `${k}=${v}`).join(' '),
    `attempts.jsonl: ${result.attemptsPath}`,
  ]
  return out.join('\n')
}

function fmt(v: number | undefined, digits = 3): string {
  return v === undefined ? '-' : v.toFixed(digits)
}
