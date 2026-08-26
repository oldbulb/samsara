// @oldbulb/samsara-ledger — `ctx.ledger`: the one control-plane record.
//
// A cordis Service over a dsh storage domain (`samsara_ledger`). Every write
// goes through the domain tables (put / update), so durability precedes
// memory; reads are synchronous from the domain's in-memory state. Keys are
// content-addressed (spec.ts), which is what makes propose() idempotent,
// scores append-only and compares first-verdict-wins.

import { Context, Service, type Domain, type KvTable } from '@oldbulb/samsara-kernel'
import {
  ledgerDomainSpec,
  challengerId,
  challengerRowSchema,
  attemptRowSchema,
  scoreRowSchema,
  scoreKey,
  compareRowSchema,
  compareKey,
  consentRowSchema,
  settlementRowSchema,
  evalConfigSha,
  roundId,
  roundRowSchema,
  noiseFloorId,
  noiseFloorRowSchema,
  servingRowSchema,
  experimentId,
  experimentRowSchema,
  notebookRowSchema,
  type AttemptRow,
  type ChallengerProposal,
  type ChallengerRow,
  type CompareRow,
  type ConsentRow,
  type ExperimentInput,
  type ExperimentRow,
  type LedgerDomainSpec,
  type NoiseFloorInput,
  type NoiseFloorRow,
  type NotebookRow,
  type RoundInput,
  type RoundRow,
  type ScoreRow,
  type ServingRow,
  type SettlementRow,
} from './spec.ts'

export * from './spec.ts'
export { sha256, canonicalJson, keyOf } from './id.ts'
export { importAttemptsJsonl, attemptRowOf, type ImportOptions, type ImportResult } from './import.ts'
export { backupSqlite } from './backup.ts'

declare module '@oldbulb/samsara-kernel' {
  interface Context {
    ledger: Ledger
  }
}

export type LedgerErrorCode = 'VERDICT_EXISTS' | 'ATTEMPT_EXISTS' | 'UNKNOWN_CHALLENGER' | 'UNKNOWN_ROUND' | 'UNKNOWN_EXPERIMENT' | 'NOT_OPEN'

export class LedgerError extends Error {
  constructor(message: string, readonly code: LedgerErrorCode) {
    super(message)
    this.name = 'LedgerError'
  }
}

export type Viewer = 'proposer' | 'gate' | 'human' | 'operator'
export type View = keyof LedgerDomainSpec['tables']

/** What a proposer sees instead of held-out per-task attempt rows. */
export interface AttemptAggregate {
  redacted: true
  challenger_id: string
  tier: 'holdout'
  n: number
  by_status: Record<string, number>
}

/** What a proposer sees instead of held-out per-task score rows. */
export interface ScoreAggregate {
  redacted: true
  challenger_id: string
  tier: 'holdout'
  metric: string
  scorer_version: string
  truth_snapshot_id: string
  n: number
  mean: number
}

/**
 * What a proposer sees instead of a held-out compare row: the verdict and the
 * Ladder signal (S7: beat best-so-far yes/no, the best-so-far rounded to two
 * decimals); never the row's own mean or task count, the per-task deltas, the
 * interval or the power figures. `ladder` is absent when the row has none.
 */
export interface CompareAggregate {
  redacted: true
  challenger_id: string
  vs_id: string
  tier: 'holdout'
  method: string
  rule_fired: string
  verdict: CompareRow['verdict']
  ladder?: { beat_best: boolean; best_so_far?: number }
}

/** What an operator sees instead of a compare row, on every tier: the row without its per-task deltas. */
export type CompareWithoutTasks = Omit<CompareRow, 'per_task'>

export type ViewRows = {
  challengers: ChallengerRow[]
  attempts: (AttemptRow | AttemptAggregate)[]
  scores: (ScoreRow | ScoreAggregate)[]
  compares: (CompareRow | CompareAggregate | CompareWithoutTasks)[]
  consents: ConsentRow[]
  settlements: SettlementRow[]
  rounds: RoundRow[]
  noise_floors: NoiseFloorRow[]
  servings: ServingRow[]
  experiments: ExperimentRow[]
  notebook: NotebookRow[]
}

