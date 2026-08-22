// @samsara/ledger — `ctx.ledger`: the one control-plane record.
//
// A cordis Service over a dsh storage domain (`samsara_ledger`). Every write
// goes through the domain tables (put / update), so durability precedes
// memory; reads are synchronous from the domain's in-memory state. Keys are
// content-addressed (spec.ts), which is what makes propose() idempotent,
// scores append-only and compares first-verdict-wins.

import { Context, Service, type Domain, type KvTable } from '@samsara/kernel'
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
  type AttemptRow,
  type ChallengerProposal,
  type ChallengerRow,
  type CompareRow,
  type ConsentRow,
  type LedgerDomainSpec,
  type ScoreRow,
  type SettlementRow,
} from './spec.ts'

export * from './spec.ts'
export { sha256, canonicalJson, keyOf } from './id.ts'
export { importAttemptsJsonl, attemptRowOf, type ImportOptions, type ImportResult } from './import.ts'

declare module '@samsara/kernel' {
  interface Context {
    ledger: Ledger
  }
}

export type LedgerErrorCode = 'VERDICT_EXISTS' | 'UNKNOWN_CHALLENGER' | 'NOT_OPEN'

export class LedgerError extends Error {
  constructor(message: string, readonly code: LedgerErrorCode) {
    super(message)
    this.name = 'LedgerError'
  }
}

export type Viewer = 'proposer' | 'gate' | 'human'
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

export type ViewRows = {
  challengers: ChallengerRow[]
  attempts: (AttemptRow | AttemptAggregate)[]
  scores: (ScoreRow | ScoreAggregate)[]
  compares: CompareRow[]
  consents: ConsentRow[]
  settlements: SettlementRow[]
}

type ViewRowOf<N extends View> = {
  challengers: ChallengerRow
  attempts: AttemptRow
  scores: ScoreRow
  compares: CompareRow
  consents: ConsentRow
  settlements: SettlementRow
}[N]

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

  /** Compute the id from the coordinates; a duplicate id returns the existing row's id without writing. */
  async propose(proposal: ChallengerProposal): Promise<string> {
    const id = challengerId(proposal)
    const table = this.table('challengers')
    if (table.get(id)) return id
    const row = challengerRowSchema.parse({
      ...proposal,
      id,
      status: 'proposed',
      proposed_at: proposal.proposed_at ?? new Date().toISOString(),
    })
    await table.put(id, row)
    return id
  }

  /** The only mutable fields of a challenger row: status, tier reached, verdict. */
  async setStatus(
    id: string,
    status: ChallengerRow['status'],
    patch: Partial<Pick<ChallengerRow, 'tier_reached' | 'verdict'>> = {},
  ): Promise<ChallengerRow> {
    const table = this.table('challengers')
    if (!table.get(id)) throw new LedgerError(`no challenger ${id}`, 'UNKNOWN_CHALLENGER')
    return table.update(id, (cur) => challengerRowSchema.parse({ ...cur, ...patch, status }))
  }

  async recordAttempt(row: AttemptRow): Promise<string> {
    const parsed = attemptRowSchema.parse(row)
    await this.table('attempts').put(parsed.id, parsed)
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

  /** First verdict wins: a second compare for the same (challenger, vs, tier, truth snapshot) throws VERDICT_EXISTS. */
  async recordCompare(row: CompareRow): Promise<string> {
    const parsed = compareRowSchema.parse(row)
    const key = compareKey(parsed)
    const table = this.table('compares')
    if (table.get(key)) {
      throw new LedgerError(
        `a verdict already exists for ${parsed.challenger_id} vs ${parsed.vs_id} at tier ${parsed.tier} on truth ${parsed.truth_snapshot_id}`,
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
   * aggregates (S7: no per-task holdout row reaches the loop).
   */
  read<N extends View>(view: N, viewer: Viewer): ViewRows[N] {
    const rows = this.rows(view)
    if (viewer !== 'proposer') return rows as ViewRows[N]
    if (view === 'attempts') return redactAttempts(rows as AttemptRow[]) as ViewRows[N]
    if (view === 'scores') return redactScores(rows as ScoreRow[], this.table('attempts')) as ViewRows[N]
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
    const k = [challenger_id, r.metric, r.scorer_version, r.truth_snapshot_id].join(' ')
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
    a.mean = a.sum / a.n
  }
  return [...out, ...[...agg.values()].map(({ sum: _sum, ...rest }) => rest)]
}

// The loader mounts this module as the `ledger` row: a Service class is a plugin.
export default Ledger
