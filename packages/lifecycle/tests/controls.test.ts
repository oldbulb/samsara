import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LifecycleError, type CampaignEvent, type ControlInput } from '../src/index.ts'
import { championProposal, openLifecycle, runOptions, PACK, sha, type Harness } from './fakes.ts'

/** Content hash of a directory: what the runner's hashDir stands for here. */
function hashDirOf(dir: string): string {
  const files: string[] = []
  const walk = (d: string) => { for (const name of readdirSync(d).sort()) { const p = join(d, name); statSync(p).isDirectory() ? walk(p) : files.push(p) } }
  walk(dir)
  const h = createHash('sha256')
  for (const f of files) h.update(relative(dir, f)).update('\0').update(readFileSync(f)).update('\0')
  return h.digest('hex')
}

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function out(): string {
  const d = mkdtempSync(join(tmpdir(), 'samsara-control-'))
  dirs.push(d)
  return d
}

const code = (c: LifecycleError['code']) => expect.objectContaining({ name: 'LifecycleError', code: c })

async function setup(calibrate = true) {
  const h = await openLifecycle()
  const dir = out()
  if (calibrate) await h.lifecycle.calibrate({ pack: PACK, champion: championProposal(), metric: 'm', set: 'holdout', reruns: 3, run: runOptions(join(dir, 'calibrate')) })
  const events: CampaignEvent[] = []
  const input = (over: Partial<ControlInput>): ControlInput => ({
    kind: 'aa', pack: PACK, champion: { proposal: championProposal(), skillDir: resolve(PACK, 'skill') }, metric: 'm', nEffFloor: 1, repeat: 1,
    out: join(dir, 'control'), run: { maxTurns: 5, maxMinutes: 1, route: { provider: 'p', model: 'm', credentialRef: 'cred' } }, ...over,
  })
  const hooks = { onEvent: (e: CampaignEvent) => { events.push(e) }, signal: new AbortController().signal, hashDir: hashDirOf }
  return { h, dir, events, input, hooks }
}

const kinds = (events: CampaignEvent[]) => events.filter((e) => e.kind !== 'attempt:progress').map((e) => e.kind)

