// The adapter with a fake spawn: the "CLI" is a function that writes proposal.json
// and skill/ into the work directory. No process is started, no network touched.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SubprocessSpawnSpec } from '@samsara/kernel'
import { policyFor, type SandboxHost } from '@samsara/sandbox'
import { ClaudePAdapter, DEFAULT_TEMPLATE, argvOf, buildEnv, renderPrompt, resolveConfig } from '../src/claude-p.ts'
import { fakeHandle, fakeSpawn, tempRoot, writeSkill, type FakeHandle } from './fixture.ts'

const SECRET = 'sk-secret-never-logged-0123456789'
// Tests that are not about the sandbox pin a host that cannot enforce, so they
// assert the same thing on a Linux runner (where `detectHost` finds landlock and
// `apply` fails closed without a policy) as on a developer machine.
const UNENFORCED: SandboxHost = { platform: 'darwin', enforcement: 'unusable', launcher: '', exists: () => true }
const draft = {
  surface: 'skill',
  patch: { surface: 'skill', skill_dir: './skill' },
  intent: 'Add a verification step before submitting.',
  prediction: { metric: 'pass', direction: 'up', predicted_fixes: ['t3'], at_risk: ['t1'] },
}

function writeGoodOutput(spec: SubprocessSpawnSpec, handle: FakeHandle, body: unknown = draft): void {
  writeSkill(join(spec.cwd, 'skill'))
  writeFileSync(join(spec.cwd, 'proposal.json'), JSON.stringify(body))
  handle.settle({ exitCode: 0, signal: null })
}

function setup(onRun = writeGoodOutput, config: ConstructorParameters<typeof ClaudePAdapter>[0] = {}) {
  const root = tempRoot()
  const viewDir = join(root, 'view')
  const workDir = join(root, 'work')
  mkdirSync(viewDir)
  mkdirSync(workDir)
  const { spawn, records } = fakeSpawn(onRun)
  const adapter = new ClaudePAdapter(
    { model: 'model-x', baseUrl: 'http://gateway.local/v1', credentialRef: 'ROUTE_TOKEN', ...config },
    { spawn, credentialEnv: async () => ({ ANTHROPIC_AUTH_TOKEN: SECRET }), host: UNENFORCED },
  )
  return { root, viewDir, workDir, records, adapter, input: (signal = new AbortController().signal) => ({ viewDir, workDir, signal, parent: 'ch-parent' }) }
}

describe('ClaudePAdapter sandbox', () => {
  const linux: SandboxHost = { platform: 'linux', enforcement: 'full', launcher: '/opt/landlock-run', exists: () => true }

  it('runs the proposal under the launcher with the given policy on an enforcing host; the version probe stays plain', async () => {
    const root = tempRoot()
    const viewDir = join(root, 'view')
    const workDir = join(root, 'work')
    mkdirSync(viewDir)
    mkdirSync(workDir)
    const { spawn, records } = fakeSpawn(writeGoodOutput)
    const adapter = new ClaudePAdapter({ model: 'model-x' }, { spawn, credentialEnv: async () => ({}), host: linux })
    const sandbox = policyFor({ workdir: workDir, packDir: join(root, 'pack'), readOnly: [viewDir] })
    await adapter.propose({ viewDir, workDir, signal: new AbortController().signal, parent: 'p', sandbox })
    expect(records[0]!.spec.argv).toEqual(['claude', '--version'])
    const argv = records[1]!.spec.argv
    expect(argv[0]).toBe('/opt/landlock-run')
    expect(argv.slice(argv.indexOf('--') + 1, argv.indexOf('--') + 3)).toEqual(['claude', '-p'])
    expect(argv).toContain(viewDir)
    expect(argv[argv.indexOf('--rw') + 1]).toBe(workDir)
    expect(records[1]!.spec.cwd).toBe(workDir)
  })

  it('fails closed on an enforcing host when the input carries no policy', async () => {
    const t = setup()
    const adapter = new ClaudePAdapter({ model: 'model-x' }, { spawn: fakeSpawn(writeGoodOutput).spawn, credentialEnv: async () => ({}), host: linux })
    await expect(adapter.propose(t.input())).rejects.toThrow(/no sandbox policy/)
  })
})

