import { describe, expect, it } from 'vitest'
import type { AttemptRow, ChallengerRow, ScoreRow } from '@oldbulb/samsara-ledger'
import { sha256 } from '@oldbulb/samsara-ledger'
import { gateDefault, GATE_DEFAULT_NAME, GATE_DEFAULT_VERSION, type CompareRequest } from '@oldbulb/samsara-gate'
import { factsSha, type HarnessFacts, type LoopProvider } from '@oldbulb/samsara-loops'
import { certify, formatCertify, utilizationOf, type CertifyDeps, type CertifyRequest } from '../src/certify.ts'
import type { ChallengeRequest, ChallengeResult } from '../src/challenge.ts'

const Z = sha256('')

function facts(loop: string, delivery: HarnessFacts['skillDelivery']): HarnessFacts {
  return { systemPromptMode: 'x', skillDelivery: delivery, schemaEnforcement: 'permissive-tool', permission: 'p', reasoning: {}, version: { loop: `${loop}@1` } }
}
const providers: Record<string, LoopProvider> = {
  a: { name: 'a', harnessFacts: facts('a', 'prompt-inline'), capabilities: { perAttemptBaseUrl: false, perAttemptEnv: false, nativeSchema: 'none', toolFilter: false, nativeMaxTurns: false }, start: () => Promise.reject(new Error('unused')) },
  b: { name: 'b', harnessFacts: facts('b', 'agents-skills-dir'), capabilities: { perAttemptBaseUrl: false, perAttemptEnv: false, nativeSchema: 'none', toolFilter: false, nativeMaxTurns: false }, start: () => Promise.reject(new Error('unused')) },
}

function attempt(id: string, challenger: string, task: string, loop: string, util?: number | 'inline', usd?: number): AttemptRow {
  return {
    id, challenger_id: challenger, task_id: task, sample: 0, loop, tier: 'smoke', status: 'COMPLETED', stop_reason: 'completed',
    facts_sha: factsSha(providers[loop]!.harnessFacts), usage: { input_tokens: 10, output_tokens: 10 }, cost: { tokens: 20, ...(usd !== undefined ? { usd } : {}) },
    output: { source: 'submit-tool', valid: true }, artifacts: [], ...(util !== undefined ? { skill_utilization: { value: util } } : {}),
  }
}

/** Ledger fake: per loop, a champion row `champ-<loop>` and a challenger row `chal-<loop>` with three scored tasks each. */
function ledgerFake(values: Record<string, number[]>) {
  const attempts = new Map<string, AttemptRow[]>()
  const scores = new Map<string, ScoreRow[]>()
  const rows = new Map<string, Partial<ChallengerRow>>()
  for (const loop of ['a', 'b']) {
    for (const side of ['champ', 'chal']) {
      const id = `${side}-${loop}`
      rows.set(id, { id, skill_sha: side === 'chal' ? 'f'.repeat(64) : Z })
      const util = loop === 'a' ? 'inline' : undefined
      attempts.set(id, ['t1', 't2', 't3'].map((t, i) => attempt(`${id}-${t}-0`, id, t, loop, util ?? [1, 0, 1][i], loop === 'a' ? 0.5 : undefined)))
      for (const [i, a] of attempts.get(id)!.entries()) {
        scores.set(a.id, [{ attempt_id: a.id, scorer_version: '1', truth_snapshot_id: Z, metric: 'pass_rate', value: values[id]![i]!, kind: 'reality' }])
      }
    }
  }
  return {
    rows,
    propose: () => Promise.reject(new Error('unused')), recordAttempt: () => Promise.reject(new Error('unused')), appendScores: () => Promise.reject(new Error('unused')),
    setStatus: () => Promise.reject(new Error('unused')), recordCompare: () => Promise.reject(new Error('unused')),
    challenger: (id: string) => rows.get(id) as ChallengerRow | undefined,
    attemptsOf: (id: string) => attempts.get(id) ?? [],
    scoresOf: (id: string) => scores.get(id) ?? [],
  }
}

const judged = new Map<string, CompareRequest>()
const gate = {
  register: () => () => {},
  judge: (req: CompareRequest) => {
    judged.set(`${req.challenger[0]?.challengerId}|${req.champion[0]?.challengerId}`, req)
    return { ...gateDefault(req), gateMethod: `${GATE_DEFAULT_NAME}@${GATE_DEFAULT_VERSION}` }
  },
}

const calls: ChallengeRequest[] = []
const challengeFn = (req: ChallengeRequest): Promise<ChallengeResult> => {
  calls.push(req)
  const ids = { challengerId: `chal-${req.loop}`, championId: `champ-${req.loop}` }
  if (req.loop === 'b') return Promise.resolve({ ...ids, rejected: [{ code: 'OUTSIDE_SURFACE', where: 'x', detail: 'd' }] as never })
  return Promise.resolve({ ...ids, judgement: { verdict: 'hold', gateMethod: 'gate-default@0.1.0', compare: { ruleFired: 'validity', mean: 0.1, ci: [0, 1], nEff: 3, mde: 0, costRatio: 1 } as never } })
}

