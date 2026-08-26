// The bench on the recorded fixture: 83 tasks x 3 same-config reruns. The
// fixture rows carry no entity; this TEST supplies one with its own rule
// (entity = the task id's last path segment, stratum = its first) — the
// package never knows a pack. 25 resamples keep it well under 20 s.

import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { gateDefault, GATE_DEFAULT_NAME, GATE_DEFAULT_VERSION } from '@oldbulb/samsara-gate'
import { CATALOG } from '../src/index.ts'
import { bench, formatBench, type BenchAttemptRow, type BenchResult, type BenchTaskRow } from '../src/bench.ts'

const jsonl = <T>(url: URL): T[] => readFileSync(url, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as T)

const attempts = jsonl<BenchAttemptRow>(new URL('../../../tests/fixtures/runs/run-dsh-noise-closed.attempts.jsonl', import.meta.url))
const tasks: BenchTaskRow[] = [...new Set(attempts.map(a => a.task_id))].map(id => ({ task_id: id, entity_key: id.split('/').pop()!, stratum: id.split('/')[0]! }))
// The metric under test is whatever reality-kind score the fixture carries.
const metric = attempts[0]!.scores!.find(s => s.kind === 'reality')!.metric
const gates = [...CATALOG, { name: GATE_DEFAULT_NAME, version: GATE_DEFAULT_VERSION, judge: gateDefault }]

