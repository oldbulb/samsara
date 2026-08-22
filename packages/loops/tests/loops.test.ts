import { describe, expect, it } from 'vitest'
import { Context } from '@samsara/kernel'
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
    harnessFacts: { systemPromptMode: 'none', skillDelivery: 'prompt-inline', schemaEnforcement: 'permissive-tool', permission: 'none', reasoning: {}, version: { loop: 'fake' } },
    capabilities: { perAttemptBaseUrl: false, perAttemptEnv: false, nativeSchema: 'none', toolFilter: false, nativeMaxTurns: false },
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