const req: CertifyRequest = {
  pack: 'p', set: 'smoke', repeat: 1, out: '/o', maxTurns: 1, maxMinutes: 1, limit: 3,
  skillDir: '/skills/my-skill', loops: ['a', 'b'], metric: 'pass_rate', nEffFloor: 3, gatePolicy: 'default',
}

function deps(ledger: ReturnType<typeof ledgerFake>, over: Partial<CertifyDeps> = {}): CertifyDeps {
  return {
    loops: { get: (n: string) => providers[n], start: () => Promise.reject(new Error('unused')) },
    route: { provider: 'x', model: 'm', credentialRef: '' },
    ledger, scopes: { open: () => Promise.reject(new Error('unused')), championRows: () => [] } as never, gate, challengeFn, ...over,
  }
}

describe('utilizationOf', () => {
  it('is inline when every reporting attempt is inline, the mean fraction otherwise, undefined when nothing reports', () => {
    expect(utilizationOf([attempt('1', 'c', 't', 'a', 'inline'), attempt('2', 'c', 't', 'a', 'inline')])).toBe('inline')
    expect(utilizationOf([attempt('1', 'c', 't', 'b', 1), attempt('2', 'c', 't', 'b', 0), attempt('3', 'c', 't', 'b', 'inline')])).toBeCloseTo(2 / 3)
    expect(utilizationOf([attempt('1', 'c', 't', 'b')])).toBeUndefined()
  })
})

describe('certify', () => {
  const values = { 'champ-a': [0, 1, 0], 'chal-a': [1, 1, 0], 'champ-b': [1, 1, 1], 'chal-b': [0, 0, 1] }

  it('runs challenge() per loop in order with the skill, assembles one row per loop, and refuses the cross-loop compare', async () => {
    calls.length = 0
    judged.clear()
    const ledger = ledgerFake(values)
    const r = await certify(req, deps(ledger))
    expect(calls.map((c) => [c.loop, c.out, c.skillDir, c.withChampion, c.surface])).toEqual([
      ['a', '/o/a', '/skills/my-skill', false, 'skill'], ['b', '/o/b', '/skills/my-skill', false, 'skill'],
    ])
    expect(calls[0]!.intent).toContain('my-skill')
    expect(r.skillSha).toBe('f'.repeat(64))
    expect(r.rows).toHaveLength(2)
    expect(r.rows[0]).toMatchObject({
      loop: 'a', adapterVersion: 'a@1', factsSha: factsSha(providers['a']!.harnessFacts), tasks: 3, utilization: 'inline',
      costMean: 0.5, costUnit: 'usd', verdict: 'hold', rule: 'validity', gateMethod: 'gate-default@0.1.0',
    })
    expect(r.rows[0]!.passRate).toBeCloseTo(2 / 3)
    expect(r.rows[1]).toMatchObject({ loop: 'b', adapterVersion: 'b@1', tasks: 3, costMean: 20, costUnit: 'tokens', verdict: 'rejected', gateMethod: 'diffscan' })
    expect(r.rows[1]!.utilization).toBeCloseTo(2 / 3)
    // Only one loop was judged, so there is nothing to cross.
    expect(r.cross).toBeUndefined()
    expect(formatCertify(r)).toContain('| a    | a@1')
  })

  it('puts challenger-on-a vs champion-on-b through the gate and reports facts:mismatch', async () => {
    judged.clear()
    const both = (q: ChallengeRequest) => challengeFn({ ...q, loop: q.loop === 'b' ? 'a' : q.loop }).then((res) => ({ ...res, challengerId: `chal-${q.loop}`, championId: `champ-${q.loop}` }))
    const r = await certify(req, deps(ledgerFake(values), { challengeFn: both }))
    expect(r.rows.map((x) => x.verdict)).toEqual(['hold', 'hold'])
    expect(r.cross).toEqual({ challengerLoop: 'a', championLoop: 'b', verdict: 'invalid', rule: 'facts:mismatch' })
    const cross = judged.get('chal-a|champ-b')!
    expect(cross.factsSha).toEqual({ challenger: factsSha(providers['a']!.harnessFacts), champion: factsSha(providers['b']!.harnessFacts) })
    const text = formatCertify(r)
    expect(text).toContain('cross-loop a vs b: invalid (facts:mismatch)')
    expect(text).toContain('refused as expected')
  })

  it('marks a reversed ledger row as revoked and rejects an unregistered loop before running anything', async () => {
    const ledger = ledgerFake(values)
    ledger.rows.set('chal-a', { id: 'chal-a', skill_sha: Z, verdict: { value: 'reversed', by: 'settlement', rule: 'truth' } })
    const r = await certify({ ...req, loops: ['a'] }, deps(ledger))
    expect(r.rows[0]!.verdict).toBe('revoked')
    await expect(certify({ ...req, loops: ['a', 'zzz'] }, deps(ledger))).rejects.toThrow(/no loop provider named "zzz"/)
  })
})
