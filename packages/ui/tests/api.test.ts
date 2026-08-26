import { describe, expect, it } from 'vitest'
import { buildCertification, buildChallenger, buildSummary, compareSource, loadConsents, loadExperiment, loadExperiments, loadNoiseFloors, loadNotebook, loadRound, loadRounds, loadServings, withSources } from '../src/api.ts'
import type { CompareAggregate, View, ViewRows, Viewer } from '@oldbulb/samsara-ledger'
import { CHAL, CHAL2, CHAMP, EXP, FLOOR1, FLOOR2, ROOT, ROUND1, ROUND2, ROUND3, SESSION, SKILL, compares, fakeDeps } from './fixtures.ts'

/** Deps whose ledger hands back a redacted compare aggregate next to the full row. */
function depsWithAggregate() {
  const deps = fakeDeps()
  const agg: CompareAggregate = {
    redacted: true, challenger_id: CHAL, vs_id: CHAMP, tier: 'holdout', method: 'bca', rule_fired: 'underpowered',
    verdict: { value: 'hold', by: 'gate-default@1', rule: 'underpowered' }, ladder: { beat_best: false, best_so_far: 0.05 },
  }
  const read = deps.ledger.read
  deps.ledger.read = <N extends View>(view: N, viewer: 'proposer' | 'gate' | 'human') =>
    (view === 'compares' ? [...compares, agg] : read(view, viewer)) as ViewRows[N]
  return deps
}

describe('buildSummary', () => {
  const s = buildSummary(fakeDeps())

  it('describes the champion from the state and the last kept row', () => {
    expect(s.champion.rows).toEqual([`skill:${SKILL}`])
    expect(s.champion.state_sha).toMatch(/^[0-9a-f]{64}$/)
    expect(s.champion.promoted_at).toBe('2025-12-03T00:00:00Z')
    expect(s.champion.replay.equal).toBe(true)
    expect(s.champion.route).toEqual({ loop: 'dsh', model: 'm1' })
  })

  it('reports the last settlement with the demotions it caused', () => {
    expect(s.lastSettlement?.id).toBe('settle-1')
    expect(s.lastSettlement?.demoted).toEqual([])
  })

  it('buckets challengers by tier with verdict, compare and attempt counts', () => {
    expect(s.tiers.holdin.map((r) => r.id)).toEqual([CHAL2, CHAMP])
    expect(s.tiers.holdout.map((r) => r.id)).toEqual([CHAL, ROOT])
    expect(s.tiers.smoke).toEqual([])
    const chal = s.tiers.holdout[0]!
    expect(chal.parent).toBe(CHAMP.slice(0, 12))
    expect(chal.intent).toBe('first line')
    expect(chal.verdict).toEqual({ value: 'hold', rule: 'power:nEff', by: 'gate-default@1' })
    // The promotion verdict's row, not the later shadow: the gate name comes from the row (`by` on rows recorded before `gate`).
    expect(chal.gate_method).toBe('gate-default@1')
    expect(chal.shadow).toBe(false)
    // The cost ratio names the attempts behind both means: the challenger's on the compare's tier, then the champion's.
    expect(chal.compare).toEqual({ mean: 0.2, ci: [-0.1, 0.5], n_eff: 1, mde: 0.3, cost_ratio: 1.5, cost_attempts: ['a2', 'a1'] })
    // The held-out attempt arrives as an aggregate under the operator viewer and still counts.
    expect(chal.attempts).toEqual({ n: 2, by_status: { COMPLETED: 1, TRUNCATED: 1 } })
    expect(chal.facts_sha).toEqual(['facts-a'])
    // A challenger without a tier_reached falls to the highest tier its attempts ran on.
    expect(chal.tier).toBe('holdout')
  })

  it('renders pending sign-offs as a confirm command without any key path', () => {
    expect(s.pendingSignoffs).toHaveLength(1)
    const p = s.pendingSignoffs[0]!
    expect(p.command).toContain(`--row ${CHAL} --action promote`)
    expect(p.command).toContain('--socket /tmp/signoff.sock')
    expect(p.command).not.toMatch(/signoff\.key/)
  })

  it('shows a shadow judgement with its gate when it is all the challenger has', () => {
    const deps = fakeDeps()
    const read = deps.ledger.read
    deps.ledger.read = <N extends View>(view: N, viewer: 'proposer' | 'gate' | 'human') =>
      (view === 'compares' ? compares.filter((c) => c.shadow) : read(view, viewer)) as ViewRows[N]
    const chal = buildSummary(deps).tiers.holdout.find((c) => c.id === CHAL)!
    expect(chal).toMatchObject({ gate_method: 'keep-better@0.1.0', shadow: true, compare: { ci: [0.05, 0.35] } })
  })
})

