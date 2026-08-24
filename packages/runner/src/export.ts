// samsara export: read a run directory's attempts and write their loop events
// as OTLP/JSON traces (one trace per attempt). Pure over the filesystem inputs:
// the same run directory always yields the same document.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { toSpans, toResourceSpans, type AttemptMeta, type LoopEvent, type OtlpResourceSpans, type OtlpSpan } from '@oldbulb/samsara-loops'

export type ExportFormat = 'otlp-json'

export interface ExportRequest {
  /** Run directory: holds `attempts/<attemptId>/events.jsonl` (searched recursively, so challenge/certify layouts work too). */
  run: string
  format: ExportFormat
  out: string
  /** Attributes the run directory does not record; forwarded onto every span. */
  challengerId?: string
  tier?: string
  model?: string
  provider?: string
}

export interface ExportResult {
  attempts: number
  spans: number
  out: string
}

/** Every `attempts/<id>/events.jsonl` below `dir`, sorted for a stable document. */
export function findEventFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name)
      if (name === 'node_modules') continue
      if (statSync(p).isDirectory()) walk(p)
      else if (name === 'events.jsonl' && basename(dirname(dirname(p))) === 'attempts') out.push(p)
    }
  }
  walk(dir)
  return out
}

export function readEvents(file: string): LoopEvent[] {
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as LoopEvent)
}

/** Rows of the sibling `attempts.jsonl` (or `*-attempts.jsonl`) next to an `attempts/` directory, keyed by attemptId. */
function rowsBeside(attemptsDir: string): Map<string, { loop?: string; facts_sha?: string }> {
  const rows = new Map<string, { loop?: string; facts_sha?: string }>()
  const parent = dirname(attemptsDir)
  for (const name of readdirSync(parent)) {
    if (!name.endsWith('attempts.jsonl')) continue
    for (const line of readFileSync(join(parent, name), 'utf8').split('\n')) {
      if (!line.trim()) continue
      const row = JSON.parse(line) as { attemptId?: string; loop?: string; facts_sha?: string }
      if (row.attemptId) rows.set(row.attemptId, { ...(row.loop !== undefined ? { loop: row.loop } : {}), ...(row.facts_sha !== undefined ? { facts_sha: row.facts_sha } : {}) })
    }
  }
  return rows
}

/** Build the OTLP/JSON document (`{ resourceSpans: [...] }`) for a run directory. */
export function exportRun(req: Omit<ExportRequest, 'out' | 'format'>): { resourceSpans: OtlpResourceSpans[]; attempts: number; spans: number } {
  const run = resolve(req.run)
  if (!existsSync(run)) throw new Error(`run directory not found: ${run}`)
  const spans: OtlpSpan[] = []
  let attempts = 0
  const rowCache = new Map<string, Map<string, { loop?: string; facts_sha?: string }>>()
  for (const file of findEventFiles(run)) {
    const attemptDir = dirname(file)
    const attemptsDir = dirname(attemptDir)
    let rows = rowCache.get(attemptsDir)
    if (!rows) { rows = rowsBeside(attemptsDir); rowCache.set(attemptsDir, rows) }
    const attemptId = basename(attemptDir)
    const row = rows.get(attemptId)
    const meta: AttemptMeta = {
      attemptId,
      ...(req.challengerId !== undefined ? { challengerId: req.challengerId } : {}),
      ...(req.tier !== undefined ? { tier: req.tier } : {}),
      ...(req.model !== undefined ? { model: req.model } : {}),
      ...(req.provider !== undefined ? { provider: req.provider } : {}),
      ...(row?.loop !== undefined ? { loop: row.loop } : {}),
      ...(row?.facts_sha !== undefined ? { factsSha: row.facts_sha } : {}),
    }
    const s = toSpans(meta, readEvents(file))
    if (s.length === 0) continue
    attempts += 1
    spans.push(...s)
  }
  return { resourceSpans: [toResourceSpans(spans, { 'samsara.run_dir': basename(run) })], attempts, spans: spans.length }
}

export function formatExport(r: ExportResult): string {
  return `exported ${r.attempts} attempt(s), ${r.spans} span(s) → ${r.out}`
}
