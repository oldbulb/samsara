import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AttemptRow, CompareAggregate, CompareRow, Ledger, ScoreRow } from '@oldbulb/samsara-ledger'
import { NULL_HARNESS_FACTS } from '@oldbulb/samsara-loops'
import type { GatePolicyProvider } from '@oldbulb/samsara-gate'
import { formatEnvironment, formatRound, renderView, round, type RoundRequest } from '../src/round.ts'
import { DEFAULT, GATE_DEFAULT, MINI, MINI_SKILL, openHarness } from './harness.ts'

function attempt(id: string, challenger: string, task: string, tier: AttemptRow['tier']): AttemptRow {
  return {
    id, challenger_id: challenger, task_id: task, sample: 0, loop: 'null', tier, status: 'COMPLETED', stop_reason: 'completed',
    facts_sha: '', usage: { input_tokens: 1, output_tokens: 1 }, cost: {}, output: { source: 'file', valid: true }, artifacts: [],
  }
}

function compare(challenger_id: string, vs_id: string): CompareRow {
  return {
    challenger_id, vs_id, tier: 'holdin', truth_snapshot_id: 's', per_task: [{ task_id: 'hi1', delta: 1 }], mean: 1, ci: [0, 1],
    method: 'm', cluster_key: 'e', n_eff: 1, mde: 0, rule_fired: 'r', verdict: { value: 'hold', by: 'g', rule: 'r' }, at: 'now',
  }
}

function compareAggregate(challenger_id: string, vs_id: string): CompareAggregate {
  return { redacted: true, challenger_id, vs_id, tier: 'holdout', method: 'm', rule_fired: 'r', verdict: { value: 'hold', by: 'g', rule: 'r' }, ladder: { beat_best: false, best_so_far: 0.12 } }
}

/** A ledger whose proposer reads are already redacted the way @oldbulb/samsara-ledger redacts them. */
const ledger: Pick<Ledger, 'read'> = {
  read: ((view: string, viewer: string) => {
    if (viewer !== 'proposer') throw new Error('the view must be rendered as the proposer')
    if (view === 'attempts') return [
      attempt('a1', 'champ', 'hi1', 'holdin'), attempt('a2', 'other', 'hi2', 'holdin'),
      { redacted: true, challenger_id: 'champ', tier: 'holdout', n: 3, by_status: { COMPLETED: 3 } },
    ]
    if (view === 'scores') return [
      { attempt_id: 'a1', scorer_version: '1', truth_snapshot_id: 's', metric: 'm', value: 1, kind: 'reality' } satisfies ScoreRow,
      { attempt_id: 'a2', scorer_version: '1', truth_snapshot_id: 's', metric: 'm', value: 0, kind: 'reality' } satisfies ScoreRow,
      { redacted: true, challenger_id: 'champ', tier: 'holdout', metric: 'm', scorer_version: '1', truth_snapshot_id: 's', n: 3, mean: 0.5 },
    ]
    if (view === 'compares') return [
      compare('x', 'champ'), compareAggregate('x', 'champ'), compare('champ', 'prev'),
      compare('y', 'other'), compareAggregate('y', 'other'),
    ]
    return []
  }) as Ledger['read'],
}

