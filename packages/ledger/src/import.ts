// Ingest the runner's attempts.jsonl (packages/runner/src/run.ts AttemptRow)
// into the ledger: one attempts row per line plus one scores row per score
// line. Truth per task is pinned as the score's truth_snapshot_id unless the
// caller supplies a book-level snapshot id.

import { readFileSync } from 'node:fs'
import type { Ledger } from './index.ts'
import type { AttemptRow, ScoreRow, Tier } from './spec.ts'

export interface ImportOptions {
  challengerId: string
  loop: string
  /** Task set the run was on; the runner's line does not carry it. Default: holdin. */
  tier?: Tier
  scorerVersion?: string
  /** Book-level snapshot id; default: the line's truth_sha (or 'unsettled'). */
  truthSnapshotId?: string
}

export interface ImportResult {
  attempts: string[]
  scores: string[]
  skipped: number
}

/** The runner's attempts.jsonl line shape (structural; only the fields the ledger keeps). */
export interface RunnerLine {
  attemptId: string
  task_id: string
  loop?: string
  facts_sha?: string
  status: AttemptRow['status']
  stopReason?: string
  usage?: { inputTokens?: number; outputTokens?: number }
  cost?: { source?: string; usd?: number; wallMs?: number }
  toolCalls?: number
  output?: { valid?: boolean; file?: string }
  truth?: { status?: string; truth_sha?: string }
  scores?: { task_id: string; metric: string; value: number; kind: ScoreRow['kind']; stratum?: string }[]
}

function sampleOf(attemptId: string): number {
  const m = /-(\d+)$/.exec(attemptId)
  return m ? Number(m[1]) : 0
}

export function attemptRowOf(line: RunnerLine, opts: ImportOptions): AttemptRow {
  const input = line.usage?.inputTokens ?? 0
  const output = line.usage?.outputTokens ?? 0
  return {
    id: line.attemptId,
    challenger_id: opts.challengerId,
    task_id: line.task_id,
    sample: sampleOf(line.attemptId),
    loop: line.loop ?? opts.loop,
    tier: opts.tier ?? 'holdin',
    status: line.status,
    stop_reason: line.stopReason ?? 'unknown',
    facts_sha: line.facts_sha ?? '',
    usage: { input_tokens: input, output_tokens: output },
    cost: {
      tokens: input + output,
      ...(line.cost?.usd !== undefined ? { usd: line.cost.usd } : {}),
      ...(line.cost?.wallMs !== undefined ? { wall_s: line.cost.wallMs / 1000 } : {}),
    },
    output: { source: line.cost?.source ?? 'unknown', valid: line.output?.valid ?? false },
    artifacts: line.output?.file ? [{ name: 'submit', sha: '', path: line.output.file }] : [],
  }
}

export async function importAttemptsJsonl(ledger: Ledger, path: string, opts: ImportOptions): Promise<ImportResult> {
  const result: ImportResult = { attempts: [], scores: [], skipped: 0 }
  const text = readFileSync(path, 'utf8')
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue
    let line: RunnerLine
    try {
      line = JSON.parse(raw) as RunnerLine
    } catch {
      result.skipped++
      continue
    }
    if (!line.attemptId || !line.task_id) {
      result.skipped++
      continue
    }
    result.attempts.push(await ledger.recordAttempt(attemptRowOf(line, opts)))
    const truth_snapshot_id = opts.truthSnapshotId ?? line.truth?.truth_sha ?? 'unsettled'
    const scores: ScoreRow[] = (line.scores ?? []).map((s) => ({
      attempt_id: line.attemptId,
      scorer_version: opts.scorerVersion ?? 'unknown',
      truth_snapshot_id,
      metric: s.metric,
      value: s.value,
      kind: s.kind,
      ...(s.stratum !== undefined ? { stratum: s.stratum } : {}),
    }))
    result.scores.push(...(await ledger.appendScores(scores)))
  }
  return result
}
