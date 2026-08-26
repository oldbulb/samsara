import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@oldbulb/samsara-kernel'
import { readSubmit } from '@oldbulb/samsara-submit'
import {
  LoopRegistry,
  LoopRegistryError,
  NullLoopProvider,
  collectEvents,
  factsSha,
  type AttemptSpec,
  type LoopProvider,
  type LoopRun,
  type LoopEvent,
} from '../src/index.ts'
import * as pluginNull from '../src/plugin-null.ts'
import { InstalledLoopProvider } from '../src/installed.ts'
import { capabilities as claudeCodeCapabilities } from '../../loops-claude-code/src/index.ts'
import { DshLoopProvider } from '../../loops-dsh/src/index.ts'

function spec(attemptId = 'att-1'): AttemptSpec {
  return {
    attemptId,
    challengerId: 'ch-1',
    workdir: '/nonexistent/workdir',
    skill: { name: 'skill', dir: '/nonexistent/skill', sha: 'a'.repeat(64) },
    prompt: 'p',
    route: { provider: 'none', model: 'none', credentialRef: 'none' },
    outputSchema: {},
    tools: { allow: [], deny: [], submitTool: { name: 'submit', schema: {} } },
    limits: { maxTurns: 1, maxDurationMs: 1000 },
    tmpdir: '/nonexistent/tmp',
    signal: new AbortController().signal,
  }
}

async function registry() {
  const ctx = new Context()
  await ctx.plugin(LoopRegistry)
  return ctx
}

function fakeProvider(name: string, events: () => AsyncIterable<LoopEvent>): LoopProvider {
  return {
    name,
    harnessFacts: { systemPromptMode: 'none', skillDelivery: 'prompt-inline', schemaEnforcement: 'permissive-tool', permission: 'none', reasoning: {}, envelope: { config: 'absent', system: 'absent', tools: 'absent' }, version: { loop: 'fake' } },
    capabilities: { perAttemptBaseUrl: false, perAttemptEnv: false, nativeSchema: 'none', toolFilter: false, nativeMaxTurns: false, installed: false },
    async start(s): Promise<LoopRun> {
      let rejectResult!: (e: unknown) => void
      const result = new Promise<never>((_, reject) => { rejectResult = reject })
      const it = events()
      return {
        id: s.attemptId,
        events: (async function* () {
          try { yield* it } catch (e) { rejectResult(e); throw e }
        })(),
        result,
        cancel() {},
        async dispose() {},
      }
    },
  }
}

describe('LoopRegistry', () => {
  it('registers, rejects duplicates, and removes on dispose', async () => {
    const ctx = await registry()
    const p = new NullLoopProvider()
    const dispose = ctx.loops.register(p)
    expect(ctx.loops.get('null')).toBe(p)
    expect(ctx.loops.list().map(x => x.name)).toEqual(['null'])
    let err: unknown
    try { ctx.loops.register(new NullLoopProvider()) } catch (e) { err = e }
    expect(err).toBeInstanceOf(LoopRegistryError)
    expect((err as LoopRegistryError).code).toBe('DUPLICATE_PROVIDER')
    dispose()
    expect(ctx.loops.get('null')).toBeUndefined()
    expect(ctx.loops.list()).toEqual([])
  })

  it('start() on an unknown provider throws', async () => {
    const ctx = await registry()
    await expect(ctx.loops.start('nope', spec())).rejects.toMatchObject({ code: 'UNKNOWN_PROVIDER' })
  })

  it('the loops-null plugin registers for its scope only', async () => {
    const ctx = await registry()
    const fiber = await ctx.plugin(pluginNull)
    expect(ctx.loops.get('null')).toBeDefined()
    await fiber.dispose()
    expect(ctx.loops.get('null')).toBeUndefined()
  })
})

