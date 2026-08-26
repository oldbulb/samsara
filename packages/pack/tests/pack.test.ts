import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { mkdtempSync, readFileSync, writeFileSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { commandEnv, loadPack, protectedPaths, runCommand, surfaceBoundaries, validateSubmit, PackError, type CommandExec } from '../src/index.ts'

const MINI = resolve(import.meta.dirname, 'fixtures', 'minipack')

/** minipack with `truth` moved inside an environment and `score` left on the host. */
function envPack(environment = 'environment: { image: "example/judge:1", resources: { cpus: 2, memory_mb: 1024, timeout_s: 90 }, network: allowlist, allowed_hosts: [pypi.org] }'): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'envpack-'))
  cpSync(MINI, dir, { recursive: true })
  writeFileSync(resolve(dir, 'pack.yaml'), [
    'name: envpack', 'truth_latency: immediate', 'skill: { dir: skill/, name: mini }', 'contract: contract.schema.json',
    'tasks:', '  sets: { smoke: tasks/smoke.jsonl, holdin: tasks/holdin.jsonl, holdout: tasks/holdout.jsonl }', '  entity_key: entity_key',
    environment,
    'commands:', '  truth: { run: ./bin/truth, in_environment: true }', '  score: ./bin/score', '  materialize: { run: ./bin/materialize }',
  ].filter((l) => l !== '').join('\n') + '\n')
  return dir
}

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
  it('loads the documented environment block and both command forms', () => {
    const def = loadPack(envPack())
    expect(def.manifest.environment).toEqual({ image: 'example/judge:1', resources: { cpus: 2, memory_mb: 1024, timeout_s: 90 }, network: 'allowlist', allowed_hosts: ['pypi.org'] })
    expect(def.commands).toEqual({ truth: './bin/truth', score: './bin/score', materialize: './bin/materialize' })
    expect(def.commandSpecs).toEqual({
      truth: { run: './bin/truth', inEnvironment: true },
      score: { run: './bin/score', inEnvironment: false },
      materialize: { run: './bin/materialize', inEnvironment: false },
    })
    expect(protectedPaths(def)).toContain('bin/truth')
    expect(loadPack(MINI).manifest.environment).toBeUndefined()
  })
  it('rejects an unknown environment key, a bad network, and a command object without run', () => {
    const codeOf = (dir: string) => { try { loadPack(dir) } catch (e) { return (e as PackError).code } return undefined }
    expect(codeOf(envPack('environment: { image: x, gpu: 1 }'))).toBe('manifest')
    expect(codeOf(envPack('environment: { network: lan }'))).toBe('manifest')
    const dir = envPack()
    writeFileSync(resolve(dir, 'pack.yaml'), readFileSync(resolve(dir, 'pack.yaml'), 'utf8').replace('{ run: ./bin/truth, in_environment: true }', '{ in_environment: true }'))
    expect(codeOf(dir)).toBe('manifest')
  })
  it('passes a task row\'s environment column through untouched and rejects a non-object one', () => {
    const dir = envPack()
    const row = { task_id: 's1', entity_key: 'e1', environment: { dockerfile: 'tasks/s1/environment', resources: { timeout_s: 30 } } }
    writeFileSync(resolve(dir, 'tasks/smoke.jsonl'), JSON.stringify(row) + '\n')
    expect(loadPack(dir).taskSets.smoke.tasks).toEqual([row])
    writeFileSync(resolve(dir, 'tasks/smoke.jsonl'), '{"task_id":"s1","entity_key":"e1","environment":"x"}\n')
    let err: unknown
    try { loadPack(dir) } catch (e) { err = e }
    expect((err as PackError).code).toBe('tasks')
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

describe('runCommand in an environment', () => {
  const def = loadPack(envPack())
  const tasks = [{ task_id: 's1', workdir: '/w' }]
  const settled = (task_id: string) => JSON.stringify({ task_id, status: 'settled', truth: { passed: 1, total: 1 }, truth_sha: 'ab'.repeat(32) }) + '\n'
  type Call = { argv: string[]; stdin: string; opts: Parameters<CommandExec>[2] }
  const fake = (reply: (call: Call) => Awaited<ReturnType<CommandExec>>) => {
    const calls: Call[] = []
    const exec: CommandExec = async (argv, stdin, opts) => { const call = { argv, stdin, opts }; calls.push(call); return reply(call) }
    return { calls, exec }
  }

  it('runs the line protocol through exec with the shell line, the caller\'s env and cwd, and validates every line', async () => {
    const { calls, exec } = fake(({ stdin }) => ({ code: 0, stdout: stdin.trim().split('\n').map((l) => settled(JSON.parse(l).task_id)).join(''), stderr: '' }))
    const rows = await runCommand(def, 'truth', [...tasks, { task_id: 'h1', workdir: '/v' }], { exec, env: { TMPDIR: '/attempt/tmp', GONE: undefined }, cwd: '/work', args: ['--as-of', 'now'] })
    expect(rows.map((r) => r.task_id)).toEqual(['s1', 'h1'])
    expect(calls).toHaveLength(1)
    expect(calls[0]!.argv).toEqual(['sh', '-c', './bin/truth --as-of now'])
    expect(calls[0]!.stdin).toBe(tasks.map((t) => JSON.stringify(t)).join('\n') + '\n' + JSON.stringify({ task_id: 'h1', workdir: '/v' }) + '\n')
    expect(calls[0]!.opts).toEqual({ cwd: '/work', env: { TMPDIR: '/attempt/tmp' }, timeoutMs: 90_000 })
    const bad = await errorOf(runCommand(def, 'truth', tasks, { exec: fake(() => ({ code: 0, stdout: '{"task_id":"s1","status":"settled"}\n', stderr: '' })).exec }))
    expect(bad.code).toBe('invalid-line')
    expect(bad.lineNo).toBe(1)
  })
  it('takes the caller\'s timeout over the pack\'s, and leaves the cwd to the environment when not given', async () => {
    const { calls, exec } = fake(() => ({ code: 0, stdout: settled('s1'), stderr: '' }))
    await runCommand(def, 'truth', tasks, { exec, timeoutMs: 1234 })
    expect(calls[0]!.opts).toEqual({ env: {}, timeoutMs: 1234 })
    const bare = loadPack(envPack(''))
    const { calls: bareCalls, exec: bareExec } = fake(() => ({ code: 0, stdout: settled('s1'), stderr: '' }))
    await runCommand(bare, 'truth', tasks, { exec: bareExec })
    expect(bareCalls[0]!.opts.timeoutMs).toBe(3_600_000)
  })
  it('surfaces a non-zero exit, a kill, a null code, and an exec that throws', async () => {
    const crash = await errorOf(runCommand(def, 'truth', tasks, { exec: fake(() => ({ code: 3, stdout: '', stderr: 'boom\n' })).exec }))
    expect(crash.code).toBe('exit')
    expect(crash.exitCode).toBe(3)
    expect(crash.stderr).toContain('boom')
    const killed = await errorOf(runCommand(def, 'truth', tasks, { exec: fake(() => ({ code: null, signal: 'SIGTERM', stdout: '', stderr: '' })).exec }))
    expect(killed.code).toBe('exit')
    expect(killed.signal).toBe('SIGTERM')
    const timedOut = await errorOf(runCommand(def, 'truth', tasks, { exec: fake(() => ({ code: null, stdout: '', stderr: '' })).exec, timeoutMs: 50 }))
    expect(timedOut.code).toBe('timeout')
    expect(timedOut.message).toContain('50ms')
    const gone = await errorOf(runCommand(def, 'truth', tasks, { exec: async () => { throw new Error('environment disposed') } }))
    expect(gone.code).toBe('spawn')
    expect(gone.message).toContain('environment disposed')
  })
  it('refuses an in_environment command without exec, naming the environment; host commands ignore exec', async () => {
    const refused = await errorOf(runCommand(def, 'truth', tasks))
    expect(refused.code).toBe('spawn')
    expect(refused.command).toBe('truth')
    expect(refused.message).toContain('example/judge:1')
    const { calls, exec } = fake(() => { throw new Error('must not be called') })
    const score = await runCommand(def, 'score', [{ task_id: 's1', truth: { passed: 1, total: 2 }, output: {} }], { exec })
    expect(score[0]).toMatchObject({ metric: 'pass_rate', value: 0.5 })
    expect(calls).toHaveLength(0)
  })
})