describe('renderView', () => {
  it('writes the champion skill, the tasks, only the champion rows, and no held-out task id', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'samsara-view-')), 'view')
    renderView(dir, { championId: 'champ', championSkillDir: MINI_SKILL, metric: 'm', tasks: [{ task_id: 'hi1' }], ledger })
    const read = (f: string) => readFileSync(join(dir, f), 'utf8')
    expect(read('champion-skill/SKILL.md')).toBe(readFileSync(join(MINI_SKILL, 'SKILL.md'), 'utf8'))
    expect(JSON.parse(read('champion.json'))).toEqual({ challenger_id: 'champ', skill: 'champion-skill/', metric: 'm' })
    expect(read('tasks.jsonl')).toBe('{"task_id":"hi1"}\n')
    const attempts = read('champion-attempts.jsonl').trim().split('\n').map((l) => JSON.parse(l))
    expect(attempts.map((a) => a.id ?? a.redacted)).toEqual(['a1', true])
    const scores = read('champion-scores.jsonl').trim().split('\n').map((l) => JSON.parse(l))
    expect(scores.map((s) => s.attempt_id ?? s.redacted)).toEqual(['a1', true])
    // compares: only rows the champion is a side of; held-out ones are the ledger's aggregates, passed through untouched
    const compares = read('compares.jsonl').trim().split('\n').map((l) => JSON.parse(l))
    expect(compares.map((c) => [c.challenger_id, c.vs_id, c.tier])).toEqual([['x', 'champ', 'holdin'], ['x', 'champ', 'holdout'], ['champ', 'prev', 'holdin']])
    expect(compares[0].per_task).toEqual([{ task_id: 'hi1', delta: 1 }])
    expect(compares[1]).toEqual(compareAggregate('x', 'champ'))
    for (const c of compares.filter((c) => c.tier === 'holdout')) {
      for (const key of ['ci', 'per_task', 'mean', 'n', 'shadow']) expect(Object.keys(c)).not.toContain(key)
      expect(c.ladder.best_so_far).toBe(Math.round(c.ladder.best_so_far * 100) / 100)
    }
    expect(read('compares.jsonl')).not.toContain('"y"')
    const all = ['champion-attempts.jsonl', 'champion-scores.jsonl', 'tasks.jsonl'].map(read).join('')
    expect(all).not.toContain('ho1')
    expect(all).not.toContain('hi2')
    // the manifest lists what is there; no environment was given, so none is listed or written
    expect(JSON.parse(read('view.json'))).toEqual({
      view_version: 1, champion_id: 'champ', metric: 'm',
      files: ['champion.json', 'champion-skill', 'tasks.jsonl', 'champion-attempts.jsonl', 'champion-scores.jsonl', 'compares.jsonl', 'proposal.schema.json'],
    })
    expect(JSON.parse(read('proposal.schema.json'))).toMatchObject({ required: ['surface', 'patch', 'intent', 'prediction'] })
    expect(existsSync(join(dir, 'environment.md'))).toBe(false)
    writeFileSync(join(dir, '.keep'), '')
  })

  it('writes environment.md from the loop facts, limits and tool policy when given, and lists it in the manifest', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'samsara-view-')), 'view')
    const environment = { pack: { name: 'p', taskVersion: 2 }, loop: { name: 'null', facts: NULL_HARNESS_FACTS }, limits: { maxTurns: 3, maxMinutes: 2.5 }, tools: { allow: [], deny: ['rm -rf'] } }
    renderView(dir, { championId: 'champ', championSkillDir: MINI_SKILL, metric: 'm', tasks: [], ledger, environment })
    const env = readFileSync(join(dir, 'environment.md'), 'utf8')
    expect(env).toBe(formatEnvironment(environment))
    expect(env).toContain('- pack: p (tasks version 2)')
    expect(env).toContain('- loop: null (adapter null@0)')
    expect(env).toContain('- harness facts: system prompt mode none; skill delivery prompt-inline; schema enforcement permissive-tool; permission none; sandbox none')
    expect(env).toContain('- envelope fidelity: config absent, system absent, tools absent')
    expect(env).toContain('- limits: max turns 3; max minutes 2.5')
    expect(env).toContain('- tools allowed: (provider default)')
    expect(env).toContain('- tools denied: `rm -rf`')
    expect(env).toContain('- protocol: write `proposal.json`')
    expect(JSON.parse(readFileSync(join(dir, 'view.json'), 'utf8')).files).toContain('environment.md')
  })
})

