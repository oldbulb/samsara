import { describe, expect, it } from 'vitest'
import {
  createBook,
  computeTruthSnapshotId,
  HoldoutBudgetExhausted,
  HoldoutNotDisjoint,
  type Task,
  type TruthRecord,
} from '../src/index.ts'

const t = (id: string, entity: string): Task => ({ task_id: id, entity_key: entity, stratum: id.split('/')[0] })
const sha = (s: string) => s.padEnd(64, '0')

function book(budget = 2) {
  return createBook({
    sets: {
      smoke: [t('a/1', 'e1')],
      holdin: [t('a/2', 'e2'), t('b/2', 'e2')],
      holdout: [t('a/3', 'e3'), t('b/4', 'e4')],
    },
    entityKey: 'entity_key',
    holdoutPolicy: { mde: 0.05, budget },
  })
}

describe('disjointness', () => {
  it('passes when holdout entities never appear in smoke/holdin', () => {
    expect(() => book().assertDisjointHoldout()).not.toThrow()
  })
  it('throws listing offending entity keys', () => {
    const b = createBook({
      sets: { smoke: [t('a/1', 'e1')], holdin: [t('a/2', 'e2')], holdout: [t('b/1', 'e1'), t('b/2', 'e2'), t('b/3', 'e3')] },
      entityKey: 'entity_key',
      holdoutPolicy: { mde: 0.05, budget: 1 },
    })
    let err: unknown
    try { b.assertDisjointHoldout() } catch (e) { err = e }
    expect(err).toBeInstanceOf(HoldoutNotDisjoint)
    expect((err as HoldoutNotDisjoint).offending).toEqual(['e1', 'e2'])
    expect((err as Error).message).toContain('e1, e2')
  })
  it('rejects duplicate task ids across sets', () => {
    expect(() => createBook({
      sets: { smoke: [t('x', 'e')], holdin: [t('x', 'e')], holdout: [] },
      entityKey: 'entity_key', holdoutPolicy: { mde: 0.1, budget: 1 },
    })).toThrow(/duplicate task_id x/)
  })
})

describe('settlement', () => {
  const recs: TruthRecord[] = [
    { task_id: 'a/2', status: 'settled', truth_sha: sha('aa'), truth: { passed: 1 } },
    { task_id: 'a/1', status: 'settled', truth_sha: sha('bb') },
    { task_id: 'a/3', status: 'pending', truth_sha: sha('cc') },
  ]
  it('pins truth_snapshot_id independent of record order and pending rows', () => {
    const s1 = book().settle(recs, '2026-01-01T00:00:00Z')
    const s2 = book().settle([...recs].reverse(), '2026-01-01T00:00:00Z')
    expect(s1.truth_snapshot_id).toBe(s2.truth_snapshot_id)
    expect(s1.id).toBe(s2.id)
    expect(s1.truth_snapshot_id).toBe(computeTruthSnapshotId(recs.slice(0, 2)))
    expect(s1).toMatchObject({ kind: 'truth', n_settled: 2, n_pending: 1, task_ids: ['a/1', 'a/2', 'a/3'] })
  })
  it('changes snapshot id when a truth_sha changes', () => {
    const s1 = book().settle(recs, '2026-01-01T00:00:00Z')
    const changed = recs.map((r) => (r.task_id === 'a/1' ? { ...r, truth_sha: sha('dd') } : r))
    expect(book().settle(changed, '2026-01-01T00:00:00Z').truth_snapshot_id).not.toBe(s1.truth_snapshot_id)
  })
  it('tracks pending tasks and emits book/settled', () => {
    const b = book()
    const seen: string[] = []
    const off = b.on('book/settled', (s) => seen.push(s.id))
    const s = b.settle(recs, '2026-01-01T00:00:00Z')
    expect(seen).toEqual([s.id])
    expect(b.pendingTasks().map((x) => x.task_id).sort()).toEqual(['a/3', 'b/2', 'b/4'])
    off()
    b.settle(recs, '2026-01-02T00:00:00Z')
    expect(seen).toHaveLength(1)
  })
  it('tasksetSha is sha over sorted ids', () => {
    const b1 = book()
    const b2 = createBook({ sets: { smoke: [], holdin: [t('b/2', 'x'), t('a/2', 'y')], holdout: [] }, entityKey: 'entity_key', holdoutPolicy: { mde: 0.1, budget: 1 } })
    expect(b1.tasksetSha('holdin')).toBe(b2.tasksetSha('holdin'))
    expect(b1.tasksetSha('holdin')).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('visibility matrix', () => {
  const b = book()
  it.each([
    ['a/1', 'proposer', 'individual'],
    ['a/2', 'proposer', 'individual'],
    ['a/3', 'proposer', 'aggregate'],
    ['a/3', 'gate', 'individual'],
    ['a/3', 'human', 'individual'],
    ['a/1', 'gate', 'individual'],
    ['nope', 'proposer', 'hidden'],
    ['nope', 'human', 'hidden'],
  ] as const)('%s / %s -> %s', (id, viewer, vis) => {
    expect(b.visibility(id, viewer)).toBe(vis)
  })
})

describe('holdout budget', () => {
  it('debits until exhausted then throws', () => {
    const b = book(2)
    expect(b.holdoutBudget()).toEqual({ remaining: 2, spent: 0 })
    expect(b.debitHoldout('promotion 1')).toEqual({ remaining: 1, spent: 1 })
    expect(b.debitHoldout('promotion 2')).toEqual({ remaining: 0, spent: 2 })
    expect(() => b.debitHoldout('promotion 3')).toThrow(HoldoutBudgetExhausted)
    expect(b.holdoutBudget()).toEqual({ remaining: 0, spent: 2 })
  })
})
