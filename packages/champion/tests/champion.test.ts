import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@samsara/kernel'
import type { AttemptRow, ChallengerRow, CompareRow, ConsentRow, SettlementRow } from '@samsara/ledger'
import type { GateVerdictRow } from '@samsara/gate'
import {
  Champion,
  ChampionError,
  PROFILE_HEADER,
  CHAMPION_BEGIN,
  compareRowOf,
  parseProfilePatch,
  planRescore,
  renderProfilePatch,
  replayCheck,
  stateOf,
  stateSha,
  verifyHotApply,
  type ChampionLedger,
  type KeptPatch,
  type RescoreEvent,
  type SettledEvent,
} from '../src/index.ts'

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

// ------------------------------------------------------------------ fixtures

const BASE = `# host-owned deployment facts
- insert:
    - id: route
      name: route-plugin
      config:
        model: m1   # trailing comment survives
    - id: other
      name: other-plugin
`

function kept(over: Partial<KeptPatch> = {}): KeptPatch {
  return {
    challenger_id: sha('c1'),
    surface: 'prompt',
    ref: `prompt:${sha('p1')}`,
    rows: [{ id: 'route', config: { model: 'm2' } }],
    consent_id: 'consent-1',
    promoted_at: '2026-08-23T00:00:00.000Z',
    ...over,
  }
}

function challenger(over: Partial<ChallengerRow> = {}): ChallengerRow {
  const id = over.id ?? sha('c1')
  return {
    id,
    parent_ids: [],
    patch_sha: sha('p1'),
    harness_sha: sha('h'),
    env_sha: sha('e'),
    skill_sha: sha('s'),
    taskset_sha: sha('t'),
    route: { loop: 'l', loop_adapter_version: '1', model_id: 'm', model_pool_sha: sha('mp'), base_url_kind: 'direct' },
    optimizer_config_sha: sha('o'),
    lineage: 'main',
    surface: 'prompt',
    patch: { cordis: [{ id: 'route', config: { model: 'm2' } }] },
    intent: 'i',
    prediction: { metric: 'm', direction: 'up' },
    scorer_version: '1',
    task_version: 1,
    truth_snapshot_id: 'ts0',
    report_rule_version: '1',
    runtime: { timeout_s: 1, step_cap: 1 },
    tasksets: { smoke: sha('a'), holdin: sha('b'), holdout: sha('c') },
    budget: 1,
    status: 'judged',
    verdict: { value: 'promote', by: 'gate-default@0.1.0', rule: 'holdout' },
    proposed_at: '2026-08-23T00:00:00.000Z',
    ...over,
  }
}

function attempt(challenger_id: string, task_id: string, id = `${challenger_id.slice(0, 6)}-${task_id}`): AttemptRow {
  return {
    id, challenger_id, task_id, sample: 0, loop: 'l', tier: 'holdin', status: 'COMPLETED', stop_reason: 'done',
    facts_sha: sha('f'), usage: { input_tokens: 1, output_tokens: 1 }, cost: {}, output: { source: 's', valid: true }, artifacts: [],
  }
}

class FakeLedger implements ChampionLedger {
  challengers = new Map<string, ChallengerRow>()
  consents: ConsentRow[] = []
  attempts: AttemptRow[] = []
  compares: CompareRow[] = []
  settlements: SettlementRow[] = []
  statusLog: { id: string; status: string; verdict?: string }[] = []

  add(row: ChallengerRow): ChallengerRow { this.challengers.set(row.id, row); return row }
  consent(challenger_id: string, id = 'consent-1', action: ConsentRow['action'] = 'promote'): ConsentRow {
    const c: ConsentRow = { id, challenger_id, action, who: 'human', channel: 'cli', proof_sha: sha(id), at: 'now' }
    this.consents.push(c)
    return c
  }
  challenger(id: string) { return this.challengers.get(id) }
  consentsOf(id: string) { return this.consents.filter((c) => c.challenger_id === id) }
  attemptsOf(id: string) { return this.attempts.filter((a) => a.challenger_id === id) }
  lineage(id: string) {
    const out: ChallengerRow[] = []
    let cur: string | undefined = id
    while (cur) {
      const row = this.challengers.get(cur)
      if (!row) break
      out.push(row)
      cur = row.parent_ids[0]
    }
    return out
  }
  async setStatus(id: string, status: ChallengerRow['status'], patch: Partial<Pick<ChallengerRow, 'tier_reached' | 'verdict'>> = {}) {
    const cur = this.challengers.get(id)!
    const next = { ...cur, ...patch, status }
    this.challengers.set(id, next)
    this.statusLog.push({ id, status, ...(patch.verdict ? { verdict: patch.verdict.value } : {}) })
    return next
  }
  async recordCompare(row: CompareRow) { this.compares.push(row); return sha(JSON.stringify(row)) }
  async recordSettlement(row: SettlementRow) { this.settlements.push(row); return row.id }
}

