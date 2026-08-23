import { describe, expect, it } from 'vitest'
import { buildCertification, buildChallenger, buildSummary } from '../src/api.ts'
import { createHandler } from '../src/index.ts'
import { CHAL, CHAMP, SKILL, fakeDeps } from './fixtures.ts'

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
    expect(s.tiers.holdin.map((r) => r.id)).toEqual([CHAMP])
    expect(s.tiers.holdout.map((r) => r.id)).toEqual([CHAL])
    expect(s.tiers.smoke).toEqual([])
    const chal = s.tiers.holdout[0]!
    expect(chal.parent).toBe(CHAMP.slice(0, 12))
    expect(chal.intent).toBe('first line')
    expect(chal.verdict).toEqual({ value: 'hold', rule: 'underpowered', by: 'gate-default@1' })
    expect(chal.gate_method).toBe('bca')
    expect(chal.compare).toEqual({ mean: 0.2, ci: [-0.1, 0.5], n_eff: 1, mde: 0.3, cost_ratio: 1.5 })
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
})

describe('buildChallenger', () => {
  it('returns undefined for an unknown id', () => {
    expect(buildChallenger(fakeDeps(), 'nope')).toBeUndefined()
  })

  it('returns lineage, attempts, scores, compares, consents and the prediction check', () => {
    const d = buildChallenger(fakeDeps(), CHAL)!
    expect(d.lineage.map((l) => l.id)).toEqual([CHAL, CHAMP])
    expect(d.attempts.map((a) => ('id' in a ? a.id : 'agg'))).toEqual(['a2', 'a3'])
    expect(d.scores.map((x) => ('attempt_id' in x ? x.attempt_id : 'agg'))).toEqual(['a2', 'a3'])
    expect(d.compares).toHaveLength(1)
    expect(d.consents).toEqual([])
    expect(d.prediction_vs_observed.observed).toEqual([{ tier: 'holdin', truth_snapshot_id: 'truth-1', fixes_hit: 1, at_risk_hit: 0 }])
  })
})

describe('buildCertification', () => {
  it('groups challengers carrying the skill by loop', () => {
    const c = buildCertification(fakeDeps(), SKILL)
    expect(c.rows).toHaveLength(1)
    const row = c.rows[0]!
    expect(row.loop).toBe('dsh')
    expect(row.adapter_version).toEqual(['1'])
    expect(row.tasks).toBe(2)
    expect(row.pass_rate).toBeCloseTo(2 / 3)
    expect(row.utilization).toBe(0.5)
    expect(row.cost_mean).toBeCloseTo(1.5)
    expect(row.verdict).toBe('hold')
    expect(row.gate_method).toBe('bca')
    expect(row.revoked).toBeNull()
    expect(row.challengers.sort()).toEqual([CHAL, CHAMP].sort())
  })

  it('reports inline utilization and an empty table for an unknown skill', () => {
    expect(buildCertification(fakeDeps(), 'x').rows).toEqual([])
  })
})

// The handler without a socket: a minimal req/res pair.
function call(handler: ReturnType<typeof createHandler>, method: string, url: string) {
  let status = 0
  let type = ''
  let body = ''
  const res = {
    writeHead(s: number, h: Record<string, string>) { status = s; type = h['content-type'] ?? '' },
    end(b: string) { body = b },
  }
  handler({ method, url } as never, res as never)
  return { status, type, body }
}

describe('createHandler', () => {
  const handler = createHandler(fakeDeps(), { basePath: '/samsara', refreshMs: 1000 })

  it('serves the page at the base path with and without a trailing slash', () => {
    for (const url of ['/samsara', '/samsara/', '/samsara?challenger=x']) {
      const r = call(handler, 'GET', url)
      expect(r.status).toBe(200)
      expect(r.type).toBe('text/html; charset=utf-8')
      expect(r.body).toContain('Champion')
      expect(r.body).not.toMatch(/<script src=|<link /)
    }
  })

  it('serves the three JSON endpoints', () => {
    expect(JSON.parse(call(handler, 'GET', '/samsara/api/summary').body)).toHaveProperty('tiers.holdin')
    expect(JSON.parse(call(handler, 'GET', `/samsara/api/challenger/${CHAL}`).body).row.id).toBe(CHAL)
    expect(JSON.parse(call(handler, 'GET', `/samsara/api/certify/${SKILL}`).body).rows).toHaveLength(1)
    expect(call(handler, 'GET', '/samsara/api/challenger/nope').status).toBe(404)
  })

  it('answers 404 under the prefix and 405 for non-GET', () => {
    expect(call(handler, 'GET', '/samsara/api/other').status).toBe(404)
    expect(call(handler, 'GET', '/samsara/x').status).toBe(404)
    expect(call(handler, 'POST', '/samsara/api/summary').status).toBe(405)
  })
})
