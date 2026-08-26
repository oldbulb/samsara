// CommandAdapter against a real fixture process (node) under the
// `--view/--out` contract: success, non-zero exit, malformed proposal, timeout,
// abort; and the Python example through the same adapter when python3 is on
// PATH. Offline; the fixtures never touch the network.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { policyFor, type SandboxHost } from '@oldbulb/samsara-sandbox'
import { CommandAdapter, commandArgvOf, resolveCommandConfig } from '../src/command.ts'
import { validateProposal } from '../src/types.ts'
import { fakeHandle, tempRoot, writeSkill } from './fixture.ts'
import { realSpawn } from './fixtures/real-spawn.ts'

const FIXTURE = fileURLToPath(new URL('./fixtures/noop-proposer.mjs', import.meta.url))
const NOOP_PY = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../examples/proposers/noop.py')
const UNENFORCED: SandboxHost = { platform: 'darwin', enforcement: 'unusable', launcher: '', exists: () => true }

function python3(): string | undefined {
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' })
    return 'python3'
  } catch {
    return undefined
  }
}

/** A view directory with the files the host renders (champion.json + skill + jsonl rows). */
function writeView(root: string): string {
  const viewDir = join(root, 'view')
  writeSkill(join(viewDir, 'champion-skill'))
  writeFileSync(join(viewDir, 'champion.json'), JSON.stringify({ challenger_id: 'ch-champion', skill: 'champion-skill/', metric: 'pass' }))
  writeFileSync(join(viewDir, 'view.json'), JSON.stringify({ view_version: 1, champion_id: 'ch-champion', metric: 'pass', files: ['champion.json', 'champion-skill', 'tasks.jsonl'] }))
  writeFileSync(join(viewDir, 'tasks.jsonl'), '{"task_id":"t1","entity_key":"e1","stratum":"a"}\n{"task_id":"t2","entity_key":"e2","stratum":"a"}\n')
  writeFileSync(join(viewDir, 'champion-attempts.jsonl'), '')
  writeFileSync(join(viewDir, 'champion-scores.jsonl'), '{"attempt_id":"a1","task_id":"t2","metric":"pass","value":0}\n')
  writeFileSync(join(viewDir, 'compares.jsonl'), '')
  return viewDir
}

function setup(mode: string, config: Partial<ConstructorParameters<typeof CommandAdapter>[0]> = {}) {
  const root = tempRoot()
  const viewDir = writeView(root)
  const workDir = join(root, 'work')
  mkdirSync(workDir)
  const adapter = new CommandAdapter({ name: 'noop', command: process.execPath, args: [FIXTURE, '--mode', mode], ...config }, { spawn: realSpawn, host: UNENFORCED })
  return { root, viewDir, workDir, adapter, input: (signal = new AbortController().signal) => ({ viewDir, workDir, signal, parent: 'ch-champion' }) }
}

