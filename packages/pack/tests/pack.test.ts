import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { mkdtempSync, writeFileSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { loadPack, runCommand, surfaceBoundaries, validateSubmit, PackError } from '../src/index.ts'

const MINI = resolve(import.meta.dirname, 'fixtures', 'minipack')

async function errorOf(p: Promise<unknown>): Promise<PackError> {
  try { await p } catch (e) { return e as PackError }
  throw new Error('expected rejection')
}

describe('loadPack', () => {
  it('resolves paths, task sets, commands and surfaces', () => {
    const def = loadPack(MINI)
    expect(def.name).toBe('minipack')
    expect(def.truthLatency).toBe('immediate')
    expect(def.taskSets.smoke.tasks).toEqual([{ task_id: 's1', entity_key: 'e1', stratum: 'a' }])
    expect(def.taskSets.holdout.tasks[0]?.task_id).toBe('o1')
    expect(Object.keys(def.commands).sort()).toEqual(['materialize', 'score', 'truth'])
    expect(surfaceBoundaries(def)).toEqual({
      skill: { globs: ['skill/**'], config_keys: [] },
      tools: { globs: [], config_keys: ['tools.allowlist'] },
    })
    expect(def.skillDir).toBe(resolve(MINI, 'skill/'))
  })
  it('rejects a missing or invalid manifest', () => {
    expect(() => loadPack(tmpdir())).toThrow(PackError)
    const dir = mkdtempSync(resolve(tmpdir(), 'badpack-'))
    cpSync(MINI, dir, { recursive: true })
    writeFileSync(resolve(dir, 'pack.yaml'), 'name: x\ntruth_latency: sometimes\n')
    let err: unknown
    try { loadPack(dir) } catch (e) { err = e }
    expect((err as PackError).code).toBe('manifest')
  })
  it('rejects a task line without entity_key', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'badtasks-'))
    cpSync(MINI, dir, { recursive: true })
    writeFileSync(resolve(dir, 'tasks/smoke.jsonl'), '{"task_id":"s1"}\n')
    let err: unknown
    try { loadPack(dir) } catch (e) { err = e }
    expect((err as PackError).code).toBe('tasks')
    expect((err as PackError).lineNo).toBe(1)
  })
})

describe('validateSubmit', () => {
  it('accepts and rejects against the pack contract', () => {
    const def = loadPack(MINI)
    expect(() => validateSubmit(def, { summary: 'ok' })).not.toThrow()
    let err: unknown
    try { validateSubmit(def, { summary: 1 }) } catch (e) { err = e }
    expect((err as PackError).code).toBe('submit')
  })
})

describe('runCommand', () => {
  const def = loadPack(MINI)
  const tasks = [{ task_id: 's1', workdir: '/x' }, { task_id: 'h1', workdir: '/y' }]

  it('runs truth and validates every line', async () => {
    const rows = await runCommand(def, 'truth', tasks)
    expect(rows.map((r) => r.task_id)).toEqual(['s1', 'h1'])
    expect(rows[0]).toMatchObject({ status: 'settled', truth_sha: 'ab'.repeat(32) })
  })
  it('runs score and materialize', async () => {
    const score = await runCommand(def, 'score', [{ task_id: 's1', truth: { passed: 1, total: 2 }, output: {} }])
    expect(score).toHaveLength(2)
    expect(score[0]).toMatchObject({ metric: 'pass_rate', value: 0.5, kind: 'reality', stratum: 'a' })
    const mat = await runCommand(def, 'materialize', [{ task_id: 's1', workdir: '/x' }])
    expect(mat[0]).toMatchObject({ task_id: 's1', ok: true })
  })
  it('rejects schema-invalid and non-json lines', async () => {
    const bad = await errorOf(runCommand(def, 'truth', tasks, { env: { ...process.env, MINIPACK_MODE: 'bad' } }))
    expect(bad.code).toBe('invalid-line')
    expect(bad.lineNo).toBe(1)
    const nj = await errorOf(runCommand(def, 'truth', tasks, { env: { ...process.env, MINIPACK_MODE: 'notjson' } }))
    expect(nj.code).toBe('invalid-line')
  })
  // Four subprocess round-trips, one of them a deliberate 500 ms hang: slower
  // than vitest's 5 s default on a cold CI runner.
  it('surfaces non-zero exit with stderr, timeouts, and missing commands', { timeout: 30_000 }, async () => {
    const crash = await errorOf(runCommand(def, 'truth', tasks, { env: { ...process.env, MINIPACK_MODE: 'crash' } }))
    expect(crash.code).toBe('exit')
    expect(crash.exitCode).toBe(3)
    expect(crash.stderr).toContain('boom')
    const hang = await errorOf(runCommand(def, 'truth', tasks, { env: { ...process.env, MINIPACK_MODE: 'hang' }, timeoutMs: 500 }))
    expect(hang.code).toBe('timeout')
    const missing = await errorOf(runCommand(def, 'data', tasks))
    expect(missing.code).toBe('command-missing')
  })
})
