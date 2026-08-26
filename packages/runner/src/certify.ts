// Cross-harness certification (docs/design/ui-and-certification.md): the same
// skill snapshot runs as a challenger on each named loop in turn (challenge()
// per loop, each in its own round on ctx.lifecycle; the champion runs on that
// loop too when the ledger holds nothing), and the table lists one judged row
// per loop. Loops are never pooled: a
// cross-loop compare is put through the gate once, to show the refusal.

import { basename, resolve } from 'node:path'
import { mean } from '@oldbulb/samsara-gate'
import { gatePolicy, type ScoredAttempt } from '@oldbulb/samsara-gate'
import type { AttemptRow as LedgerAttemptRow, CompareRow } from '@oldbulb/samsara-ledger'
import { factsSha, type LoopProvider } from '@oldbulb/samsara-loops'
import { challenge as runChallenge, scoredAttemptsOf, type ChallengeDeps, type ChallengeRequest, type ChallengeResult, type GatePolicyName } from './challenge.ts'
import type { RunRequest } from './run.ts'

export interface CertifyRequest extends Omit<RunRequest, 'loop' | 'skillDir'> {
  skillDir: string
  /** Loop provider names, certified in this order. */
  loops: string[]
  metric: string
  nEffFloor: number
  gatePolicy: GatePolicyName
}

export interface CertifyDeps extends ChallengeDeps {
  /** Test seam: replaces challenge(). */
  challengeFn?: (req: ChallengeRequest, deps: ChallengeDeps) => Promise<ChallengeResult>
}

export interface CertifyRow {
  loop: string
  adapterVersion: string
  factsSha: string
  challengerId: string
  championId: string
  tasks: number
  /** Mean of the primary metric over the challenger's scored attempts. */
  mean: number
  utilization: number | 'inline' | undefined
  costMean: number
  costUnit: 'usd' | 'tokens'
  /** The gate's verdict, `revoked` when the ledger row was since reversed, `rejected` when the diff scan refused the patch. */
  verdict: string
  rule: string
  gateMethod: string
  /** The judgement came from a gate other than the promotion gate without a `gate_change` consent: listed, never the verdict. */
  shadow: boolean
}

export interface CrossCheck {
  challengerLoop: string
  championLoop: string
  verdict: string
  rule: string
}

export interface CertifyResult {
  skillSha: string
  /** The primary metric the rows' means are of. */
  metric: string
  rows: CertifyRow[]
  /** Absent with fewer than two judged loops. */
  cross?: CrossCheck
}

/** 'inline' when every reporting attempt says so, else the mean read fraction (inline counts as 1); undefined when none reports. */
export function utilizationOf(attempts: readonly LedgerAttemptRow[]): CertifyRow['utilization'] {
  const values = attempts.map((a) => a.skill_utilization?.['value']).filter((v): v is number | 'inline' => v === 'inline' || typeof v === 'number')
  if (values.length === 0) return undefined
  if (values.every((v) => v === 'inline')) return 'inline'
  return mean(values.map((v) => (v === 'inline' ? 1 : v)))
}

function costOf(scored: readonly ScoredAttempt[]): { mean: number; unit: CertifyRow['costUnit'] } {
  const usd = scored.length > 0 && scored.every((a) => a.cost.usd !== undefined)
  return usd ? { mean: mean(scored.map((a) => a.cost.usd!)), unit: 'usd' } : { mean: mean(scored.map((a) => a.cost.tokens)), unit: 'tokens' }
}

function tasksOf(attempts: readonly LedgerAttemptRow[]): Map<string, string> {
  return new Map(attempts.map((a) => [a.task_id, a.task_id]))
}