describe('CommandAdapter', () => {
  it('runs the command with --view/--out, resolves skill_dir against the out dir and returns the validated Proposal', async () => {
    const t = setup('ok')
    const p = await t.adapter.propose(t.input())
    expect(p).toEqual({
      parent: 'ch-champion',
      surface: 'skill',
      patch: { surface: 'skill', skill_dir: join(t.workDir, 'skill') },
      intent: 'no-op conformance proposal',
      prediction: { metric: 'pass', direction: 'up', predicted_fixes: [], at_risk: [] },
      proposer: { name: 'noop', version: 'unknown', config_sha: t.adapter.configSha },
    })
    expect(readFileSync(join(t.workDir, 'skill', 'SKILL.md'), 'utf8')).toBe(readFileSync(join(t.viewDir, 'champion-skill', 'SKILL.md'), 'utf8'))
    expect(readFileSync(join(t.workDir, 'proposer.stdout.txt'), 'utf8')).toBe('done\n')
    expect(readFileSync(join(t.workDir, 'proposer.stderr.txt'), 'utf8')).toContain('mode=ok')
  })

  it('passes a rows proposal through untouched', async () => {
    const t = setup('rows')
    const p = await t.adapter.propose(t.input())
    expect(p.surface).toBe('prompt')
    expect(p.patch).toEqual({ surface: 'prompt', rows: [{ id: 'r1', config: {} }] })
  })

  it('gives the child an explicit env: HOME/TMPDIR at the out dir, no credential-shaped parent variable, the configured credential only', async () => {
    process.env['SOME_API_KEY'] = 'leak'
    try {
      const t = setup('env')
      const adapter = new CommandAdapter(
        { name: 'noop', command: process.execPath, args: [FIXTURE, '--mode', 'env'] },
        { spawn: realSpawn, host: UNENFORCED, credentialEnv: async () => ({ PROPOSER_TOKEN: 'sk-resolved' }) },
      )
      await adapter.propose(t.input())
      const env = JSON.parse(readFileSync(join(t.workDir, 'env.json'), 'utf8')) as Record<string, string>
      expect(env['HOME']).toBe(t.workDir)
      expect(env['TMPDIR']).toBe(t.workDir)
      expect(env['SOME_API_KEY']).toBeUndefined()
      expect(env['PROPOSER_TOKEN']).toBe('sk-resolved')
    } finally {
      delete process.env['SOME_API_KEY']
    }
  })

  it('rejects a non-zero exit and a malformed proposal.json, keeping the logs', async () => {
    const fail = setup('fail')
    await expect(fail.adapter.propose(fail.input())).rejects.toThrow(/exited with code 3/)
    expect(existsSync(join(fail.workDir, 'proposer.stderr.txt'))).toBe(true)
    const bad = setup('malformed')
    await expect(bad.adapter.propose(bad.input())).rejects.toThrow(/invalid proposal draft/)
  })

  it('terminates the child on timeout and on abort', async () => {
    const slow = setup('hang', { timeoutMs: 300, graceMs: 200 })
    await expect(slow.adapter.propose(slow.input())).rejects.toThrow(/timeoutMs=300/)

    const a = setup('hang', { graceMs: 200 })
    const controller = new AbortController()
    const pending = a.adapter.propose(a.input(controller.signal))
    await new Promise((r) => setTimeout(r, 200))
    controller.abort()
    await expect(pending).rejects.toThrow(/aborted/)
  })

  it('rejects a skill_dir that escapes the out dir or lacks SKILL.md, and a draft without parent when the input has none', async () => {
    const spawnWriting = (body: unknown, skill = true) => (spec: Parameters<typeof realSpawn>[0]) => {
      if (skill) writeSkill(join(spec.cwd, 'skill'))
      writeFileSync(join(spec.cwd, 'proposal.json'), JSON.stringify(body))
      const h = fakeHandle()
      h.settle({ exitCode: 0, signal: null })
      return h
    }
    const draft = { surface: 'skill', patch: { surface: 'skill', skill_dir: 'skill' }, intent: 'i', prediction: { metric: 'pass', direction: 'up' } }
    const viewDir = writeView(tempRoot())
    const input = () => ({ viewDir, workDir: join(tempRoot(), 'work'), signal: new AbortController().signal })
    const make = (body: unknown, skill = true) => new CommandAdapter({ name: 'n', command: 'x' }, { spawn: spawnWriting(body, skill), host: UNENFORCED })
    await expect(make({ ...draft, patch: { surface: 'skill', skill_dir: '../elsewhere' } }).propose({ ...input(), parent: 'p' })).rejects.toThrow(/escapes/)
    await expect(make(draft, false).propose({ ...input(), parent: 'p' })).rejects.toThrow(/SKILL.md/)
    await expect(make(draft).propose(input())).rejects.toThrow(/parent is required/)
    expect((await make({ ...draft, parent: 'draft-parent' }).propose(input())).parent).toBe('draft-parent')
  })

  it('config_sha hashes command, args and env; pure helpers', () => {
    const deps = { spawn: () => { throw new Error('no') }, host: UNENFORCED }
    const a = new CommandAdapter({ name: 'a', command: 'c', args: ['x'], timeoutMs: 1 }, deps)
    const b = new CommandAdapter({ name: 'b', command: 'c', args: ['x'], timeoutMs: 2, version: '9' }, deps)
    const c = new CommandAdapter({ name: 'a', command: 'c', args: ['y'] }, deps)
    const d = new CommandAdapter({ name: 'a', command: 'c', args: ['x'], env: { MODEL: 'm' } }, deps)
    expect(a.configSha).toBe(b.configSha)
    expect(a.configSha).not.toBe(c.configSha)
    expect(a.configSha).not.toBe(d.configSha)
    expect(a.configSha).toMatch(/^[0-9a-f]{64}$/)
    expect(b.version).toBe('9')
    expect(resolveCommandConfig({ name: 'n', command: 'c' })).toEqual({ name: 'n', command: 'c', args: [], version: 'unknown', timeoutMs: 600_000, graceMs: 3000, env: {} })
    expect(() => resolveCommandConfig({ name: '', command: 'c' })).toThrow(/name/)
    expect(() => resolveCommandConfig({ name: 'n', command: 'c', timeoutMs: 0 })).toThrow(/timeoutMs/)
    expect(commandArgvOf({ command: 'c', args: ['-v'] }, '/v', '/o')).toEqual(['c', '-v', '--view', '/v', '--out', '/o'])
  })
})