describe('round', () => {
  it('opens the round, renders the view for its champion, runs the human proposer, and the challenge lands in the same round', async () => {
    const h = await openHarness()
    const out = mkdtempSync(join(tmpdir(), 'samsara-round-'))
    const logs: string[] = []
    const r = await round({
      pack: MINI, loop: 'fake', set: 'smoke', repeat: 1, out, maxTurns: 5, maxMinutes: 1,
      proposer: 'human', humanSkillDir: MINI_SKILL, intent: 'same skill', metric: 'pass_rate', nEffFloor: 1, withChampion: false, gatePolicy: 'default',
    }, { ...h.deps({ log: (l) => logs.push(l) }), proposers: { get: () => undefined } })
    expect(r.proposal).toMatchObject({ parent: r.championId, surface: 'skill', intent: 'same skill', prediction: { metric: 'pass_rate', direction: 'up' }, proposer: { name: 'human' } })
    expect(r.viewDir).toBe(join(out, 'view'))
    expect(JSON.parse(readFileSync(join(r.viewDir, 'view.json'), 'utf8'))).toMatchObject({ champion_id: r.championId, metric: 'pass_rate' })
    expect(existsSync(r.proposalPath)).toBe(true)
    // one round: opened before the view, joined again by the challenge chain
    expect(h.ledger.rounds.size).toBe(1)
    expect(h.ledger.round(r.roundId)).toMatchObject({ champion_id: r.championId, sibling_ids: [r.challengerId], status: 'decided' })
    expect(h.ledger.challenger(r.challengerId)).toMatchObject({ status: 'judged', intent: 'same skill', optimizer_config_sha: r.proposal.proposer.config_sha, verdict: { by: DEFAULT } })
    expect(logs.some((l) => l.startsWith(`view rendered at ${r.viewDir}`))).toBe(true)
    const text = formatRound(r)
    expect(text).toContain('proposer   human@1')
    expect(text).toContain(`round      ${r.roundId}`)
  })

  it('a proposal whose challenger is already decided renders that row and closes its round; nothing runs', async () => {
    const drop: GatePolicyProvider = { ...GATE_DEFAULT, judge: async (r) => ({ ...(await GATE_DEFAULT.judge(r)), verdict: 'drop' }) }
    const h = await openHarness({ gate: [drop] })
    const req = (): RoundRequest => ({
      pack: MINI, loop: 'fake', set: 'smoke', repeat: 1, out: mkdtempSync(join(tmpdir(), 'samsara-round-')), maxTurns: 5, maxMinutes: 1,
      proposer: 'human', humanSkillDir: MINI_SKILL, intent: 'same skill', metric: 'pass_rate', nEffFloor: 1, withChampion: false, gatePolicy: 'default',
    })
    const deps = { ...h.deps(), proposers: { get: () => undefined } }
    const first = await round(req(), deps)
    expect(h.ledger.challenger(first.challengerId)).toMatchObject({ status: 'decided', verdict: { value: 'drop' } })
    const attempts = h.ledger.attempts.size
    const again = await round(req(), deps)
    expect(again.challengerId).toBe(first.challengerId)
    expect(again.decided).toMatchObject({ value: 'drop', by: DEFAULT, round_id: first.roundId })
    expect(again.roundId).not.toBe(first.roundId)
    expect(again.outcome).toEqual({ roundId: again.roundId, superseded: [] })
    expect(h.ledger.round(again.roundId)).toMatchObject({ sibling_ids: [first.challengerId], status: 'decided' })
    expect(h.ledger.attempts.size).toBe(attempts)
    expect(formatRound(again)).toContain(`verdict    drop  rule validity  by ${DEFAULT}  (decided before this command; nothing ran)`)
  })

  it('refuses the held-out set before anything opens', async () => {
    const h = await openHarness()
    await expect(round({
      pack: MINI, loop: 'fake', set: 'holdout', repeat: 1, out: mkdtempSync(join(tmpdir(), 'samsara-round-')), maxTurns: 5, maxMinutes: 1,
      proposer: 'human', humanSkillDir: MINI_SKILL, intent: 'i', metric: 'pass_rate', nEffFloor: 1, withChampion: false, gatePolicy: 'default',
    }, { ...h.deps(), proposers: { get: () => undefined } })).rejects.toThrow('held-out set')
    expect(h.ledger.rounds.size).toBe(0)
  })
})