export async function certify(req: CertifyRequest, deps: CertifyDeps): Promise<CertifyResult> {
  const log = deps.log ?? (() => {})
  const challengeFn = deps.challengeFn ?? runChallenge
  const { loops, ...rest } = req
  for (const loop of loops) {
    if (deps.loops.get(loop) === undefined) throw new Error(`no loop provider named "${loop}" is registered (is its plugin enabled in the profile?)`)
  }

  const rows: CertifyRow[] = []
  const judged: { row: CertifyRow; provider: LoopProvider; challenger: ScoredAttempt[]; champion: ScoredAttempt[] }[] = []
  let skillSha = ''
  for (const loop of loops) {
    const provider = deps.loops.get(loop)!
    const result = await challengeFn({
      ...rest, loop, out: resolve(req.out, loop),
      surface: 'skill', intent: `certify ${basename(req.skillDir)} on ${loop}`, withChampion: false,
    }, deps)
    skillSha ||= deps.ledger.challenger(result.challengerId)?.skill_sha ?? ''
    const attempts = deps.ledger.attemptsOf(result.challengerId)
    const tasks = tasksOf(attempts)
    const scores = (id: string) => deps.ledger.scoresOf(id)
    const challenger = scoredAttemptsOf(attempts, scores, tasks, req.metric)
    const champion = scoredAttemptsOf(deps.ledger.attemptsOf(result.championId), scores, tasks, req.metric)
    const cost = costOf(challenger)
    const current = deps.ledger.challenger(result.challengerId)?.verdict
    const c: CompareRow | undefined = result.compare
    // A rejection now, or one the ledger already held (the row was decided before this command).
    const rejected = result.rejected !== undefined || current?.by === 'diffscan'
    const row: CertifyRow = {
      loop,
      adapterVersion: provider.harnessFacts.version.loop,
      factsSha: factsSha(provider.harnessFacts),
      challengerId: result.challengerId,
      championId: result.championId,
      tasks: tasks.size,
      mean: mean(challenger.map((a) => a.value)),
      utilization: utilizationOf(attempts),
      costMean: cost.mean,
      costUnit: cost.unit,
      verdict: current?.value === 'reversed' ? 'revoked' : rejected ? 'rejected' : result.invalid !== undefined ? 'invalid' : c?.verdict.value ?? result.decided?.value ?? 'n/a',
      rule: rejected ? (current?.rule ?? 'diffscan') : result.invalid ?? c?.rule_fired ?? result.decided?.rule ?? '',
      gateMethod: c?.gate ?? c?.verdict.by ?? (rejected ? 'diffscan' : result.invalid !== undefined ? 'lifecycle' : result.decided?.by ?? ''),
      shadow: result.shadow ?? false,
    }
    rows.push(row)
    log(`certify ${loop}: ${fmtVerdict(row)} ${req.metric} ${fmt(row.mean)} utilization ${fmtUtil(row.utilization)}`)
    if (c) judged.push({ row, provider, challenger, champion })
  }

  // Cross-loop: challenger on loop a vs champion on loop b must be refused by rule 0.
  let cross: CrossCheck | undefined
  const [a, b] = judged
  if (a && b) {
    const verdict = await deps.gate.judge({
      challenger: a.challenger, champion: b.champion, tier: req.set, primaryMetric: req.metric,
      noiseFloor: { sdPaired: 0, nReruns: 0 }, policy: gatePolicy({ nEffFloor: req.nEffFloor }), round: { k: 1, index: 0 }, seed: 0,
      factsSha: { challenger: a.row.factsSha, champion: b.row.factsSha },
    })
    cross = { challengerLoop: a.row.loop, championLoop: b.row.loop, verdict: verdict.verdict, rule: verdict.compare.ruleFired }
  }
  return { skillSha, metric: req.metric, rows, ...(cross ? { cross } : {}) }
}

function fmt(v: number): string {
  return Number.isFinite(v) ? v.toFixed(3) : 'n/a'
}

function fmtUtil(u: CertifyRow['utilization']): string {
  return u === undefined ? 'n/a' : u === 'inline' ? 'inline' : u.toFixed(2)
}

function fmtVerdict(row: CertifyRow): string {
  return (row.rule ? `${row.verdict} (${row.rule})` : row.verdict) + (row.shadow ? ' [shadow]' : '')
}

export function formatCertify(r: CertifyResult): string {
  const header = ['loop', 'adapter version', 'facts_sha', 'tasks', r.metric, 'utilization', 'cost mean', 'verdict', 'gate']
  const body = r.rows.map((row) => [
    row.loop, row.adapterVersion, row.factsSha.slice(0, 12), String(row.tasks), fmt(row.mean), fmtUtil(row.utilization),
    `${fmt(row.costMean)} ${row.costUnit}`, fmtVerdict(row), row.gateMethod,
  ])
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((b) => b[i]!.length)))
  const line = (cells: string[]) => '| ' + cells.map((c, i) => c.padEnd(widths[i]!)).join(' | ') + ' |'
  const out = [`skill ${r.skillSha ? r.skillSha.slice(0, 12) : '(unknown)'}`, line(header), '|' + widths.map((w) => '-'.repeat(w + 2)).join('|') + '|', ...body.map(line)]
  if (r.cross) {
    const c = r.cross
    const ok = c.verdict === 'invalid' && c.rule === 'facts:mismatch'
    out.push(`cross-loop ${c.challengerLoop} vs ${c.championLoop}: ${c.verdict} (${c.rule}) — ${ok ? 'refused as expected; loops are listed, never pooled' : 'UNEXPECTED: the gate did not refuse'}`)
  }
  return out.join('\n')
}