describe('examples/proposers/noop.py through CommandAdapter', () => {
  const py = python3()
  it.skipIf(py === undefined)('returns the champion skill unchanged as a valid Proposal', async () => {
    const root = tempRoot()
    const viewDir = writeView(root)
    const workDir = join(root, 'work')
    mkdirSync(workDir)
    const adapter = new CommandAdapter({ name: 'noop-py', command: py!, args: [NOOP_PY] }, { spawn: realSpawn, host: UNENFORCED })
    const p = await adapter.propose({ viewDir, workDir, signal: new AbortController().signal, parent: 'ch-champion' })
    expect(validateProposal(p)).toEqual(p)
    expect(p.intent).toBe('no-op conformance proposal')
    expect(p.patch).toEqual({ surface: 'skill', skill_dir: join(workDir, 'skill') })
    expect(p.prediction).toMatchObject({ metric: 'pass', direction: 'up' })
    expect(readFileSync(join(workDir, 'skill', 'SKILL.md'), 'utf8')).toBe(readFileSync(join(viewDir, 'champion-skill', 'SKILL.md'), 'utf8'))
  })
})

describe('plugin-command', () => {
  it('wires spawn through ctx.subprocess inside an effect, resolves the credential into credentialVar only, and registers under name', async () => {
    const { createAdapter } = await import('../src/plugin-command.ts')
    const effects: string[] = []
    const specs: Parameters<typeof realSpawn>[0][] = []
    // A fake spawn that behaves like the fixture's `env` mode, so the spec (and
    // its landlock wrapping on a Linux runner) is inspected without a process.
    const spawn = (spec: Parameters<typeof realSpawn>[0]) => {
      specs.push(spec)
      writeFileSync(join(spec.cwd, 'env.json'), JSON.stringify(spec.env))
      writeSkill(join(spec.cwd, 'skill'))
      writeFileSync(join(spec.cwd, 'proposal.json'), JSON.stringify({ surface: 'skill', patch: { surface: 'skill', skill_dir: 'skill' }, intent: 'i', prediction: { metric: 'pass', direction: 'up' } }))
      const h = fakeHandle('done\n')
      h.settle({ exitCode: 0, signal: null })
      return h
    }
    const ctx = {
      effect: (fn: () => unknown, label: string) => { effects.push(label); const d = fn(); return () => (typeof d === 'function' ? d() : undefined) },
      subprocess: { spawn },
      credentials: { resolve: async (ref: string) => (ref === 'TOK' ? { value: 'sk-resolved' } : undefined) },
      proposers: undefined,
    } as never
    const adapter = createAdapter(ctx, { name: 'noop', command: process.execPath, args: [FIXTURE, '--mode', 'env'], credentialRef: 'TOK', credentialVar: 'PROPOSER_TOKEN' })
    expect(adapter.name).toBe('noop')
    const root = tempRoot()
    const viewDir = writeView(root)
    const workDir = join(root, 'work')
    mkdirSync(workDir)
    // createAdapter takes the real host, so the input carries a policy (E9): an
    // unconfined proposal spawn is refused on a Linux runner, as in production.
    const sandbox = policyFor({ workdir: workDir, packDir: join(root, 'pack'), readOnly: [viewDir] })
    const p = await adapter.propose({ viewDir, workDir, signal: new AbortController().signal, parent: 'p', sandbox })
    expect(p.proposer).toEqual({ name: 'noop', version: 'unknown', config_sha: adapter.configSha })
    expect(effects).toEqual(['proposer-command:child'])
    expect(specs[0]!.env?.['PROPOSER_TOKEN']).toBe('sk-resolved')
    expect(specs[0]!.argv.slice(-4)).toEqual(['--view', viewDir, '--out', workDir])
    expect(JSON.parse(readFileSync(join(workDir, 'env.json'), 'utf8'))['PROPOSER_TOKEN']).toBe('sk-resolved')
    expect(JSON.stringify(p)).not.toContain('sk-resolved')

    const missing = createAdapter(ctx, { name: 'x', command: 'c', credentialRef: 'NOPE', credentialVar: 'V' })
    await expect(missing.propose({ viewDir, workDir, signal: new AbortController().signal, parent: 'p', sandbox })).rejects.toThrow(/NOPE is not configured/)
    const noVar = createAdapter(ctx, { name: 'y', command: 'c', credentialRef: 'TOK' })
    await expect(noVar.propose({ viewDir, workDir, signal: new AbortController().signal, parent: 'p', sandbox })).rejects.toThrow(/credentialVar/)
  })
})