type ViewRowOf<N extends View> = {
  challengers: ChallengerRow
  attempts: AttemptRow
  scores: ScoreRow
  compares: CompareRow
  consents: ConsentRow
  settlements: SettlementRow
  rounds: RoundRow
  noise_floors: NoiseFloorRow
  servings: ServingRow
  experiments: ExperimentRow
  notebook: NotebookRow
}[N]

/** Operator objects: never rendered to a proposer, whatever the tier. */
const OPERATOR_VIEWS: readonly View[] = ['rounds', 'noise_floors', 'experiments', 'notebook']

export class Ledger extends Service {
  static inject = ['storageDomain']

  private domain: Domain<LedgerDomainSpec> | undefined

  constructor(ctx: Context) {
    super(ctx, 'ledger')
  }

  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(ledgerDomainSpec)
    this.ctx.effect(() => async () => {
      this.domain = undefined
      await domain.close()
    }, 'ledger.domainClose')
    this.domain = domain
  }

  private table<N extends View>(name: N): KvTable<string, ViewRowOf<N>> {
    if (!this.domain) throw new LedgerError('ledger domain is not open', 'NOT_OPEN')
    return this.domain.table(name) as KvTable<string, ViewRowOf<N>>
  }

  // ------------------------------------------------------------------ verbs

  /** Compute the id from the coordinates and `eval_config_sha` from the row; a duplicate id returns the existing row's id without writing. */
  async propose(proposal: ChallengerProposal): Promise<string> {
    const id = challengerId(proposal)
    const table = this.table('challengers')
    if (table.get(id)) return id
    const row = challengerRowSchema.parse({
      ...proposal,
      id,
      eval_config_sha: evalConfigSha(proposal),
      status: 'proposed',
      proposed_at: proposal.proposed_at ?? new Date().toISOString(),
    })
    await table.put(id, row)
    return id
  }

  /** The only mutable fields of a challenger row: status, tier reached, verdict, and the evidence of its opening. */
  async setStatus(
    id: string,
    status: ChallengerRow['status'],
    patch: Partial<Pick<ChallengerRow, 'tier_reached' | 'verdict' | 'opened'>> = {},
  ): Promise<ChallengerRow> {
    const table = this.table('challengers')
    if (!table.get(id)) throw new LedgerError(`no challenger ${id}`, 'UNKNOWN_CHALLENGER')
    return table.update(id, (cur) => challengerRowSchema.parse({ ...cur, ...patch, status }))
  }

  /** An attempt id belongs to one challenger: re-recording it under another throws ATTEMPT_EXISTS; the same challenger's row replaces it. */
  async recordAttempt(row: AttemptRow): Promise<string> {
    const parsed = attemptRowSchema.parse(row)
    const table = this.table('attempts')
    const existing = table.get(parsed.id)
    if (existing && existing.challenger_id !== parsed.challenger_id) {
      throw new LedgerError(`attempt ${parsed.id} belongs to challenger ${existing.challenger_id}, not ${parsed.challenger_id}`, 'ATTEMPT_EXISTS')
    }
    await table.put(parsed.id, parsed)
    return parsed.id
  }

  /** Append-only: a row whose key already exists is skipped; returns the keys actually written. */
  async appendScores(rows: ScoreRow[]): Promise<string[]> {
    const table = this.table('scores')
    const written: string[] = []
    for (const raw of rows) {
      const row = scoreRowSchema.parse(raw)
      const key = scoreKey(row)
      if (table.get(key)) continue
      await table.put(key, row)
      written.push(key)
    }
    return written
  }

  /** First verdict wins: a second compare for the same (challenger, vs, tier, truth snapshot, replicates) throws VERDICT_EXISTS. */
  async recordCompare(row: CompareRow): Promise<string> {
    const parsed = compareRowSchema.parse(row)
    const key = compareKey(parsed)
    const table = this.table('compares')
    if (table.get(key)) {
      throw new LedgerError(
        `a verdict already exists for ${parsed.challenger_id} vs ${parsed.vs_id} at tier ${parsed.tier} on truth ${parsed.truth_snapshot_id} at ${parsed.replicates ?? 1} replicate(s)${parsed.shadow ? ` (shadow, gate ${parsed.gate})` : ''}`,
        'VERDICT_EXISTS',
      )
    }
    await table.put(key, parsed)
    return key
  }

  /** Immutable by id: re-recording an existing consent id is a no-op. */
  async recordConsent(row: ConsentRow): Promise<string> {
    const parsed = consentRowSchema.parse(row)
    const table = this.table('consents')
    if (!table.get(parsed.id)) await table.put(parsed.id, parsed)
    return parsed.id
  }

  /** Immutable by id: re-recording an existing settlement id is a no-op. */
  async recordSettlement(row: SettlementRow): Promise<string> {
    const parsed = settlementRowSchema.parse(row)
    const table = this.table('settlements')
    if (!table.get(parsed.id)) await table.put(parsed.id, parsed)
    return parsed.id
  }

  /** Compute the id from the round's coordinates; a duplicate id returns the existing row without writing. `k` is the sibling count. */
  async openRound(input: RoundInput): Promise<RoundRow> {
    const opened_at = input.opened_at ?? new Date().toISOString()
    const id = roundId({ ...input, opened_at })
    const table = this.table('rounds')
    const existing = table.get(id)
    if (existing) return existing
    const sibling_ids = input.sibling_ids ?? []
    const row = roundRowSchema.parse({ ...input, id, opened_at, sibling_ids, k: sibling_ids.length, status: 'open' })
    await table.put(id, row)
    return row
  }

  /** The mutable fields of a round: status, siblings (`k` follows), noise floor, best-so-far, closing time and outcome. */
  async updateRound(
    id: string,
    patch: Partial<Pick<RoundRow, 'status' | 'sibling_ids' | 'noise_floor_id' | 'best_so_far' | 'closed_at' | 'outcome'>>,
  ): Promise<RoundRow> {
    const table = this.table('rounds')
    if (!table.get(id)) throw new LedgerError(`no round ${id}`, 'UNKNOWN_ROUND')
    return table.update(id, (cur) => {
      const next = { ...cur, ...patch }
      return roundRowSchema.parse({ ...next, k: next.sibling_ids.length })
    })
  }

  /** Compute the id from the measurement's coordinates; re-recording an existing id is a no-op. */
  async recordNoiseFloor(input: NoiseFloorInput): Promise<string> {
    const id = noiseFloorId(input)
    const parsed = noiseFloorRowSchema.parse({ ...input, id })
    const table = this.table('noise_floors')
    if (!table.get(id)) await table.put(id, parsed)
    return id
  }

  /**
   * A serving row is immutable except `to`: recording an id that exists
   * closes that serving with the given `to` (the other fields are ignored,
   * as propose ignores non-coordinate fields) and never reopens it.
   */
  async recordServing(row: ServingRow): Promise<string> {
    const parsed = servingRowSchema.parse(row)
    const table = this.table('servings')
    const existing = table.get(parsed.id)
    if (!existing) await table.put(parsed.id, parsed)
    else if (parsed.to !== undefined && existing.to === undefined) await table.update(parsed.id, (cur) => ({ ...cur, to: parsed.to }))
    return parsed.id
  }

  /** Compute the id from the pre-registered content; a duplicate id returns the existing row without writing. */
  async createExperiment(input: ExperimentInput): Promise<ExperimentRow> {
    const created_at = input.created_at ?? new Date().toISOString()
    const id = experimentId({ ...input, created_at })
    const table = this.table('experiments')
    const existing = table.get(id)
    if (existing) return existing
    const row = experimentRowSchema.parse({
      ...input, id, created_at, status: 'active', round_ids: [], spent: { usd: 0, attempts: 0, rounds: 0, holdout_reveals: 0 },
    })
    await table.put(id, row)
    return row
  }

  /**
   * The mutable fields of an experiment: what it spent, its rounds, its status
   * and closing time, and its budget with the record of who raised it when.
   * The pre-registered content (the id's coordinates) never changes: a raised
   * budget is a new `budget` beside the one the id was computed from.
   */
  async updateExperiment(
    id: string,
    patch: Partial<Pick<ExperimentRow, 'spent' | 'round_ids' | 'status' | 'closed_at' | 'budget' | 'budget_changes'>>,
  ): Promise<ExperimentRow> {
    const table = this.table('experiments')
    if (!table.get(id)) throw new LedgerError(`no experiment ${id}`, 'UNKNOWN_EXPERIMENT')
    return table.update(id, (cur) => experimentRowSchema.parse({ ...cur, ...patch }))
  }

  /** Append-only and immutable by id: re-recording an existing notebook id is a no-op. */
  async recordNotebook(row: NotebookRow): Promise<string> {
    const parsed = notebookRowSchema.parse(row)
    const table = this.table('notebook')
    if (!table.get(parsed.id)) await table.put(parsed.id, parsed)
    return parsed.id
  }

  // ------------------------------------------------------------------ views

  challenger(id: string): ChallengerRow | undefined {
    return this.table('challengers').get(id)
  }

  attemptsOf(challengerId: string): AttemptRow[] {
    return this.rows('attempts').filter((r) => r.challenger_id === challengerId)
  }

  scoresOf(attemptId: string): ScoreRow[] {
    return this.rows('scores').filter((r) => r.attempt_id === attemptId)
  }

  comparesOf(challengerId: string): CompareRow[] {
    return this.rows('compares').filter((r) => r.challenger_id === challengerId)
  }

  consentsOf(challengerId: string): ConsentRow[] {
    return this.rows('consents').filter((r) => r.challenger_id === challengerId)
  }

  round(id: string): RoundRow | undefined {
    return this.table('rounds').get(id)
  }

  /** Every round judged against `championId`, oldest first. */
  roundsOf(championId: string): RoundRow[] {
    return this.rows('rounds').filter((r) => r.champion_id === championId).sort(byString((r) => r.opened_at))
  }

  /** The latest measurement (by `measured_at`) for the tuple, or undefined when none. */
  noiseFloorFor(eval_config_sha: string, champion_id: string, loop: string, metric: string): NoiseFloorRow | undefined {
    let latest: NoiseFloorRow | undefined
    for (const r of this.rows('noise_floors')) {
      if (r.eval_config_sha !== eval_config_sha || r.champion_id !== champion_id || r.loop !== loop || r.metric !== metric) continue
      if (!latest || r.measured_at > latest.measured_at) latest = r
    }
    return latest
  }

  /** Every serving, oldest first: the history of which champion was served when. */
  servings(): ServingRow[] {
    return this.rows('servings').sort(byString((r) => r.from))
  }

  experiment(id: string): ExperimentRow | undefined {
    return this.table('experiments').get(id)
  }

  /** Every experiment, oldest first. */
  experiments(): ExperimentRow[] {
    return this.rows('experiments').sort(byString((r) => r.created_at))
  }

  /** The notebook of one session in event order (`seq`). */
  notebookOf(sessionId: string): NotebookRow[] {
    return this.rows('notebook').filter((r) => r.session_id === sessionId).sort((a, b) => a.seq - b.seq)
  }

  /** The parent chain from `id` up to a root, following the first parent; stops at an unknown id or a cycle. */
  lineage(id: string): ChallengerRow[] {
    const out: ChallengerRow[] = []
    const seen = new Set<string>()
    let cur: string | undefined = id
    while (cur && !seen.has(cur)) {
      seen.add(cur)
      const row = this.challenger(cur)
      if (!row) break
      out.push(row)
      cur = row.parent_ids[0]
    }
    return out
  }

  /**
   * Read a whole table as one viewer. `gate` and `human` see every row;
   * `proposer` sees held-out attempts and scores only as per-challenger
   * aggregates (mean rounded to two decimals), held-out compares only as
   * verdict + Ladder signal, and no shadow compare at all (S7: no per-task
   * holdout row or unrounded holdout figure reaches the loop). Rounds, noise
   * floors, experiments and the notebook are operator objects: a proposer
   * reads them as []. `operator` (the workbench session) reads attempts and
   * scores as a proposer does, compares as a human does minus `per_task` on
   * every tier, and everything else whole.
   */
  read<N extends View>(view: N, viewer: Viewer): ViewRows[N] {
    if (viewer === 'proposer' && OPERATOR_VIEWS.includes(view)) return [] as ViewRows[N]
    const rows = this.rows(view)
    if (viewer === 'gate' || viewer === 'human') return rows as ViewRows[N]
    if (view === 'attempts') return redactAttempts(rows as AttemptRow[]) as ViewRows[N]
    if (view === 'scores') return redactScores(rows as ScoreRow[], this.table('attempts')) as ViewRows[N]
    if (view === 'compares') return (viewer === 'operator' ? stripTasks(rows as CompareRow[]) : redactCompares(rows as CompareRow[])) as ViewRows[N]
    return rows as ViewRows[N]
  }

  private rows<N extends View>(view: N): ViewRowOf<N>[] {
    return [...this.table(view).entries()].map(([, r]) => r)
  }
}