describe('buildChallenger', () => {
  it('returns undefined for an unknown id', () => {
    expect(buildChallenger(fakeDeps(), 'nope')).toBeUndefined()
  })

  it('returns lineage, attempts, scores, compares, consents and the prediction check', () => {
    const d = buildChallenger(fakeDeps(), CHAL)!
    expect(d.lineage.map((l) => l.id)).toEqual([CHAL, CHAMP, ROOT])
    expect(d.attempts.map((a) => ('id' in a ? a.id : 'agg'))).toEqual(['a2', 'agg'])
    expect(d.scores.map((x) => ('attempt_id' in x ? x.attempt_id : 'agg'))).toEqual(['a2', 'agg'])
    for (const c of d.compares) expect(c).not.toHaveProperty('per_task')
    expect(d.compares).toHaveLength(2)
    expect(d.compares.map((c) => ('redacted' in c ? null : [c.gate ?? c.verdict.by, c.shadow ?? false]))).toEqual([['gate-default@1', false], ['keep-better@0.1.0', true]])
    expect(d.consents).toEqual([])
    expect(d.prediction_vs_observed.observed).toEqual([{ tier: 'holdin', truth_snapshot_id: 'truth-1', fixes_hit: 1, at_risk_hit: 0 }])
  })

  it('keeps a redacted compare aggregate out of the prediction check and the summary', () => {
    const deps = depsWithAggregate()
    const d = buildChallenger(deps, CHAL)!
    expect(d.compares).toHaveLength(3)
    expect(d.prediction_vs_observed.observed).toHaveLength(1)
    const row = buildSummary(deps).tiers.holdout.find((c) => c.id === CHAL)!
    expect(row.compare?.ci).toEqual([-0.1, 0.5])
  })
})

describe('buildCertification', () => {
  it('groups challengers carrying the skill by loop', () => {
    const c = buildCertification(fakeDeps(), SKILL)
    expect(c.rows).toHaveLength(1)
    const row = c.rows[0]!
    expect(row.loop).toBe('dsh')
    expect(row.adapter_version).toEqual(['1'])
    // Over the attempts shown whole: the held-out one is an aggregate under the operator viewer.
    expect(row.tasks).toBe(1)
    // Validity of the output, never a metric: the page computes no statistic and knows no metric name.
    expect(row.valid_rate).toBe(1)
    expect(row).not.toHaveProperty('pass_rate')
    expect(row.utilization).toBe(0.5)
    expect(row.cost_mean).toBeCloseTo(1.25)
    expect(row.verdict).toBe('hold')
    expect(row.gate_method).toBe('gate-default@1')
    expect(row.shadow).toBe(false)
    expect(row.revoked).toBeNull()
    expect(row.challengers.sort()).toEqual([CHAL, CHAMP].sort())
  })

  it('reports inline utilization and an empty table for an unknown skill', () => {
    expect(buildCertification(fakeDeps(), 'x').rows).toEqual([])
  })

  it('reads utilization from the value the runner records: a number counts, inline and any other key do not', () => {
    const base = fakeDeps()
    const shaped = (id: string, task_id: string, skill_utilization: Record<string, unknown>) =>
      ({ ...base.ledger.read('attempts', 'gate').find((a) => a.id === 'a2')!, id, task_id, skill_utilization })
    // loops-dsh reports a read fraction or 'inline'; the runner writes it as { value }.
    const extra = [shaped('u1', 't3', { value: 1 }), shaped('u2', 't4', { value: 'inline' }), shaped('u3', 't5', { utilization: 0.25 })]
    const deps = {
      ...base,
      ledger: {
        ...base.ledger,
        read<N extends View>(view: N, viewer: Viewer) {
          const rows = base.ledger.read(view, viewer)
          return (view === 'attempts' ? [...(rows as ViewRows['attempts']), ...extra] : rows) as ViewRows[N]
        },
      },
    }
    expect(buildCertification(deps, SKILL).rows[0]!.utilization).toBe(0.75)
  })
})

describe('view loaders', () => {
  const { ledger } = fakeDeps()

  it('read the operator views in their natural order', () => {
    expect(loadRounds(ledger).map((r) => r.id)).toEqual([ROUND1, ROUND2, ROUND3])
    expect(loadRound(ledger, ROUND2)?.shadow_gates.map((g) => `${g.name}@${g.version}`)).toEqual(['keep-better@0.1.0'])
    expect(loadRound(ledger, 'nope')).toBeUndefined()
    expect(loadExperiments(ledger).map((e) => e.id)).toEqual([EXP])
    expect(loadExperiment(ledger, EXP)?.round_ids).toEqual([ROUND1, ROUND2, ROUND3])
    expect(loadServings(ledger).map((s) => [s.champion_id, s.to ?? null])).toEqual([[ROOT, '2025-12-03T00:00:00Z'], [CHAMP, null]])
    expect(loadNoiseFloors(ledger).map((f) => f.id)).toEqual([FLOOR1, FLOOR2])
    expect(loadNotebook(ledger, SESSION).map((n) => n.seq)).toEqual([0, 1, 2, 3, 4])
    expect(loadNotebook(ledger, 'other')).toEqual([])
    expect(loadConsents(ledger).map((c) => c.id)).toEqual(['consent-1', 'consent-2'])
    expect(loadConsents(ledger, 'gate-default@2').map((c) => c.action)).toEqual(['gate_change'])
  })

  it('attach deduplicated, non-empty sources and key compare rows', () => {
    expect(withSources({ a: 1 }, ['x', undefined, '', 'x', null, 'y'])).toEqual({ a: 1, sources: ['x', 'y'] })
    const [promotion, shadow] = compares
    expect(compareSource(promotion!)).not.toBe(compareSource(shadow!))
    expect(compareSource(promotion!)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('expose the optional lifecycle slice', () => {
    const deps = fakeDeps()
    expect(deps.lifecycle?.status().pending).toEqual([{ roundId: ROUND2, candidate: CHAL, action: 'promote' }])
    expect(deps.lifecycle?.nextActions(CHAL).map((a) => a.kind)).toEqual(['replicate', 'holdout', 'drop'])
    expect(deps.lifecycle?.nextActions('other')).toEqual([])
  })
})