describe('control', () => {
  it('aa: the champion skill copied to a fresh directory runs as the challenger at holdout; the round closes without a decision', async () => {
    const s = await setup()
    const result = await s.h.lifecycle.control(s.input({ kind: 'aa' }), s.hooks)
    expect(result).toMatchObject({ control: 'aa', compare: { tier: 'holdout', shadow: false } })
    const row = s.h.ledger.challenger(result.challengerId)!
    const round = s.h.ledger.round(result.roundId)!
    const skillSha = hashDirOf(resolve(PACK, 'skill'))
    expect(row).toMatchObject({ intent: 'control:aa', parent_ids: [round.champion_id], skill_sha: skillSha, patch_sha: skillSha, status: 'judged', tier_reached: 'holdout' })
    expect(row.patch.skill_ref).not.toBe(resolve(PACK, 'skill'))
    expect(row.patch.skill_ref!.startsWith(join(s.dir, 'control', round.id.slice(0, 12), 'aa-'))).toBe(true)
    expect(readFileSync(join(row.patch.skill_ref!, 'SKILL.md'), 'utf8')).toBe(readFileSync(resolve(PACK, 'skill', 'SKILL.md'), 'utf8'))
    expect(round).toMatchObject({ status: 'decided', sibling_ids: [result.challengerId], outcome: { superseded: [] } })
    expect(round.outcome?.promoted).toBeUndefined()
    // Same values on both sides: a null effect, which the gate holds on.
    // S8: the null diff under a powered design is indistinguishable on quality and cost — drop, not hold.
    expect(result.compare).toMatchObject({ mean: 0, verdict: { value: 'drop', rule: 'indistinguishable' } })
    expect(s.h.champion.promoted).toEqual([])
    expect(s.h.executor.calls.map((c) => [c.req.set, c.req.repeat, c.req.skillDir])).toEqual([['holdout', 1, undefined], ['holdout', 1, undefined], ['holdout', 1, undefined], ['holdout', 1, row.patch.skill_ref]])
    expect(s.h.executor.calls[3]?.req.out).toBe(join(s.dir, 'control', round.id.slice(0, 12), 'holdout', 'challenger'))
    expect(kinds(s.events)).toEqual(['round:opened', 'judged', 'decided'])
    expect(s.events.at(-1)).toMatchObject({ kind: 'decided', roundId: round.id, challengerId: result.challengerId, verdict: 'drop' })
    expect(s.h.lifecycle.status().rounds).toEqual([])
    expect(s.h.scopes.disposed).toEqual([result.challengerId])
  })

  it('inject: the given directory runs as the challenger; without one the control is refused', async () => {
    const s = await setup()
    const skill = join(s.dir, 'injected')
    mkdirSync(skill)
    writeFileSync(join(skill, 'SKILL.md'), '# injected\n')
    await expect(s.h.lifecycle.control(s.input({ kind: 'inject' }), s.hooks)).rejects.toEqual(code('BAD_TRANSITION'))
    const result = await s.h.lifecycle.control(s.input({ kind: 'inject', skillDir: skill, repeat: 2 }), s.hooks)
    expect(result.control).toBe('inject')
    const row = s.h.ledger.challenger(result.challengerId)!
    expect(row).toMatchObject({ intent: 'control:inject', skill_sha: hashDirOf(skill), patch: { skill_ref: skill } })
    expect(s.h.executor.calls.at(-1)?.req).toMatchObject({ set: 'holdout', repeat: 2, skillDir: skill })
    expect(s.h.ledger.round(result.roundId)?.status).toBe('decided')
    expect(existsSync(join(s.dir, 'control'))).toBe(true)
  })

  it('under an experiment the round is the experiment\'s and its spend is recorded; without a noise floor the holdout judgement refuses', async () => {
    const s = await setup()
    const exp = await s.h.lifecycle.preregister({ hypothesis: 'h', prediction: { metric: 'm', direction: 'up' }, pack: 'fixture', gate: (await s.h.lifecycle.openRound({ pack: PACK, champion: championProposal(), metric: 'm', nEffFloor: 1, openedAt: '2026-01-01T00:00:00.000Z' })).gate, budget: {}, created_by: { channel: 'test' } })
    const result = await s.h.lifecycle.control(s.input({ kind: 'aa', experimentId: exp.id }), s.hooks)
    expect(s.h.ledger.experiment(exp.id)).toMatchObject({ round_ids: [result.roundId], spent: { rounds: 1, attempts: 4, holdout_reveals: 1 } })
    expect(s.events.at(-1)).toMatchObject({ kind: 'decided', spent: { rounds: 1, attempts: 4 } })

    // Refused before a round, a run or a reveal is spent.
    const t = await setup(false)
    await expect(t.h.lifecycle.control(t.input({ kind: 'aa' }), t.hooks)).rejects.toEqual(code('NO_NOISE_FLOOR'))
    expect(t.h.ledger.rounds.size).toBe(0)
    expect(t.h.executor.calls).toEqual([])
    expect(t.h.ledger.attempts.size).toBe(0)
    expect(t.events).toEqual([])
  })

  it('a control repeated on the same champion is a new row each time, with its own verdict on the ledger', async () => {
    const s = await setup()
    const first = await s.h.lifecycle.control(s.input({ kind: 'aa' }), s.hooks)
    const second = await s.h.lifecycle.control(s.input({ kind: 'aa' }), s.hooks)
    expect(second.roundId).not.toBe(first.roundId)
    expect(second.challengerId).not.toBe(first.challengerId)
    for (const r of [first, second]) {
      expect(s.h.ledger.comparesOf(r.challengerId).filter((c) => c.tier === 'holdout' && !c.shadow)).toEqual([r.compare])
      expect(r.compare.round_id).toBe(r.roundId)
      // A control closes its round without a decision, so the dropped row stays judged.
      expect(s.h.ledger.challenger(r.challengerId)).toMatchObject({ status: 'judged', tier_reached: 'holdout', verdict: { value: 'drop', round_id: r.roundId } })
    }
  })

  it('the run invariant failing closes the round and refuses', async () => {
    const s = await setup()
    s.h.executor.facts = (c) => (c === championProposalId(s.h) ? sha('facts') : sha('other'))
    await expect(s.h.lifecycle.control(s.input({ kind: 'aa' }), s.hooks)).rejects.toEqual(code('NOT_COMPARABLE'))
    expect([...s.h.ledger.rounds.values()].every((r) => r.status === 'decided')).toBe(true)
  })
})

function championProposalId(h: Harness): string {
  return [...h.ledger.challengers.values()].find((r) => r.parent_ids.length === 0)!.id
}
