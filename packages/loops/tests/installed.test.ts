// The installed loop against a fake Environment: what it execs (argv with the
// templates filled in, env, cwd, the deadline as the timeout, the signal),
// what it fetches back (the transcript artifact, the submit under the file
// convention on both sides), and how exit codes, the deadline and the host's
// abort become the finished status.

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Environment, EnvironmentFacts, ExecOptions, ExecResult } from '@oldbulb/samsara-environments'
import { Context } from '@oldbulb/samsara-kernel'
import { readSubmit } from '@oldbulb/samsara-submit'
import { LoopRegistry, collectEvents, factsSha, type AttemptSpec } from '../src/index.ts'
import { INSTALLED_DIR, InstalledLoopProvider, harnessFactsOf, renderCommand, treeSha } from '../src/installed.ts'
import * as pluginInstalled from '../src/plugin-installed.ts'

const FACTS: EnvironmentFacts = { provider: 'fake', version: '1', resources: { timeoutS: 60 }, network: 'none' }
/** treeSha of a missing directory: what a fake environment's absent skill dir fetches back as. */
const EMPTY_TREE = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

interface FakeEnvironment extends Environment {
  /** The "remote" tree: `get` reads from it, `put` writes into it. */
  root: string
  execs: { argv: string[]; opts: ExecOptions }[]
  puts: [string, string][]
  gets: [string, string][]
}

/** An environment whose exec is scripted: `run` decides the result, waiting on the signal when told to hang. */
function fakeEnvironment(run: (argv: string[], opts: ExecOptions) => Promise<ExecResult> | ExecResult): FakeEnvironment {
  const root = mkdtempSync(join(tmpdir(), 'samsara-installed-env-'))
  const env: FakeEnvironment = {
    id: 'att-1', provider: 'fake', workdir: '/work', root, execs: [], puts: [], gets: [],
    async exec(argv, opts) {
      env.execs.push({ argv, opts })
      return run(argv, opts)
    },
    async put(localPath, remotePath) {
      env.puts.push([localPath, remotePath])
      const to = join(root, remotePath)
      mkdirSync(dirname(to), { recursive: true })
      writeFileSync(to, readFileSync(localPath))
    },
    async get(remotePath, localPath) {
      env.gets.push([remotePath, localPath])
      const from = join(root, remotePath.startsWith('/') ? remotePath.slice(1) : remotePath)
      if (!existsSync(from)) throw new Error(`no such file: ${remotePath}`)
      mkdirSync(dirname(localPath), { recursive: true })
      // directories come back whole, as every provider's get copies recursively
      cpSync(from, localPath, { recursive: true })
    },
    facts: () => FACTS,
    async dispose() {},
  }
  return env
}

/** An exec that only ends when its signal fires, as a provider's does under the deadline or an abort. */
function hanging(code: number | null = null): (argv: string[], opts: ExecOptions) => Promise<ExecResult> {
  return (_argv, opts) => new Promise((resolve) => {
    const end = () => resolve({ code, signal: 'SIGKILL', stdout: '', stderr: '' })
    if (opts.signal?.aborted) end()
    else opts.signal?.addEventListener('abort', end, { once: true })
  })
}

function spec(environment: Environment, over: Partial<AttemptSpec> = {}): AttemptSpec & { localWorkdir: string } {
  const localWorkdir = mkdtempSync(join(tmpdir(), 'samsara-installed-local-'))
  return {
    attemptId: 'att-1',
    challengerId: 'ch-1',
    workdir: environment.workdir,
    // The sealed sha matches what the fetch of the (absent) snapshot hashes to, so the integrity check holds by default.
    skill: { name: 'skill', dir: `${environment.workdir}/.agents/skills/skill`, sha: EMPTY_TREE },
    prompt: 'p',
    route: { provider: 'none', model: 'none', credentialRef: 'none' },
    outputSchema: {},
    tools: { allow: [], deny: [], submitTool: { name: 'submit_x', schema: {} } },
    limits: { maxTurns: 1, maxDurationMs: 1234 },
    tmpdir: `${environment.workdir}/.tmp`,
    signal: new AbortController().signal,
    environment,
    localWorkdir,
    ...over,
  }
}

