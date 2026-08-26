import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { mkdtempSync, readFileSync, writeFileSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { commandEnv, loadPack, protectedPaths, runCommand, surfaceBoundaries, validateSubmit, PackError } from '../src/index.ts'

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
  it('loads the documented contract: metrics, tasks.protocol, holdout.retention_tolerance and runtime', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'fullpack-'))
    cpSync(MINI, dir, { recursive: true })
    writeFileSync(resolve(dir, 'pack.yaml'), [
      'name: fullpack', 'truth_latency: delayed', 'skill: { dir: skill/, name: mini }', 'contract: contract.schema.json',
      'tasks:', '  sets: { smoke: tasks/smoke.jsonl, holdin: tasks/holdin.jsonl, holdout: tasks/holdout.jsonl }', '  entity_key: entity_key', '  version: 3',
      '  protocol: { stage: closed-book, contracts: [hidden-tests] }',
      'metrics:', '  primary: { name: solved, unit: fraction, direction: up }', '  cost: spend',
      'runtime: { dirs: [runtime/py], locks: ["runtime/**/*.lock"], env: [PACK_MODE] }',
      'holdout: { mde: 0.05, retention_tolerance: 0.05, auto_demote: true, budget: 4 }',
      'surfaces: { skill: { globs: ["skill/**"] } }',
      'commands: { truth: ./bin/truth, score: ./bin/score }',
    ].join('\n') + '\n')
    const def = loadPack(dir)
    expect(def.manifest.metrics).toEqual({ primary: { name: 'solved', unit: 'fraction', direction: 'up' }, cost: 'spend' })
    expect(def.manifest.tasks.protocol).toEqual({ stage: 'closed-book', contracts: ['hidden-tests'] })
    expect(def.manifest.runtime).toEqual({ dirs: ['runtime/py'], locks: ['runtime/**/*.lock'], env: ['PACK_MODE'] })
    expect(def.manifest.holdout).toEqual({ mde: 0.05, retention_tolerance: 0.05, auto_demote: true, budget: 4 })
  })
  it('rejects the holdout rotation keys nothing reads (S7: rotation is not implemented)', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'rotpack-'))
    cpSync(MINI, dir, { recursive: true })
    writeFileSync(resolve(dir, 'pack.yaml'), readFileSync(resolve(MINI, 'pack.yaml'), 'utf8').replace('holdout: { mde: 0.1, budget: 2 }', 'holdout: { mde: 0.1, rotate_after_promotions: 1 }'))
    let err: unknown
    try { loadPack(dir) } catch (e) { err = e }
    expect((err as PackError).code).toBe('manifest')
  })
})

describe('protectedPaths', () => {
  it('names the manifest, the contract, the task sets and every pack file a command line names', () => {
    const def = loadPack(MINI)
    expect(protectedPaths(def)).toEqual(['bin/materialize', 'bin/score', 'bin/truth', 'contract.schema.json', 'pack.yaml', 'tasks/holdin.jsonl', 'tasks/holdout.jsonl', 'tasks/smoke.jsonl'])
    const interp = { ...def, commands: { truth: 'python3 bin/truth --as-of now', score: '/usr/bin/env node ./bin/score' } }
    expect(protectedPaths(interp)).toEqual(['bin/score', 'bin/truth', 'contract.schema.json', 'pack.yaml', 'tasks/holdin.jsonl', 'tasks/holdout.jsonl', 'tasks/smoke.jsonl'])
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
  it('E5: a command sees the allow-list and the names the pack declares, never a credential or the harness identity', async () => {
    const source = { PATH: process.env['PATH']!, HOME: '/h', LANG: 'C', TMPDIR: '/t', MINIPACK_MODE: 'env', DEEPSEEK_API_KEY: 'k', GITHUB_TOKEN: 't', DSH_PROFILE: 'host', UNRELATED: '1' }
    expect(commandEnv(def, { TMPDIR: '/attempt/tmp' }, source)).toEqual({ PATH: source.PATH, HOME: '/h', LANG: 'C', TMPDIR: '/attempt/tmp', MINIPACK_MODE: 'env' })
    const prev = process.env['MINIPACK_SECRET_KEY']
    process.env['MINIPACK_SECRET_KEY'] = 'leak'
    process.env['MINIPACK_MODE'] = 'env'
    try {
      const [row] = await runCommand(def, 'truth', [tasks[0]!])
      const names = (row!['truth'] as { env: string[] }).env
      expect(names).toContain('PATH')
      expect(names).toContain('MINIPACK_MODE')
      expect(names).not.toContain('MINIPACK_SECRET_KEY')
    } finally {
      delete process.env['MINIPACK_MODE']
      if (prev === undefined) delete process.env['MINIPACK_SECRET_KEY']
      else process.env['MINIPACK_SECRET_KEY'] = prev
    }
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
  // Four subprocess round-trips, one of them a deliberate 500 ms hang; the
  // default 5 s leaves no room on a cold CI runner.
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