/** A bare profile under `<home>/profiles/p`: no bundles, empty base config, the host's patch layer. */
function profile(base = BASE): { home: string; dir: string; patch: string } {
  const home = mkdtempSync(join(tmpdir(), 'samsara-champion-'))
  dirs.push(home)
  const dir = join(home, 'profiles', 'p')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'p', private: true, dsh: { profile: { bundles: [] } } }))
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  writeFileSync(join(dir, 'cordis.patch.yml'), base)
  return { home, dir, patch: join(dir, 'cordis.patch.yml') }
}

async function open(dir: string, ledger: FakeLedger) {
  const ctx = new Context()
  ctx.provide('ledger', ledger)
  ctx.provide('signoff', {})
  const fiber = ctx.plugin(Champion, { profileDir: dir, skillStore: join(dir, '..', '..', 'skills') })
  await fiber
  return ctx.champion
}

// ------------------------------------------------------------------ state.ts

describe('profile patch text', () => {
  it('renders and parses back: base text byte-for-byte, state equal', () => {
    const state = stateOf([kept(), kept({ challenger_id: sha('c2'), ref: `tools:${sha('p2')}`, rows: [{ insert: [{ id: 'added', name: 'x', config: { k: 1 } }] }] })])
    const text = renderProfilePatch(state, BASE)
    expect(text.startsWith(PROFILE_HEADER)).toBe(true)
    expect(text).toContain(CHAMPION_BEGIN)
    expect(text).not.toContain('!!js')
    const parsed = parseProfilePatch(text)
    expect(parsed.baseText).toBe(BASE)
    expect(parsed.hasSection).toBe(true)
    expect(parsed.state).toEqual(state)
    expect(parsed.championRows).toEqual(state.profilePatchRows)
    expect(stateSha(parsed.state)).toBe(stateSha(state))
    // Second round trip is the identity on the text.
    expect(renderProfilePatch(parsed.state, parsed.baseText)).toBe(text)
  })

  it('a hand-written file without a section parses to the empty state', () => {
    const parsed = parseProfilePatch(BASE)
    expect(parsed.hasSection).toBe(false)
    expect(parsed.state.kept).toEqual([])
    expect(parsed.baseText).toBe(BASE)
    expect(parsed.baseRows).toHaveLength(1)
  })

  it('a flow-empty base (dsh template) still yields one array', () => {
    const text = renderProfilePatch(stateOf([kept()]), '[]\n')
    expect(parseProfilePatch(text).championRows).toEqual([{ id: 'route', config: { model: 'm2' } }])
  })

  it('refuses a tampered sha line', () => {
    const text = renderProfilePatch(stateOf([kept()]), BASE).replace(/samsara-champion-sha: [0-9a-f]{8}/, 'samsara-champion-sha: 00000000')
    expect(() => parseProfilePatch(text)).toThrow(/sha does not match/)
  })
})

describe('verifyHotApply', () => {
  const dump = `# == cordis.yml + cordis.patch.yml
- id: route
  name: route-plugin
  config:
    model: m2
- id: other
  name: other-plugin
- id: added
  name: x
  config:
    k: 1
`
  it('passes when every kept row reads back', () => {
    const r = verifyHotApply([{ id: 'route', config: { model: 'm2' } }, { insert: [{ id: 'added', name: 'x', config: { k: 1 } }] }], dump)
    expect(r.ok).toBe(true)
    expect(r.expected_sha).toBe(r.observed_sha)
  })
  it('fails on a value that did not apply or an absent entry', () => {
    const r = verifyHotApply([{ id: 'route', config: { model: 'm3' } }, { id: 'nope', config: {} }], dump)
    expect(r.ok).toBe(false)
    expect(r.expected_sha).not.toBe(r.observed_sha)
    expect(r.mismatches).toHaveLength(2)
  })
  it('keeps a !!js expression from another layer as text instead of failing to parse', () => {
    const r = verifyHotApply([{ id: 'route', config: { model: 'm2' } }], dump + '- id: js\n  config: !!js "() => 1"\n')
    expect(r.ok).toBe(true)
  })
})

