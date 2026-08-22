// End-to-end: the framework (@samsara/pack + @samsara/book) drives the
// coding-tasks pack purely through pack.yaml and subprocess jsonl.
import { beforeAll, describe, expect, it } from 'vitest'
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { loadPack, runCommand, type PackDefinition, type TaskLine } from '../packages/pack/src/index.ts'
import { createBook, type Task } from '../packages/book/src/index.ts'

const PACK_DIR = resolve(import.meta.dirname, '..', 'packs', 'coding-tasks')
const SHA_RE = /^[0-9a-f]{64}$/

let def: PackDefinition
beforeAll(() => {
  def = loadPack(PACK_DIR)
})

describe('book from pack task sets', () => {
  it('has 82 tasks (34 + 48 by stratum) with a disjoint holdout', () => {
    const book = createBook({
      sets: {
        smoke: def.taskSets.smoke.tasks as Task[],
        holdin: def.taskSets.holdin.tasks as Task[],
        holdout: def.taskSets.holdout.tasks as Task[],
      },
      entityKey: def.manifest.tasks.entity_key,
      holdoutPolicy: { mde: def.manifest.holdout?.mde ?? 0.05, budget: def.manifest.holdout?.budget ?? 1 },
    })
    expect(() => book.assertDisjointHoldout()).not.toThrow()
    const all = [...book.tasks('smoke'), ...book.tasks('holdin'), ...book.tasks('holdout')]
    expect(all).toHaveLength(82)
    const byStratum = new Map<string, number>()
    for (const t of all) byStratum.set(t.stratum ?? '', (byStratum.get(t.stratum ?? '') ?? 0) + 1)
    const counts = [...byStratum.values()].sort((a, b) => a - b)
    expect(counts).toEqual([34, 48])
    expect(book.tasks('smoke')).toHaveLength(8)
  })
})

/** Two tasks per stratum from smoke ∪ holdin, deterministic order. */
function sampleTasks(): TaskLine[] {
  const pool = [...def.taskSets.smoke.tasks, ...def.taskSets.holdin.tasks]
  const strata = [...new Set(pool.map((t) => t.stratum))].sort()
  expect(strata).toHaveLength(2)
  return strata.flatMap((s) => pool.filter((t) => t.stratum === s).slice(0, 2))
}

interface FixtureMeta {
  files: { solution: string[]; test: string[]; example: string[] }
}

describe('materialize → truth → reference solution → truth → score', () => {
  const roots: string[] = []
  const tasks = () => sampleTasks()

  it('runs the full loop for 2 tasks per stratum', { timeout: 600_000 }, async () => {
    const sample = tasks()
    expect(sample).toHaveLength(4)
    const root = mkdtempSync(join(tmpdir(), 'samsara-e2e-'))
    roots.push(root)

    const lines = sample.map((t) => ({ task_id: t.task_id, workdir: join(root, t.task_id.replace('/', '__')) }))

    // 1. materialize
    const mat = await runCommand(def, 'materialize', lines)
    expect(mat).toHaveLength(sample.length)
    for (const [i, row] of mat.entries()) {
      expect(row.task_id).toBe(lines[i]!.task_id)
      expect(row.ok).toBe(true)
      expect(Array.isArray(row.files)).toBe(true)
      expect((row.files as string[]).length).toBeGreaterThan(0)
    }

    // 2. truth on the untouched stub: settled, some failures
    const stubTruth = await runCommand(def, 'truth', lines)
    expect(stubTruth).toHaveLength(sample.length)
    const stubSha = new Map<string, string>()
    for (const [i, row] of stubTruth.entries()) {
      expect(row.task_id).toBe(lines[i]!.task_id)
      expect(row.status).toBe('settled')
      expect(row.truth_sha).toMatch(SHA_RE)
      const truth = row.truth as { passed: number; failed: number; total: number; exit_code: number }
      expect(truth.total).toBeGreaterThan(0)
      expect(truth.failed).toBeGreaterThan(0)
      expect(truth.passed).toBeLessThan(truth.total)
      stubSha.set(row.task_id as string, row.truth_sha as string)
    }

    // 3. overwrite stub with the reference solution (from the fixture's .meta)
    for (const [i, t] of sample.entries()) {
      const fixture = resolve(PACK_DIR, t['fixture'] as string)
      const meta = JSON.parse(readFileSync(join(fixture, '.meta', 'config.json'), 'utf8')) as FixtureMeta
      expect(meta.files.example).toHaveLength(meta.files.solution.length)
      meta.files.example.forEach((ex, k) => {
        cpSync(join(fixture, ex), join(lines[i]!.workdir, meta.files.solution[k]!))
      })
    }

    // 4. truth again: all pass, truth_sha unchanged (tests are pinned, not the solution)
    const refTruth = await runCommand(def, 'truth', lines)
    expect(refTruth).toHaveLength(sample.length)
    for (const [i, row] of refTruth.entries()) {
      expect(row.task_id).toBe(lines[i]!.task_id)
      expect(row.status).toBe('settled')
      expect(row.truth_sha).toBe(stubSha.get(row.task_id as string))
      const truth = row.truth as { passed: number; failed: number; total: number; exit_code: number }
      expect(truth.failed).toBe(0)
      expect(truth.exit_code).toBe(0)
      expect(truth.passed).toBe(truth.total)
      expect(truth.total).toBeGreaterThan(0)
    }

    // 5. score: pass_rate = 1 (reality), cost + tool_calls (mechanical), stratum = task stratum
    const scoreIn = refTruth.map((row) => ({
      task_id: row.task_id,
      truth: row.truth,
      output: {
        usage: { input_tokens: 1000, output_tokens: 200, cost_usd: 0.01 },
        tool_calls: 3,
        submit: { summary: 'reference', files_changed: [], confidence: 1 },
      },
    }))
    const score = await runCommand(def, 'score', scoreIn)
    const byTask = new Map<string, Record<string, unknown>[]>()
    for (const row of score) {
      expect(['mechanical', 'reality', 'judge']).toContain(row.kind)
      byTask.set(row.task_id as string, [...(byTask.get(row.task_id as string) ?? []), row])
    }
    for (const t of sample) {
      const rows = byTask.get(t.task_id) ?? []
      const metrics = Object.fromEntries(rows.map((r) => [r.metric as string, r]))
      expect(metrics['pass_rate']).toMatchObject({ value: 1, kind: 'reality', stratum: t.stratum })
      expect(metrics['cost_usd']).toMatchObject({ kind: 'mechanical', stratum: t.stratum })
      expect(metrics['tool_calls']).toMatchObject({ value: 3, kind: 'mechanical', stratum: t.stratum })
      expect(rows.some((r) => r.kind === 'mechanical')).toBe(true)
    }

    for (const r of roots) rmSync(r, { recursive: true, force: true })
  })
})