describe('bench on the recorded fixture', () => {
  let result: BenchResult
  beforeAll(async () => {
    result = await bench({ attempts, tasks, metric, gates, resamples: 25, seed: 1, effects: [{ kind: 'flip', p: 0.4 }] })
  })
  const cell = (gate: string, scenario: string) => result.cells.find(c => c.gate === gate && c.scenario === scenario)!

  it('the task list covers the fixture', () => {
    const ids = new Set(tasks.map(t => t.task_id))
    expect(attempts.every(a => ids.has(a.task_id))).toBe(true)
  })

  it('reads the data facts', () => {
    expect(result.tasks).toBe(83)
    expect(result.entities).toBe(43)
    expect(result.reruns).toBe(3)
    expect(result.rows).toBe(249)
    expect(result.excluded).toBe(0)
    expect(result.orderedPairs).toEqual(['0>1', '0>2', '1>0', '1>2', '2>0', '2>1'])
    expect(result.sdPaired.task).toBeCloseTo(0.363, 2)
    expect(result.sdPaired.entity).toBeCloseTo(0.344, 2)
    expect(result.scenarios.map(s => s.name)).toEqual(['null', 'flip 0.4'])
    expect(result.gates).toContain('keep-better@0.1.0')
    expect(result.gates).toContain(`${GATE_DEFAULT_NAME}@${GATE_DEFAULT_VERSION}`)
  })

  it('null acceptance: keep-better is a coin, miller is small', () => {
    const kb = cell('keep-better@0.1.0', 'null')
    expect(kb.rate).toBeGreaterThanOrEqual(0.3)
    expect(kb.rate).toBeLessThanOrEqual(0.7)
    expect(kb.mcSe).toBeCloseTo(Math.sqrt((kb.rate * (1 - kb.rate)) / 25))
    expect(cell('miller@0.1.0', 'null').rate).toBeLessThan(0.2)
    expect(Math.abs(cell('miller@0.1.0', 'null').meanDelta)).toBeLessThan(0.05)
    // gate-default cannot promote on this pack as recorded: the SESOI-free design is only nEff-floored, so it is rule 7 that decides
    expect(cell(`${GATE_DEFAULT_NAME}@${GATE_DEFAULT_VERSION}`, 'null').rate).toBeLessThan(0.3)
  })

  it('an injected flip raises the mean delta and every gate\'s rate', () => {
    expect(cell('keep-better@0.1.0', 'flip 0.4').meanDelta).toBeGreaterThan(0.03)
    expect(cell('keep-better@0.1.0', 'flip 0.4').rate).toBeGreaterThan(cell('keep-better@0.1.0', 'null').rate)
    expect(cell('miller@0.1.0', 'flip 0.4').rate).toBeGreaterThanOrEqual(cell('miller@0.1.0', 'null').rate)
  })

  it('exact decisions on the six real ordered pairs', () => {
    const kb = result.exact.filter(e => e.gate === 'keep-better@0.1.0')
    expect(kb).toHaveLength(6)
    // the mean delta of a>b is the negative of b>a, so exactly one of each ordering promotes unless it is a tie
    expect(kb.filter(e => e.verdict === 'promote').length).toBe(3)
    expect(result.exact.filter(e => e.gate === 'miller@0.1.0').every(e => e.verdict === 'hold')).toBe(true)
  })

  it('is deterministic in the seed and serialises as JSON', async () => {
    const again = await bench({ attempts, tasks, metric, gates: [CATALOG[0]!], resamples: 5, seed: 1 })
    const twice = await bench({ attempts, tasks, metric, gates: [CATALOG[0]!], resamples: 5, seed: 1 })
    expect(again).toEqual(twice)
    expect(JSON.parse(JSON.stringify(again))).toEqual(again)
  })

  it('formats a markdown table', () => {
    const md = formatBench(result)
    expect(md).toContain('| gate | null | flip 0.4 |')
    expect(md).toContain('| keep-better@0.1.0 |')
    expect(md).toContain('## Exact decisions on the real ordered pairs')
    expect(md).toContain('not population error rates')
  })

  it('refuses a task without an entity', async () => {
    await expect(bench({ attempts, tasks: tasks.slice(1), metric, gates: [CATALOG[0]!], resamples: 1 })).rejects.toThrow(/no entity for task_ids: /)
  })

  it('refuses a task with fewer than two scored reruns', async () => {
    const one = attempts.filter((a, i) => attempts.findIndex(b => b.task_id === a.task_id) === i || a.task_id !== attempts[0]!.task_id)
    await expect(bench({ attempts: one, tasks, metric, gates: [CATALOG[0]!], resamples: 1 })).rejects.toThrow(/fewer than 2 scored reruns/)
  })

  // Each of these used to reach Math.min() over nothing and loop until a RangeError.
  it('refuses no attempt rows', async () => {
    await expect(bench({ attempts: [], tasks, metric, gates: [CATALOG[0]!], resamples: 1 })).rejects.toThrow(/^bench: no attempt rows$/)
  })

  it('refuses no tasks', async () => {
    await expect(bench({ attempts, tasks: [], metric, gates: [CATALOG[0]!], resamples: 1 })).rejects.toThrow(/^bench: no tasks$/)
  })

  it('refuses a metric no row carries', async () => {
    await expect(bench({ attempts, tasks, metric: 'absent', gates: [CATALOG[0]!], resamples: 1 })).rejects.toThrow(/no scored rows for metric absent \(0 ABORTED\/FAILED, 249 without the metric\)/)
  })

  it('refuses rows that are all ABORTED or FAILED', async () => {
    const dead = attempts.map((a, i) => ({ ...a, status: i % 2 ? 'ABORTED' : 'FAILED' }))
    await expect(bench({ attempts: dead, tasks, metric, gates: [CATALOG[0]!], resamples: 1 })).rejects.toThrow(/no scored rows for metric .* \(249 ABORTED\/FAILED, 0 without the metric\)/)
  })

  it('keeps the last row per attemptId, as the runner reads the file', async () => {
    // A doubled file used to count every rerun twice, each paired with its own copy at delta 0.
    const once = await bench({ attempts, tasks, metric, gates: [CATALOG[0]!], resamples: 5, seed: 1 })
    const twice = await bench({ attempts: [...attempts, ...attempts], tasks, metric, gates: [CATALOG[0]!], resamples: 5, seed: 1 })
    expect(twice).toEqual(once)
    expect(twice.reruns).toBe(3)
    expect(twice.rows).toBe(249)
    // the later row wins: re-recording one attempt as FAILED excludes it, and its task's two reruns cut every task to two
    const failed = { ...attempts[0]!, status: 'FAILED' }
    const re = await bench({ attempts: [...attempts, failed], tasks, metric, gates: [CATALOG[0]!], resamples: 1 })
    expect(re).toMatchObject({ reruns: 2, rows: 248, excluded: 1 })
  })

  it('refuses resamples below 1 instead of a NaN table', async () => {
    for (const resamples of [0, -1, 1.5]) {
      await expect(bench({ attempts, tasks, metric, gates: [CATALOG[0]!], resamples })).rejects.toThrow(/^bench: resamples must be a positive integer, got /)
    }
  })

  it('refuses a judge-kind metric', async () => {
    const judged = attempts.map(a => ({ ...a, scores: a.scores!.map(s => (s.metric === metric ? { ...s, kind: 'judge' } : s)) }))
    await expect(bench({ attempts: judged, tasks, metric, gates: [CATALOG[0]!], resamples: 1 })).rejects.toThrow(/is of kind judge \(on /)
  })
})