describe('replayCheck', () => {
  it('detects drift both ways', () => {
    expect(replayCheck(['a:1', 'b:2'], ['b:2', 'a:1']).equal).toBe(true)
    expect(replayCheck(['a:1', 'b:2'], ['a:1', 'c:3'])).toEqual({ equal: false, missingInFile: ['b:2'], extraInFile: ['c:3'] })
  })
})

// ------------------------------------------------------------------ service

describe('Champion service', () => {
  it('refuses to promote without a consent row or without a promote verdict', async () => {
    const { dir } = profile()
    const ledger = new FakeLedger()
    const row = ledger.add(challenger())
    const champion = await open(dir, ledger)
    await expect(champion.promote(row.id, 'consent-1')).rejects.toMatchObject({ code: 'NO_CONSENT' })
    ledger.consent(row.id, 'consent-1', 'reject')
    await expect(champion.promote(row.id, 'consent-1')).rejects.toMatchObject({ code: 'NO_CONSENT' })
    const held = ledger.add(challenger({ id: sha('c-hold'), verdict: { value: 'hold', by: 'g', rule: 'r' } }))
    ledger.consent(held.id, 'consent-2')
    await expect(champion.promote(held.id, 'consent-2')).rejects.toMatchObject({ code: 'NOT_PROMOTABLE' })
    expect(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')).toBe(BASE)
    expect(ledger.statusLog).toEqual([])
  })

  it('promotes a config patch: file gets the section, base rows survive byte-for-byte, hot-apply verified, ledger decided', async () => {
    const { dir, patch } = profile()
    const ledger = new FakeLedger()
    const row = ledger.add(challenger())
    ledger.consent(row.id)
    const champion = await open(dir, ledger)
    const changed: string[] = []
    champion.on('champion/changed', (s) => changed.push(stateSha(s)))

    const state = await champion.promote(row.id, 'consent-1')
    expect(state.rows).toEqual([`prompt:${sha('p1')}`])
    expect(state.profilePatchRows).toEqual([{ id: 'route', config: { model: 'm2' } }])
    const text = readFileSync(patch, 'utf8')
    expect(text).toContain(BASE)
    expect(text).toContain(CHAMPION_BEGIN)
    expect(parseProfilePatch(text).baseText).toBe(BASE)
    expect(champion.current()).toEqual(state)
    expect(verifyHotApply(state.profilePatchRows, champion.dump()).ok).toBe(true)
    expect(champion.dump()).toMatch(/model: m2/)
    expect(ledger.statusLog).toEqual([{ id: row.id, status: 'decided', verdict: 'promote' }])
    expect(ledger.challenger(row.id)?.verdict?.consent_id).toBe('consent-1')
    expect(changed).toEqual([stateSha(state)])
    // Idempotent: a second promote of the same challenger is a no-op.
    expect(await champion.promote(row.id, 'consent-1')).toEqual(state)
    expect(ledger.statusLog).toHaveLength(1)
    expect(champion.replayCheck().equal).toBe(true)
  })

  it('promotes a skill patch: snapshot copied into the store by skill_sha, skill_ref points there', async () => {
    const { dir, home } = profile()
    const src = join(home, 'skill-src')
    mkdirSync(join(src, 'scripts'), { recursive: true })
    writeFileSync(join(src, 'SKILL.md'), '# skill\n')
    writeFileSync(join(src, 'scripts', 'run.sh'), 'true\n')
    const ledger = new FakeLedger()
    const row = ledger.add(challenger({ id: sha('skill-1'), surface: 'skill', patch: { skill_ref: src } }))
    ledger.consent(row.id, 'consent-s')
    const champion = await open(dir, ledger)
    const state = await champion.promote(row.id, 'consent-s')
    const dest = join(home, 'skills', row.skill_sha)
    expect(state.skill_ref).toBe(dest)
    expect(state.rows).toEqual([`skill:${row.skill_sha}`])
    expect(readFileSync(join(dest, 'scripts', 'run.sh'), 'utf8')).toBe('true\n')
    expect(champion.current().skill_ref).toBe(dest)
  })

  it('restores the previous file when the hot-apply check fails', async () => {
    const { dir, patch } = profile()
    const ledger = new FakeLedger()
    const good = ledger.add(challenger())
    ledger.consent(good.id)
    const bad = ledger.add(challenger({ id: sha('bad'), patch_sha: sha('pbad'), patch: { cordis: [{ id: 'no-such-entry', config: { x: 1 } }] } }))
    ledger.consent(bad.id, 'consent-bad')
    const champion = await open(dir, ledger)
    await champion.promote(good.id, 'consent-1')
    const before = readFileSync(patch, 'utf8')
    await expect(champion.promote(bad.id, 'consent-bad')).rejects.toMatchObject({ code: 'HOT_APPLY_MISMATCH' })
    expect(readFileSync(patch, 'utf8')).toBe(before)
    expect(champion.current().rows).toEqual([`prompt:${sha('p1')}`])
    expect(ledger.statusLog.map((l) => l.id)).toEqual([good.id])
  })

  it('restores an absent file when the first promotion fails hot-apply', async () => {
    const { dir, patch } = profile()
    rmSync(patch)
    const ledger = new FakeLedger()
    const bad = ledger.add(challenger({ patch: { cordis: [{ id: 'no-such-entry', config: { x: 1 } }] } }))
    ledger.consent(bad.id)
    const champion = await open(dir, ledger)
    await expect(champion.promote(bad.id, 'consent-1')).rejects.toMatchObject({ code: 'HOT_APPLY_MISMATCH' })
    expect(existsSync(patch)).toBe(false)
    expect(champion.current().kept).toEqual([])
  })

  it('demote removes the rows and records reversed on the ledger', async () => {
    const { dir, patch } = profile()
    const ledger = new FakeLedger()
    const a = ledger.add(challenger())
    const b = ledger.add(challenger({ id: sha('c2'), patch_sha: sha('p2'), surface: 'tools', patch: { cordis: [{ insert: [{ id: 'added', name: 'x', config: { k: 1 } }] }] } }))
    ledger.consent(a.id, 'ca')
    ledger.consent(b.id, 'cb')
    const champion = await open(dir, ledger)
    await champion.promote(a.id, 'ca')
    await champion.promote(b.id, 'cb')
    expect(champion.current().rows).toHaveLength(2)
    const state = await champion.demote(a.id, 'operator')
    expect(state.rows).toEqual([`tools:${sha('p2')}`])
    expect(state.profilePatchRows).toEqual([{ insert: [{ id: 'added', name: 'x', config: { k: 1 } }] }])
    expect(parseProfilePatch(readFileSync(patch, 'utf8')).baseText).toBe(BASE)
    expect(champion.dump()).toMatch(/model: m1/)
    expect(ledger.statusLog.at(-1)).toEqual({ id: a.id, status: 'decided', verdict: 'reversed' })
    expect(ledger.challenger(a.id)?.verdict?.rule).toBe('demote:operator')
    await expect(champion.demote(a.id, 'again')).rejects.toMatchObject({ code: 'NOT_KEPT' })
    expect(champion.replayCheck().equal).toBe(true)
  })

  it('replayCheck detects a file that kept a challenger the ledger reversed, and a ledger promotion missing from the file', async () => {
    const { dir, patch } = profile()
    const ledger = new FakeLedger()
    const a = ledger.add(challenger())
    ledger.consent(a.id, 'ca')
    const champion = await open(dir, ledger)
    await champion.promote(a.id, 'ca')
    await ledger.setStatus(a.id, 'decided', { verdict: { value: 'reversed', by: 'gate', rule: 'settlement' } })
    expect(champion.replayCheck()).toEqual({ equal: false, missingInFile: [], extraInFile: [`prompt:${sha('p1')}`] })
    // Hand-edited file: the section is gone but the ledger still says promote.
    await ledger.setStatus(a.id, 'decided', { verdict: { value: 'promote', by: 'gate', rule: 'holdout' } })
    writeFileSync(patch, BASE)
    expect(champion.current().kept).toEqual([])
    // The file carries nothing, so the check over the file's kept set is trivially equal; drift from the
    // ledger side is the caller's replay over decided rows. The pure check covers that direction.
    expect(replayCheck([`prompt:${sha('p1')}`], champion.current().rows).missingInFile).toEqual([`prompt:${sha('p1')}`])
  })

  it('rejects a profileDir outside <home>/profiles/<name>', () => {
    const d = mkdtempSync(join(tmpdir(), 'samsara-champion-layout-'))
    dirs.push(d)
    const ctx = new Context()
    expect(() => new Champion(ctx, { profileDir: d, skillStore: d })).toThrow(ChampionError)
  })
})

// --------------------------------------------------------------- settlement

function judgement(verdict: GateVerdictRow['verdict']): GateVerdictRow {
  return {
    gateMethod: 'gate-default@0.1.0',
    verdict,
    compare: {
      perTask: [{ taskId: 't1', entityKey: 'e1', sample: 0, delta: 0.1 }],
      mean: 0.1, ci: [0.01, 0.2], method: 'bca', clusterKey: 'entity', nEff: 1, mde: 0.05,
      holm: { adjustedAlpha: 0.05 }, costRatio: 1, ladder: { step: 0.01, beatBest: true },
      counts: { paired: 1, unpaired: 0, excluded: 0, validRate: 1 }, ruleFired: 'holdout',
    },
  }
}

describe('settlement bookkeeping', () => {
  const settled: SettledEvent = {
    id: 'settle-1', kind: 'truth', taskset_sha: sha('t'), as_of: '2026-09-01', truth_snapshot_id: 'ts1',
    n_settled: 2, n_pending: 0, task_ids: ['t1', 't3'],
  }

  it('planRescore walks the ancestry and keeps only hold/promote rows touching affected tasks', () => {
    const ledger = new FakeLedger()
    const root = ledger.add(challenger({ id: sha('root'), verdict: { value: 'drop', by: 'g', rule: 'r' } }))
    const held = ledger.add(challenger({ id: sha('held'), parent_ids: [root.id], verdict: { value: 'hold', by: 'g', rule: 'r' } }))
    const head = ledger.add(challenger({ id: sha('head'), parent_ids: [held.id] }))
    const untouched = ledger.add(challenger({ id: sha('untouched'), parent_ids: [head.id] }))
    ledger.attempts.push(attempt(root.id, 't1'), attempt(held.id, 't1'), attempt(held.id, 't2'), attempt(head.id, 't3'), attempt(untouched.id, 't2'))
    const plan = planRescore(ledger, [untouched.id], settled)
    expect(plan.map((p) => p.challenger_id).sort()).toEqual([held.id, head.id].sort())
    expect(plan.find((p) => p.challenger_id === held.id)?.attempt_ids).toEqual([attempt(held.id, 't1').id])
    expect(plan.every((p) => p.settlement_id === 'settle-1' && p.truth_snapshot_id === 'ts1')).toBe(true)
  })

  it('onSettlement records the settlement append-only and emits samsara/rescore; a reversal demotes', async () => {
    const { dir } = profile()
    const ledger = new FakeLedger()
    const row = ledger.add(challenger())
    ledger.consent(row.id)
    ledger.attempts.push(attempt(row.id, 't1'))
    const champion = await open(dir, ledger)
    await champion.promote(row.id, 'consent-1')

    const events: RescoreEvent[] = []
    champion.on('samsara/rescore', (e) => events.push(e))
    const plan = await champion.onSettlement(settled)
    expect(events).toEqual(plan)
    expect(events).toEqual([{ settlement_id: 'settle-1', challenger_id: row.id, attempt_ids: [attempt(row.id, 't1').id], truth_snapshot_id: 'ts1' }])
    expect(ledger.settlements).toHaveLength(1)
    expect(ledger.settlements[0]?.triggered_rescoring).toEqual([row.id])

    // The re-score comes back: the kept row no longer promotes -> reversed -> demoted.
    const compare = await champion.rescored(row.id, judgement('hold'), { vs_id: 'champion', tier: 'holdout', truth_snapshot_id: 'ts1', at: 'now' })
    expect(compare.verdict.value).toBe('reversed')
    expect(ledger.compares).toHaveLength(1)
    expect(champion.current().kept).toEqual([])
    expect(ledger.challenger(row.id)?.verdict?.value).toBe('reversed')
    expect(champion.dump()).toMatch(/model: m1/)
  })

  it('a kept row that promotes again is confirmed and stays; an unkept row keeps the gate value', async () => {
    const { dir } = profile()
    const ledger = new FakeLedger()
    const row = ledger.add(challenger())
    ledger.consent(row.id)
    const other = ledger.add(challenger({ id: sha('other'), verdict: { value: 'hold', by: 'g', rule: 'r' } }))
    const champion = await open(dir, ledger)
    await champion.promote(row.id, 'consent-1')
    const confirmed = await champion.rescored(row.id, judgement('promote'), { vs_id: 'x', tier: 'holdout', truth_snapshot_id: 'ts1' })
    expect(confirmed.verdict.value).toBe('confirmed')
    expect(champion.current().rows).toHaveLength(1)
    const held = await champion.rescored(other.id, judgement('hold:underpowered'), { vs_id: 'x', tier: 'holdout', truth_snapshot_id: 'ts1' })
    expect(held.verdict.value).toBe('hold')
    expect(ledger.challenger(other.id)?.status).toBe('judged')
    expect(compareRowOf(other.id, judgement('drop'), { vs_id: 'x', tier: 'holdin', truth_snapshot_id: 'ts1' }, false).verdict.value).toBe('drop')
  })
})
