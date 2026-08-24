import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AttemptRow, CompareRow, Ledger, ScoreRow } from '@oldbulb/samsara-ledger'
import { renderView } from '../src/round.ts'

const MINI_SKILL = resolve(import.meta.dirname, '..', '..', 'pack', 'tests', 'fixtures', 'minipack', 'skill')

function attempt(id: string, challenger: string, task: string, tier: AttemptRow['tier']): AttemptRow {
  return {
    id, challenger_id: challenger, task_id: task, sample: 0, loop: 'null', tier, status: 'COMPLETED', stop_reason: 'completed',
    facts_sha: '', usage: { input_tokens: 1, output_tokens: 1 }, cost: {}, output: { source: 'file', valid: true }, artifacts: [],
  }
}

function compare(tier: CompareRow['tier']): CompareRow {
  return {
    challenger_id: 'x', vs_id: 'champ', tier, truth_snapshot_id: 's', per_task: [{ task_id: 'ho1', delta: 1 }], mean: 1, ci: [0, 1],
    method: 'm', cluster_key: 'e', n_eff: 1, mde: 0, rule_fired: 'r', verdict: { value: 'hold', by: 'g', rule: 'r' }, at: 'now',
  }
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
    if (view === 'compares') return [compare('holdin'), compare('holdout')]
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
    const compares = read('compares.jsonl').trim().split('\n').map((l) => JSON.parse(l))
    expect(compares[0].per_task).toEqual([{ task_id: 'ho1', delta: 1 }])
    expect(compares[1]).toMatchObject({ tier: 'holdout', per_task: [], per_task_n: 1 })
    const all = ['champion-attempts.jsonl', 'champion-scores.jsonl', 'tasks.jsonl'].map(read).join('')
    expect(all).not.toContain('ho1')
    expect(all).not.toContain('hi2')
    writeFileSync(join(dir, '.keep'), '')
  })
})