async function registry(provider: InstalledLoopProvider) {
  const ctx = new Context()
  await ctx.plugin(LoopRegistry)
  ctx.loops.register(provider)
  return ctx
}

describe('InstalledLoopProvider', () => {
  it('execs the command inside the environment with the templates, env, cwd and the deadline; exit 0 is COMPLETED with stdout/stderr artifacts', async () => {
    const env = fakeEnvironment(() => ({ code: 0, stdout: 'hello\n', stderr: 'warn\n' }))
    const provider = new InstalledLoopProvider({ command: ['agent', '--skill', '{skill}', '--token', '{attempt}', '--cwd={workdir}'], cwd: 'sub', env: { A: '1', B: 'cfg' } })
    const ctx = await registry(provider)
    const s = spec(env, { env: { B: 'attempt' } })
    const run = await ctx.loops.start('installed', s)
    const events = await collectEvents(run)
    expect(events.map((e) => e.t)).toEqual(['started', 'assistant', 'finished'])
    expect(events[0]).toMatchObject({ t: 'started', native: { kind: 'installed', id: 'att-1' } })
    expect(events[1]).toMatchObject({ t: 'assistant', turn: 0, textBytes: 6 })
    const fin = await run.result
    expect(fin).toMatchObject({ status: 'COMPLETED', stopReason: 'completed', usage: { inputTokens: 0, outputTokens: 0 }, cost: { source: 'unknown' }, turns: 0, toolCalls: 0 })
    expect(events.at(-1)).toEqual(fin)
    // one exec, inside the environment, with everything filled in
    expect(env.execs).toHaveLength(1)
    const { argv, opts } = env.execs[0]!
    expect(argv).toEqual(['agent', '--skill', '/work/.agents/skills/skill', '--token', '/work/.task/token.json', '--cwd=/work'])
    expect(opts.cwd).toBe('sub')
    expect(opts.env).toEqual({ A: '1', B: 'attempt' })
    expect(opts.timeoutMs).toBe(1234)
    expect(opts.signal).toBeInstanceOf(AbortSignal)
    // stdout and stderr are on the host, under the attempt's copy
    expect(fin.artifacts.map((a) => a.kind)).toEqual(['stdout', 'stderr'])
    expect(readFileSync(resolve(s.localWorkdir, INSTALLED_DIR, 'stdout'), 'utf8')).toBe('hello\n')
    expect(readFileSync(resolve(s.localWorkdir, INSTALLED_DIR, 'stderr'), 'utf8')).toBe('warn\n')
    expect(fin.artifacts[0]!.path).toBe(resolve(s.localWorkdir, INSTALLED_DIR, 'stdout'))
    expect(fin.artifacts[0]!.sha256).toMatch(/^[0-9a-f]{64}$/)
    // nothing of the agent's fetched (only the integrity after-image of the skill snapshot), nothing put, nothing disposed: the runner owns the environment
    expect(env.gets).toEqual([['/work/.agents/skills/skill', resolve(s.localWorkdir, INSTALLED_DIR, 'skill')]])
    expect(env.puts).toEqual([])
    await run.dispose()
  })

  it('fetches the transcript back as the transcript-native artifact and maps the submit onto the file convention on both sides', async () => {
    const env = fakeEnvironment(() => ({ code: 0, stdout: '', stderr: '' }))
    mkdirSync(join(env.root, 'logs'), { recursive: true })
    writeFileSync(join(env.root, 'logs', 'trajectory.json'), '{"steps":[]}')
    writeFileSync(join(env.root, 'logs', 'answer.json'), '{"answer": 42}')
    const provider = new InstalledLoopProvider({ command: ['run'], transcript: '/logs/trajectory.json', submit: '/logs/answer.json' })
    const ctx = await registry(provider)
    const s = spec(env)
    const run = await ctx.loops.start('installed', s)
    const events = await collectEvents(run)
    expect(events.map((e) => e.t)).toEqual(['started', 'assistant', 'output', 'finished'])
    expect(events[2]).toMatchObject({ t: 'output', structured: { answer: 42 }, text: '{"answer": 42}', source: 'submit-tool' })
    const fin = await run.result
    expect(fin.status).toBe('COMPLETED')
    const transcript = fin.artifacts.find((a) => a.kind === 'transcript-native')!
    expect(transcript.path).toBe(resolve(s.localWorkdir, INSTALLED_DIR, 'transcript.json'))
    expect(readFileSync(transcript.path, 'utf8')).toBe('{"steps":[]}')
    expect(transcript.sha256).toMatch(/^[0-9a-f]{64}$/)
    // the submit: on the host under <submitTool>.json (what the runner validates) and put back into the environment at the same name
    expect(readSubmit(s.localWorkdir, 'submit_x')?.value).toEqual({ answer: 42 })
    expect(env.gets).toEqual([['/logs/trajectory.json', transcript.path], ['/logs/answer.json', resolve(s.localWorkdir, 'submit_x.json')], ['/work/.agents/skills/skill', resolve(s.localWorkdir, INSTALLED_DIR, 'skill')]])
    expect(env.puts).toEqual([[resolve(s.localWorkdir, 'submit_x.json'), 'submit_x.json']])
    expect(readFileSync(join(env.root, 'submit_x.json'), 'utf8')).toBe('{"answer": 42}')
  })

  it('a transcript that is a directory (an agent whose log file name is unknowable up front) is fetched and hashed as a tree, and the submit inside it still lands', async () => {
    const env = fakeEnvironment(() => ({ code: 0, stdout: '', stderr: '' }))
    mkdirSync(join(env.root, 'logs', 'agent'), { recursive: true })
    writeFileSync(join(env.root, 'logs', 'agent', 'trajectory.json'), '{"steps":[]}')
    writeFileSync(join(env.root, 'logs', 'agent', 'answer.json'), '{"answer":7}')
    const ctx = await registry(new InstalledLoopProvider({ command: ['run'], transcript: '/logs/agent', submit: '/logs/agent/answer.json' }))
    const s = spec(env)
    const run = await ctx.loops.start('installed', s)
    const events = await collectEvents(run)
    expect(events.map((e) => e.t)).toEqual(['started', 'assistant', 'output', 'finished'])
    const fin = await run.result
    expect(fin.status).toBe('COMPLETED')
    const transcript = fin.artifacts.find((a) => a.kind === 'transcript-native')!
    expect(transcript.path).toBe(resolve(s.localWorkdir, INSTALLED_DIR, 'transcript'))
    expect(readFileSync(join(transcript.path, 'trajectory.json'), 'utf8')).toBe('{"steps":[]}')
    expect(transcript.sha256).toBe(treeSha(transcript.path))
    expect(transcript.sha256).not.toBe(EMPTY_TREE)
    expect(readSubmit(s.localWorkdir, 'submit_x')?.value).toEqual({ answer: 7 })
  })

  it('a fetch the host cannot land (the submit is a directory) is FAILED/error with the message on the stderr artifact, never a rejection', async () => {
    const env = fakeEnvironment(() => ({ code: 0, stdout: '', stderr: 'agent said\n' }))
    mkdirSync(join(env.root, 'logs', 'agent'), { recursive: true })
    writeFileSync(join(env.root, 'logs', 'agent', 'trajectory.json'), '{}')
    const ctx = await registry(new InstalledLoopProvider({ command: ['run'], submit: '/logs/agent' }))
    const s = spec(env)
    const run = await ctx.loops.start('installed', s)
    const events = await collectEvents(run)
    expect(events.map((e) => e.t)).toEqual(['started', 'assistant', 'finished'])
    const fin = await run.result
    expect(fin).toMatchObject({ status: 'FAILED', stopReason: 'error' })
    expect(fin.artifacts.map((a) => a.kind)).toEqual(['stdout', 'stderr'])
    const stderr = readFileSync(resolve(s.localWorkdir, INSTALLED_DIR, 'stderr'), 'utf8')
    expect(stderr).toContain('agent said')
    expect(stderr).toContain('loops-installed:')
  })

  it('a deadline the child answers with an exit code is still TRUNCATED/timeout: the loop owns the verdict', async () => {
    // the seam carries no timed-out flag, and a child that traps the provider's SIGTERM exits with a code inside the grace
    const env = fakeEnvironment((_argv, opts) => new Promise((res) => setTimeout(() => res({ code: 1, stdout: '', stderr: '' }), opts.timeoutMs + 20)))
    const ctx = await registry(new InstalledLoopProvider({ command: ['run'] }))
    const fin = await (await ctx.loops.start('installed', spec(env, { limits: { maxTurns: 1, maxDurationMs: 40 } }))).result
    expect(fin).toMatchObject({ status: 'TRUNCATED', stopReason: 'timeout' })
  })

  it('injects the credential as the named variable, preferring the config ref over the attempt route\'s', async () => {
    const refs: string[] = []
    const deps = { resolveCredential: async (ref: string) => { refs.push(ref); return `v-${ref}` } }
    const ok = (): ExecResult => ({ code: 0, stdout: '', stderr: '' })
    const env = fakeEnvironment(ok)
    const ctx = await registry(new InstalledLoopProvider({ command: ['run'], env: { A: 'cfg' }, credentialRef: 'CFG', credentialVar: 'AGENT_TOKEN' }, deps))
    await (await ctx.loops.start('installed', spec(env, { route: { provider: 'none', model: 'none', credentialRef: 'ROUTE' } }))).result
    expect(refs).toEqual(['CFG'])
    expect(env.execs[0]!.opts.env).toEqual({ A: 'cfg', AGENT_TOKEN: 'v-CFG' })
    // no config ref: the attempt's own route.credentialRef is resolved
    const fallback = fakeEnvironment(ok)
    const ctx2 = await registry(new InstalledLoopProvider({ command: ['run'], credentialVar: 'AGENT_TOKEN' }, deps))
    await (await ctx2.loops.start('installed', spec(fallback, { route: { provider: 'none', model: 'none', credentialRef: 'ROUTE' } }))).result
    expect(refs).toEqual(['CFG', 'ROUTE'])
    expect(fallback.execs[0]!.opts.env).toEqual({ AGENT_TOKEN: 'v-ROUTE' })
    // a ref without a variable name is refused at construction; a variable without a resolver rejects before publication
    expect(() => new InstalledLoopProvider({ command: ['run'], credentialRef: 'X' })).toThrow(/credentialVar is required/)
    const bare = await registry(new InstalledLoopProvider({ command: ['run'], credentialVar: 'AGENT_TOKEN' }))
    await expect(bare.loops.start('installed', spec(fakeEnvironment(ok)))).rejects.toThrow(/credential resolver/)
  })

  it('an installed agent that rewrites or deletes its skill snapshot finishes FAILED: the after-image is fetched from the environment and compared', async () => {
    const write = (root: string, content: string) => {
      mkdirSync(join(root, 'work', '.agents', 'skills', 'skill'), { recursive: true })
      writeFileSync(join(root, 'work', '.agents', 'skills', 'skill', 'SKILL.md'), content)
    }
    const ok = (): ExecResult => ({ code: 0, stdout: '', stderr: '' })
    const intact = fakeEnvironment(ok)
    write(intact.root, 'sealed')
    const sha = treeSha(join(intact.root, 'work', '.agents', 'skills', 'skill'))
    const skill = { name: 'skill', dir: '/work/.agents/skills/skill', sha }
    const ctx = await registry(new InstalledLoopProvider({ command: ['run'] }))
    const sIntact = spec(intact, { skill })
    expect((await (await ctx.loops.start('installed', sIntact)).result).status).toBe('COMPLETED')
    expect(intact.gets).toEqual([['/work/.agents/skills/skill', resolve(sIntact.localWorkdir, INSTALLED_DIR, 'skill')]])
    // rewritten during the run: the fetched tree no longer hashes to the sealed sha
    const rewriting = fakeEnvironment(() => { write(rewriting.root, 'rewritten'); return ok() })
    write(rewriting.root, 'sealed')
    expect(await (await ctx.loops.start('installed', spec(rewriting, { skill }))).result).toMatchObject({ status: 'FAILED', stopReason: 'error' })
    // deleted during the run: the fetch fails and the empty tree is not the sealed sha
    const deleting = fakeEnvironment(() => { rmSync(join(deleting.root, 'work'), { recursive: true, force: true }); return ok() })
    write(deleting.root, 'sealed')
    expect(await (await ctx.loops.start('installed', spec(deleting, { skill }))).result).toMatchObject({ status: 'FAILED', stopReason: 'error' })
    // nowhere to land the after-image: the check is not claimed, not vacuously passed
    const { localWorkdir: _none, ...unclaimed } = spec(fakeEnvironment(ok), { skill })
    expect((await (await ctx.loops.start('installed', unclaimed)).result).status).toBe('COMPLETED')
  })

  it('an agent that left no transcript or submit is not an error: no artifact, no output, the exit code decides', async () => {
    const env = fakeEnvironment(() => ({ code: 0, stdout: '', stderr: '' }))
    const ctx = await registry(new InstalledLoopProvider({ command: ['run'], transcript: '/logs/none.txt', submit: '/logs/none.json' }))
    const s = spec(env)
    const run = await ctx.loops.start('installed', s)
    expect((await collectEvents(run)).map((e) => e.t)).toEqual(['started', 'assistant', 'finished'])
    const fin = await run.result
    expect(fin.status).toBe('COMPLETED')
    expect(fin.artifacts.map((a) => a.kind)).toEqual(['stdout', 'stderr'])
    expect(readSubmit(s.localWorkdir, 'submit_x')).toBeUndefined()
    expect(env.puts).toEqual([])
  })

  it('does not put the submit back when the environment is the host copy (the local provider), and brings nothing back without a localWorkdir', async () => {
    const env = fakeEnvironment(() => ({ code: 0, stdout: 'x', stderr: '' }))
    writeFileSync(join(env.root, 'answer.json'), '{"a":1}')
    const ctx = await registry(new InstalledLoopProvider({ command: ['run'], submit: 'answer.json' }))
    const local = spec(env)
    const inPlace = await ctx.loops.start('installed', { ...local, workdir: local.localWorkdir })
    expect((await inPlace.result).status).toBe('COMPLETED')
    expect(readSubmit(local.localWorkdir, 'submit_x')?.value).toEqual({ a: 1 })
    expect(env.puts).toEqual([])
    const { localWorkdir: _none, ...bare } = spec(env)
    const run = await ctx.loops.start('installed', bare)
    const fin = await run.result
    expect(fin.status).toBe('COMPLETED')
    expect(fin.artifacts).toEqual([])
    expect(env.gets).toHaveLength(1)
  })

  it('a non-zero exit is FAILED/error, a null code is the deadline (TRUNCATED/timeout), the host abort is ABORTED', async () => {
    const failing = fakeEnvironment(() => ({ code: 2, stdout: '', stderr: 'boom' }))
    const ctx = await registry(new InstalledLoopProvider({ command: ['run'] }))
    const failed = await (await ctx.loops.start('installed', spec(failing))).result
    expect(failed).toMatchObject({ status: 'FAILED', stopReason: 'error' })
    expect(failed.artifacts.map((a) => a.kind)).toEqual(['stdout', 'stderr'])

    // the provider ended the exec on its timeout: the run's deadline
    const timedOut = fakeEnvironment(() => ({ code: null, signal: 'SIGKILL', stdout: 'partial', stderr: '' }))
    const truncated = await (await ctx.loops.start('installed', spec(timedOut))).result
    expect(truncated).toMatchObject({ status: 'TRUNCATED', stopReason: 'timeout' })

    // the host's signal reaches the exec, and the run is ABORTED
    const hangs = fakeEnvironment(hanging())
    const controller = new AbortController()
    const run = await ctx.loops.start('installed', spec(hangs, { signal: controller.signal }))
    const events = collectEvents(run)
    controller.abort('host')
    expect(await run.result).toMatchObject({ status: 'ABORTED', stopReason: 'aborted' })
    expect((await events).map((e) => e.t)).toEqual(['started', 'assistant', 'finished'])
    expect(hangs.execs[0]!.opts.signal?.aborted).toBe(true)

    // cancel() does the same through the run, without the host's signal
    const cancelled = fakeEnvironment(hanging())
    const run2 = await ctx.loops.start('installed', spec(cancelled))
    run2.cancel('enough')
    expect(await run2.result).toMatchObject({ status: 'ABORTED', stopReason: 'aborted' })

    // an exec the environment refuses (disposed, unreachable) is FAILED/error before any artifact
    const broken = fakeEnvironment(() => { throw new Error('gone') })
    const fin = await (await ctx.loops.start('installed', spec(broken))).result
    expect(fin).toMatchObject({ status: 'FAILED', stopReason: 'error', artifacts: [] })
  })

  it('refuses to start without an environment or once aborted, and an empty command at construction', async () => {
    const env = fakeEnvironment(() => ({ code: 0, stdout: '', stderr: '' }))
    const ctx = await registry(new InstalledLoopProvider({ command: ['run'] }))
    const { environment: _e, ...noEnvironment } = spec(env)
    await expect(ctx.loops.start('installed', noEnvironment)).rejects.toThrow(/no environment/)
    const aborted = new AbortController()
    aborted.abort()
    await expect(ctx.loops.start('installed', spec(env, { signal: aborted.signal }))).rejects.toThrow(/aborted before start/)
    expect(env.execs).toEqual([])
    expect(() => new InstalledLoopProvider({ command: [] })).toThrow(/command must not be empty/)
  })

  it('harness facts: the version is the sha of the whole config (never the credential value), the sandbox is the environment; capabilities say installed', () => {
    const p = new InstalledLoopProvider({ command: ['bash', '/solution/solve.sh'] })
    expect(p.name).toBe('installed')
    expect(p.capabilities).toMatchObject({ installed: true, perAttemptEnv: true, nativeSchema: 'none' })
    expect(p.harnessFacts.sandbox).toBe('environment')
    expect(p.harnessFacts.version.loop).toMatch(/^installed@[0-9a-f]{64}$/)
    expect(p.harnessFacts).toEqual(harnessFactsOf({ command: ['bash', '/solution/solve.sh'] }))
    expect(factsSha(p.harnessFacts)).not.toBe(factsSha(harnessFactsOf({ command: ['bash', '/solution/other.sh'] })))
    // two deployments differing only in config are two designs: every non-secret key moves the sha
    const base = factsSha(harnessFactsOf({ command: ['run'] }))
    for (const over of [{ cwd: 'sub' }, { transcript: '/logs/agent' }, { submit: '/logs/answer.json' }, { env: { A: '1' } }, { credentialVar: 'AGENT_TOKEN' }]) {
      expect(factsSha(harnessFactsOf({ command: ['run'], ...over }))).not.toBe(base)
    }
    expect(renderCommand(['{workdir}/{skill}', 'plain'], { workdir: '/w', skill: { name: 's', dir: '/w/.agents/skills/s', sha: '' } })).toEqual(['/w//w/.agents/skills/s', 'plain'])
  })

  it('the loops-installed plugin registers for its scope with its config and resolves the credential through ctx.credentials', async () => {
    const ctx = new Context()
    await ctx.plugin(LoopRegistry)
    ctx.provide('credentials', { resolve: async (ref: string) => (ref === 'TOK' ? { value: 'sk-resolved' } : undefined) } as never)
    const fiber = await ctx.plugin(pluginInstalled, { command: ['bash', '/solution/solve.sh'], submit: '/logs/answer.json', credentialRef: 'TOK', credentialVar: 'AGENT_TOKEN' })
    const p = ctx.loops.get('installed')!
    expect(p.capabilities.installed).toBe(true)
    expect(p.harnessFacts.version.loop).toMatch(/^installed@[0-9a-f]{64}$/)
    const env = fakeEnvironment(() => ({ code: 0, stdout: '', stderr: '' }))
    await (await ctx.loops.start('installed', spec(env))).result
    // E5: the credential reaches the agent only as the one named variable, never argv or the config file
    expect(env.execs[0]!.opts.env).toMatchObject({ AGENT_TOKEN: 'sk-resolved' })
    await fiber.dispose()
    expect(ctx.loops.get('installed')).toBeUndefined()
    // an unconfigured credential rejects the attempt before publication
    await ctx.plugin(pluginInstalled, { command: ['run'], credentialRef: 'NOPE', credentialVar: 'AGENT_TOKEN' })
    await expect(ctx.loops.start('installed', spec(fakeEnvironment(() => ({ code: 0, stdout: '', stderr: '' }))))).rejects.toThrow(/not configured/)
  })
})