function redactAttempts(rows: AttemptRow[]): (AttemptRow | AttemptAggregate)[] {
  const out: (AttemptRow | AttemptAggregate)[] = []
  const agg = new Map<string, AttemptAggregate>()
  for (const r of rows) {
    if (r.tier !== 'holdout') {
      out.push(r)
      continue
    }
    let a = agg.get(r.challenger_id)
    if (!a) {
      a = { redacted: true, challenger_id: r.challenger_id, tier: 'holdout', n: 0, by_status: {} }
      agg.set(r.challenger_id, a)
    }
    a.n++
    a.by_status[r.status] = (a.by_status[r.status] ?? 0) + 1
  }
  return [...out, ...agg.values()]
}

function redactScores(rows: ScoreRow[], attempts: KvTable<string, AttemptRow>): (ScoreRow | ScoreAggregate)[] {
  const out: (ScoreRow | ScoreAggregate)[] = []
  const agg = new Map<string, ScoreAggregate & { sum: number }>()
  for (const r of rows) {
    const attempt = attempts.get(r.attempt_id)
    // A score whose attempt is unknown cannot prove it is not held out: redact it.
    if (attempt && attempt.tier !== 'holdout') {
      out.push(r)
      continue
    }
    const challenger_id = attempt?.challenger_id ?? ''
    const k = [challenger_id, r.metric, r.scorer_version, r.truth_snapshot_id].join('\0')
    let a = agg.get(k)
    if (!a) {
      a = {
        redacted: true, challenger_id, tier: 'holdout',
        metric: r.metric, scorer_version: r.scorer_version, truth_snapshot_id: r.truth_snapshot_id,
        n: 0, mean: 0, sum: 0,
      }
      agg.set(k, a)
    }
    a.n++
    a.sum += r.value
  }
  return [...out, ...[...agg.values()].map(({ sum, ...rest }) => ({ ...rest, mean: round2(sum / rest.n) }))]
}