describe('ClaudePAdapter', () => {
  it('spawns the CLI with the documented argv, cwd and explicit env; returns the validated Proposal', async () => {
    const { workDir, viewDir, records, adapter, input } = setup()
    const p = await adapter.propose(input())

    expect(records).toHaveLength(2)
    expect(records[0]!.spec.argv).toEqual(['claude', '--version'])
    const run = records[1]!.spec
    expect(run.argv.slice(0, 1)).toEqual(['claude'])
    expect(run.argv[1]).toBe('-p')
    expect(run.argv.slice(3)).toEqual(['--output-format', 'json', '--max-turns', '25', '--permission-mode', 'bypassPermissions'])
    const prompt = run.argv[2]!
    expect(prompt).toContain(viewDir)
    expect(prompt).toContain(join(workDir, 'proposal.json'))
    expect(prompt).toContain('"surface"')
    expect(prompt).not.toContain('{{')
    expect(run.cwd).toBe(workDir)
    expect(run.stdio).toEqual({ stdin: 'ignore', stdout: { maxBytes: expect.any(Number) }, stderr: { maxBytes: expect.any(Number) } })
    expect(run.env).toMatchObject({
      ANTHROPIC_AUTH_TOKEN: SECRET,
      ANTHROPIC_BASE_URL: 'http://gateway.local/v1',
      ANTHROPIC_MODEL: 'model-x',
      ANTHROPIC_SMALL_FAST_MODEL: 'model-x',
      CLAUDE_CONFIG_DIR: join(workDir, '.claude-config'),
      HOME: workDir,
      DISABLE_TELEMETRY: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    })
    expect(existsSync(join(workDir, '.claude-config'))).toBe(true)

    expect(p).toEqual({
      parent: 'ch-parent',
      surface: 'skill',
      patch: { surface: 'skill', skill_dir: join(workDir, 'skill') },
      intent: draft.intent,
      prediction: draft.prediction,
      proposer: { name: 'claude-p', version: '2.1.240', config_sha: adapter.configSha },
    })
    expect(adapter.version).toBe('2.1.240')
    expect(readFileSync(join(workDir, 'claude-p.stdout.json'), 'utf8')).toBe('{"type":"result"}')
  })

  it('inherits no credential-shaped variable from the parent process', async () => {
    process.env['SOME_API_KEY'] = 'leak'
    process.env['OTHER_SECRET'] = 'leak'
    try {
      const { records, adapter, input } = setup()
      await adapter.propose(input())
      const env = records[1]!.spec.env ?? {}
      expect(Object.keys(env).filter((k) => /_KEY$|SECRET|TOKEN/i.test(k))).toEqual(['ANTHROPIC_AUTH_TOKEN'])
      expect(JSON.stringify(records[1]!.spec.argv)).not.toContain(SECRET)
    } finally {
      delete process.env['SOME_API_KEY']
      delete process.env['OTHER_SECRET']
    }
  })

  it('terminates the child on timeout and on abort', async () => {
    const hang = () => {}
    const t = setup(hang, { timeoutMs: 20 })
    await expect(t.adapter.propose(t.input())).rejects.toThrow(/timeoutMs=20/)
    expect(t.records[1]!.handle.terminated).toBe(1)

    const a = setup(hang)
    const controller = new AbortController()
    const pending = a.adapter.propose(a.input(controller.signal))
    await new Promise((r) => setTimeout(r, 5))
    controller.abort()
    await expect(pending).rejects.toThrow(/aborted/)
    expect(a.records[1]!.handle.terminated).toBe(1)
  })

  it('rejects a non-zero exit, a missing or invalid proposal.json, a non-skill surface and an escaping skill_dir', async () => {
    await expect(setup((_s, h) => h.settle({ exitCode: 2, signal: null })).adapter.propose(setup().input())).rejects.toThrow(/exited with code 2/)
    const noFile = setup((_s, h) => h.settle({ exitCode: 0, signal: null }))
    await expect(noFile.adapter.propose(noFile.input())).rejects.toThrow(/did not write proposal.json/)
    const bad = setup((s, h) => writeGoodOutput(s, h, { ...draft, prediction: {} }))
    await expect(bad.adapter.propose(bad.input())).rejects.toThrow(/invalid proposal draft/)
    const rows = setup((s, h) => writeGoodOutput(s, h, { ...draft, surface: 'prompt', patch: { surface: 'prompt', rows: [{}] } }))
    await expect(rows.adapter.propose(rows.input())).rejects.toThrow(/only the skill surface/)
    const escape = setup((s, h) => writeGoodOutput(s, h, { ...draft, patch: { surface: 'skill', skill_dir: '../elsewhere' } }))
    await expect(escape.adapter.propose(escape.input())).rejects.toThrow(/escapes/)
    const noSkill = setup((s, h) => {
      writeFileSync(join(s.cwd, 'proposal.json'), JSON.stringify(draft))
      h.settle({ exitCode: 0, signal: null })
    })
    await expect(noSkill.adapter.propose(noSkill.input())).rejects.toThrow(/SKILL.md/)
  })

  it('uses the draft parent when the input has none, and honours command/args/maxTurns', async () => {
    const t = setup((s, h) => writeGoodOutput(s, h, { ...draft, parent: 'draft-parent' }), { command: '/opt/bin/claude', args: ['--verbose'], maxTurns: 3 })
    const { parent: _p, ...input } = t.input()
    const p = await t.adapter.propose(input)
    expect(p.parent).toBe('draft-parent')
    expect(t.records[1]!.spec.argv.slice(0, 3)).toEqual(['/opt/bin/claude', '--verbose', '-p'])
    expect(t.records[1]!.spec.argv).toContain('3')
  })

  it('config_sha is stable, ignores credentialRef, and changes with the template or any strategy field', () => {
    const deps = { spawn: () => { throw new Error('no') }, credentialEnv: async () => ({}), host: UNENFORCED }
    const a = new ClaudePAdapter({ model: 'm', maxTurns: 10, credentialRef: 'A' }, deps)
    const b = new ClaudePAdapter({ maxTurns: 10, model: 'm', credentialRef: 'B' }, deps)
    const c = new ClaudePAdapter({ model: 'm', maxTurns: 11 }, deps)
    expect(a.configSha).toBe(b.configSha)
    expect(a.configSha).not.toBe(c.configSha)
    expect(a.configSha).toMatch(/^[0-9a-f]{64}$/)

    const root = tempRoot()
    const tpl = join(root, 'other.md')
    writeFileSync(tpl, readFileSync(DEFAULT_TEMPLATE, 'utf8') + '\nExtra instruction.\n')
    const d = new ClaudePAdapter({ model: 'm', maxTurns: 10, promptTemplate: tpl }, deps)
    expect(d.configSha).not.toBe(a.configSha)
    expect(d.templateSha).not.toBe(a.templateSha)
  })

  it('version falls back to unknown when the probe fails', async () => {
    const root = tempRoot()
    const workDir = join(root, 'work')
    mkdirSync(workDir)
    const spawn = (spec: SubprocessSpawnSpec) => {
      const h = fakeHandle('garbage')
      if (spec.argv[1] === '--version') h.settle({ exitCode: 1, signal: null })
      else writeGoodOutput(spec, h)
      return h
    }
    const adapter = new ClaudePAdapter({}, { spawn, credentialEnv: async () => ({}), host: UNENFORCED })
    const p = await adapter.propose({ viewDir: root, workDir, signal: new AbortController().signal, parent: 'p' })
    expect(p.proposer.version).toBe('unknown')
    expect('ANTHROPIC_AUTH_TOKEN' in (p as unknown as Record<string, unknown>)).toBe(false)
  })

  it('pure helpers: resolveConfig defaults, buildEnv without model/baseUrl, renderPrompt, argvOf', () => {
    expect(resolveConfig({})).toMatchObject({ command: 'claude', args: [], maxTurns: 25, timeoutMs: 600_000, graceMs: 3000, promptTemplate: DEFAULT_TEMPLATE })
    expect(() => resolveConfig({ timeoutMs: 0 })).toThrow(/timeoutMs/)
    const env = buildEnv({}, '/w')
    expect('ANTHROPIC_BASE_URL' in env).toBe(false)
    expect('ANTHROPIC_MODEL' in env).toBe(false)
    expect(env['HOME']).toBe('/w')
    expect(renderPrompt('a {{viewDir}} b {{workDir}} {{nope}}', { viewDir: 'V', workDir: 'W' })).toBe('a V b W {{nope}}')
    expect(argvOf({ command: 'c', args: [], maxTurns: 2 }, 'P')).toEqual(['c', '-p', 'P', '--output-format', 'json', '--max-turns', '2', '--permission-mode', 'bypassPermissions'])
  })
})