describe('NullLoopProvider', () => {
  it('emits started, one assistant, finished COMPLETED without touching anything', async () => {
    const ctx = await registry()
    ctx.loops.register(new NullLoopProvider())
    const run = await ctx.loops.start('null', spec('att-9'))
    expect(run.id).toBe('att-9')
    const events = await collectEvents(run)
    expect(events.map(e => e.t)).toEqual(['started', 'assistant', 'finished'])
    const fin = await run.result
    expect(fin).toMatchObject({
      status: 'COMPLETED',
      stopReason: 'completed',
      usage: { inputTokens: 0, outputTokens: 0 },
      cost: { source: 'unknown' },
      turns: 0,
      toolCalls: 0,
      artifacts: [],
    })
    expect(events.at(-1)).toEqual(fin)
    await run.dispose()
    await run.dispose()
  })

  it('writes a canned submit under the submit-tool file convention and reports it as output', async () => {
    const workdir = mkdtempSync(join(tmpdir(), 'samsara-null-'))
    const ctx = await registry()
    ctx.loops.register(new NullLoopProvider({ submit: { answer: 'x' } }))
    const run = await ctx.loops.start('null', { ...spec('att-s'), workdir })
    const events = await collectEvents(run)
    expect(events.map(e => e.t)).toEqual(['started', 'assistant', 'output', 'finished'])
    expect(events[2]).toMatchObject({ t: 'output', structured: { answer: 'x' }, source: 'submit-tool' })
    expect(readSubmit(workdir, 'submit')?.value).toEqual({ answer: 'x' })
    expect((await run.result).status).toBe('COMPLETED')
  })

  it('submits nothing by default, and the loops-null plugin passes its submit config through', async () => {
    const workdir = mkdtempSync(join(tmpdir(), 'samsara-null-'))
    const ctx = await registry()
    ctx.loops.register(new NullLoopProvider())
    await collectEvents(await ctx.loops.start('null', { ...spec(), workdir }))
    expect(readSubmit(workdir, 'submit')).toBeUndefined()
    const configured = await registry()
    await configured.plugin(pluginNull, { submit: { answer: 'y' } })
    await collectEvents(await configured.loops.start('null', { ...spec(), workdir }))
    expect(readSubmit(workdir, 'submit')?.value).toEqual({ answer: 'y' })
  })

  it('every built-in provider says where it runs: only the installed loop runs inside the environment', () => {
    expect(new NullLoopProvider().capabilities.installed).toBe(false)
    expect(new DshLoopProvider(new Context(), {}).capabilities.installed).toBe(false)
    expect(claudeCodeCapabilities.installed).toBe(false)
    expect(new InstalledLoopProvider({ command: ['true'] }).capabilities.installed).toBe(true)
  })

  it('has stable harness facts', () => {
    const p = new NullLoopProvider()
    expect(factsSha(p.harnessFacts)).toMatch(/^[0-9a-f]{64}$/)
    expect(factsSha({ ...p.harnessFacts })).toBe(factsSha(p.harnessFacts))
    expect(factsSha({ ...p.harnessFacts, permission: 'x' })).not.toBe(factsSha(p.harnessFacts))
  })
})

describe('start() wrapping', () => {
  it('rethrows when the provider throws before publication', async () => {
    const ctx = await registry()
    ctx.loops.register({ ...new NullLoopProvider(), name: 'boom', async start() { throw new Error('pre-publication') } })
    await expect(ctx.loops.start('boom', spec())).rejects.toThrow('pre-publication')
  })

  it('synthesizes FAILED/error when the stream throws after publication', async () => {
    const ctx = await registry()
    ctx.loops.register(fakeProvider('throws', async function* () {
      yield { t: 'started', at: 1, native: { kind: 'fake', id: 'x' } }
      throw new Error('mid-stream')
    }))
    const run = await ctx.loops.start('throws', spec())
    const events = await collectEvents(run)
    expect(events.map(e => e.t)).toEqual(['started', 'finished'])
    const fin = await run.result
    expect(fin).toMatchObject({ status: 'FAILED', stopReason: 'error' })
    expect(events.at(-1)).toEqual(fin)
  })

  it('synthesizes finished when the stream ends without one', async () => {
    const ctx = await registry()
    ctx.loops.register(fakeProvider('silent', async function* () {
      yield { t: 'started', at: 1, native: { kind: 'fake', id: 'x' } }
    }))
    const run = await ctx.loops.start('silent', spec())
    const fin = await run.result
    expect(fin.status).toBe('FAILED')
    expect((await collectEvents(run)).filter(e => e.t === 'finished')).toHaveLength(1)
  })

  it('downgrades finished to FAILED/error when the loop hands back its skill snapshot changed', async () => {
    const workdir = mkdtempSync(join(tmpdir(), 'samsara-loops-'))
    const skillDir = join(workdir, '.agents', 'skills', 'skill')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'params.json'), '{"k":0}')
    const done: LoopEvent = { t: 'finished', at: 1, status: 'COMPLETED', stopReason: 'completed', usage: { inputTokens: 3, outputTokens: 4 }, cost: { usd: 0.5, source: 'self-reported' }, turns: 1, toolCalls: 2, artifacts: [] }
    const ctx = await registry()
    ctx.loops.register(fakeProvider('reads', async function* () { yield done }))
    ctx.loops.register(fakeProvider('writes', async function* () {
      writeFileSync(join(skillDir, 'params.json'), '{"k":1}')
      yield done
    }))
    const s = { ...spec(), workdir, skill: { name: 'skill', dir: skillDir, sha: 'a'.repeat(64) } }
    expect((await (await ctx.loops.start('reads', s)).result).status).toBe('COMPLETED')
    const run = await ctx.loops.start('writes', s)
    const fin = await run.result
    expect(fin).toEqual({ ...done, status: 'FAILED', stopReason: 'error' })
    expect((await collectEvents(run)).at(-1)).toEqual(fin)
    // the changed snapshot is the new seal: a later attempt that leaves it alone completes
    expect((await (await ctx.loops.start('reads', s)).result).status).toBe('COMPLETED')
  })

  it('keeps exactly one finished when the provider emits two', async () => {
    const ctx = await registry()
    const done = (at: number): LoopEvent => ({ t: 'finished', at, status: 'COMPLETED', stopReason: 'completed', usage: { inputTokens: 0, outputTokens: 0 }, cost: { source: 'unknown' }, turns: 1, toolCalls: 0, artifacts: [] })
    ctx.loops.register(fakeProvider('twice', async function* () { yield done(1); yield done(2) }))
    const run = await ctx.loops.start('twice', spec())
    const events = await collectEvents(run)
    expect(events).toHaveLength(1)
    expect((await run.result).at).toBe(1)
  })
})