/** Shadow rows never feed a decision and are not shown; a held-out row collapses to its verdict and Ladder signal. */
function redactCompares(rows: CompareRow[]): (CompareRow | CompareAggregate)[] {
  const out: (CompareRow | CompareAggregate)[] = []
  for (const r of rows) {
    if (r.shadow) continue
    if (r.tier !== 'holdout') {
      out.push(r)
      continue
    }
    out.push({
      redacted: true, challenger_id: r.challenger_id, vs_id: r.vs_id, tier: 'holdout',
      method: r.method, rule_fired: r.rule_fired, verdict: r.verdict,
      ...(r.ladder ? { ladder: { beat_best: r.ladder.beat_best, ...(r.ladder.best_so_far !== undefined ? { best_so_far: round2(r.ladder.best_so_far) } : {}) } } : {}),
    })
  }
  return out
}

/** Every row stays, shadow rows included; only the per-task deltas go. */
function stripTasks(rows: CompareRow[]): CompareWithoutTasks[] {
  return rows.map(({ per_task, ...rest }) => rest)
}

function round2(x: number): number {
  return Math.round(x * 100) / 100
}

function byString<T>(key: (r: T) => string): (a: T, b: T) => number {
  return (a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)
}

// The loader mounts this module as the `ledger` row: a Service class is a plugin.
export default Ledger
