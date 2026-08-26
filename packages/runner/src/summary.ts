// Text summary of one run: per-task status, every metric the pack scored, and
// cost. The metric names are the pack's; the framework reads none of them.

import type { AttemptRow, RunResult } from './run.ts'

export interface Summary {
  attempts: number
  /** Mean of each metric over the attempts scored on it, by name, sorted. */
  means: Record<string, number>
  costUsd: number
  byStatus: Record<string, number>
}

function metric(row: AttemptRow, name: string): number | undefined {
  return row.scores.find((s) => s.metric === name)?.value
}

/** Every metric name the rows carry, sorted. */
function metricsOf(rows: readonly AttemptRow[]): string[] {
  return [...new Set(rows.flatMap((r) => r.scores.map((s) => s.metric)))].sort()
}

export function summarize(rows: readonly AttemptRow[]): Summary {
  const byStatus: Record<string, number> = {}
  const means: Record<string, number> = {}
  let cost = 0
  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1
    cost += r.cost.usd ?? 0
  }
  for (const name of metricsOf(rows)) {
    const values = rows.map((r) => metric(r, name)).filter((v): v is number => v !== undefined)
    means[name] = values.reduce((a, b) => a + b, 0) / values.length
  }
  return { attempts: rows.length, means, costUsd: cost, byStatus }
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length)
}

export function formatSummary(result: RunResult): string {
  const s = summarize(result.rows)
  const metrics = metricsOf(result.rows)
  const cols: [string, (r: AttemptRow) => string][] = [
    ['task', (r) => r.task_id],
    ['status', (r) => `${r.status}/${r.stopReason}`],
    ['valid', (r) => String(r.output.valid)],
    ['truth', (r) => r.truth.status],
    ...metrics.map((name): [string, (r: AttemptRow) => string] => [name, (r) => fmt(metric(r, name))]),
    ['usd', (r) => fmt(r.cost.usd, 4)],
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
    `attempts ${s.attempts}  ${metrics.map((name) => `${name} mean ${fmt(s.means[name])}`).join('  ')}${metrics.length ? '  ' : ''}usd ${s.costUsd.toFixed(4)}  ` +
      Object.entries(s.byStatus).map(([k, v]) => `${k}=${v}`).join(' '),
    `attempts.jsonl: ${result.attemptsPath}`,
  ]
  return out.join('\n')
}

function fmt(v: number | undefined, digits = 3): string {
  return v === undefined ? '-' : v.toFixed(digits)
}
