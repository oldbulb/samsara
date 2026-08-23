import { describe, expect, it } from 'vitest'
import { createEventMapper, finish, sha256 } from '../src/events.ts'
import { createLimits } from '../src/limits.ts'

// Synthetic session events: only the fields the mapper reads, typed loosely.
type AnyEvent = { type: string; seq: number; time: number; data: unknown }
let seq = 0
const ev = (type: string, time: number, data: unknown): AnyEvent => ({ type, seq: seq++, time, data })
const feed = (mapper: ReturnType<typeof createEventMapper>, events: AnyEvent[]) =>
  events.flatMap((e) => mapper.map(e as never))

const header = (system: string, tools: string[]) =>
  ev('request/header', 1000, { header: { config: {}, system, tools: tools.map((name) => ({ name, description: '', parameters: {} })) }, reason: 'initial' })
const call = (callId: string, name: string, args: string, time = 2000) =>
  ev('tool/call', time, { turn: 1, step: 1, callId, name, arguments: args })
const result = (callId: string, time = 2500, isError?: boolean, error?: { name: string; code: string }) =>
  ev('tool/result', time, {
    turn: 1, step: 1,
    message: { id: 'm', role: 'user', content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: 'ok' }], ...(isError ? { isError } : {}) }], source: { kind: 'tool' } },
    ...(error ? { error } : {}),
  })
const assistant = (step: number, text: string, usage?: object, time = 3000) =>
  ev('assistant/message', time, { turn: 1, step, message: { id: 'a', role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model' } }, ...(usage ? { usage } : {}) })
const turnEnd = (reason: object) => ev('turn/end', 4000, { turn: 1, reason })

describe('event mapper', () => {
  it('maps the first request/header to system_prompt (hash, bytes, tool names) and ignores later ones', () => {
    const m = createEventMapper({ submitToolName: 'submit_x' })
    const out = feed(m, [header('You are X', ['read', 'submit_x']), header('changed', ['read'])])
    expect(out).toEqual([{ t: 'system_prompt', at: 1000, sha256: sha256('You are X'), bytes: 9, tools: ['read', 'submit_x'] }])
  })

  it('maps tool/call → tool_call with argument hash and tool/result → tool_result with duration', () => {
    const m = createEventMapper({ submitToolName: 'submit_x' })
    const args = '{"path":"a.txt"}'
    const out = feed(m, [call('c1', 'read', args, 2000), result('c1', 2750)])
    expect(out[0]).toEqual({ t: 'tool_call', at: 2000, callId: 'c1', name: 'read', argsSha256: sha256(args), argsBytes: args.length, argsPreview: args })
    expect(out[1]).toMatchObject({ t: 'tool_result', at: 2750, callId: 'c1', isError: false, durationMs: 750 })
    expect(m.toolCalls).toBe(1)
  })

  it('flags error results from either the block flag or the dsh error identity', () => {
    const m = createEventMapper({ submitToolName: 'submit_x' })
    const out = feed(m, [call('c1', 'bash', '{}'), result('c1', 2500, true), call('c2', 'bash', '{}'), result('c2', 2600, undefined, { name: 'ToolArgsError', code: 'INVALID_ARGS' })])
    expect(out.filter((e) => e.t === 'tool_result').map((e) => (e as { isError: boolean }).isError)).toEqual([true, true])
  })

  it('turns a successful submit tool call into output{source:submit-tool}, not a failed one', () => {
    const m = createEventMapper({ submitToolName: 'submit_x' })
    const bad = feed(m, [call('s0', 'submit_x', '{"answer":1}'), result('s0', 2100, true)])
    expect(bad.some((e) => e.t === 'output')).toBe(false)
    expect(m.submitted).toBe(false)
    const good = feed(m, [call('s1', 'submit_x', '{"answer":42}'), result('s1', 2200)])
    expect(good.at(-1)).toEqual({ t: 'output', at: 2200, structured: { answer: 42 }, text: '{"answer":42}', source: 'submit-tool' })
    expect(m.submitted).toBe(true)
  })

  it('maps assistant/message to assistant with usage and sums usage across steps', () => {
    const m = createEventMapper({ submitToolName: 'submit_x' })
    const out = feed(m, [
      assistant(1, 'hi', { inputTokens: 10, outputTokens: 5, cacheReadTokens: 4 }),
      assistant(2, 'héllo', { inputTokens: 20, outputTokens: 7 }),
      assistant(3, ''),
    ])
    expect(out[0]).toEqual({ t: 'assistant', at: 3000, turn: 1, textBytes: 2, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 4 } })
    expect(out[1]).toMatchObject({ turn: 2, textBytes: 6 })
    expect(out[2]).not.toHaveProperty('usage')
    expect(m.usage).toEqual({ inputTokens: 30, outputTokens: 12, cacheReadTokens: 4 })
    expect(m.turns).toBe(3)
  })

  it('ignores events outside the mapping', () => {
    const m = createEventMapper({ submitToolName: 'submit_x' })
    expect(feed(m, [ev('turn/start', 1, { turn: 1 }), ev('assistant/chunk', 2, {}), ev('user/message', 3, {})])).toEqual([])
  })
})

describe('finish', () => {
  const base = (events: AnyEvent[], limitsOpts = { maxTurns: 10 }) => {
    const mapper = createEventMapper({ submitToolName: 'submit_x' })
    feed(mapper, events)
    return { mapper, limits: createLimits(limitsOpts) }
  }

  it('COMPLETED/completed when the turn completed with a submit', () => {
    const { mapper, limits } = base([call('s', 'submit_x', '{}'), result('s'), turnEnd({ kind: 'completed' })])
    const f = finish({ at: 5, mapper, limits })
    expect(f).toMatchObject({ t: 'finished', status: 'COMPLETED', stopReason: 'completed', toolCalls: 1, cost: { source: 'unknown' }, artifacts: [] })
  })

  it('TRUNCATED/schema_failed when the turn completed without a submit', () => {
    const { mapper, limits } = base([assistant(1, 'done'), turnEnd({ kind: 'completed' })])
    expect(finish({ at: 5, mapper, limits })).toMatchObject({ status: 'TRUNCATED', stopReason: 'schema_failed', turns: 1 })
  })

  it('limits own the stop reason over the turn/end kind', () => {
    const { mapper, limits } = base([turnEnd({ kind: 'aborted', reason: { kind: 'hook', reason: 'x' } })])
    limits.trip('timeout')
    expect(finish({ at: 5, mapper, limits })).toMatchObject({ status: 'TRUNCATED', stopReason: 'timeout' })
    const l2 = createLimits({ maxTurns: 0 })
    l2.preStep()
    expect(finish({ at: 5, mapper, limits: l2 })).toMatchObject({ status: 'TRUNCATED', stopReason: 'max_turns' })
  })

  it('host cancel → ABORTED; provider error → FAILED; model error/blocked → FAILED; max-tokens → TRUNCATED/budget', () => {
    const { mapper, limits } = base([turnEnd({ kind: 'aborted', reason: { kind: 'parent' } })])
    limits.trip('aborted')
    expect(finish({ at: 5, mapper, limits })).toMatchObject({ status: 'ABORTED', stopReason: 'aborted' })
    expect(finish({ at: 5, ...base([turnEnd({ kind: 'aborted', reason: { kind: 'user' } })]) })).toMatchObject({ status: 'ABORTED' })
    expect(finish({ at: 5, ...base([]), error: new Error('boom') })).toMatchObject({ status: 'FAILED', stopReason: 'error' })
    expect(finish({ at: 5, ...base([turnEnd({ kind: 'error', error: { message: 'x', code: 'UNKNOWN' } })]) })).toMatchObject({ status: 'FAILED', stopReason: 'error' })
    expect(finish({ at: 5, ...base([turnEnd({ kind: 'blocked' })]) })).toMatchObject({ status: 'FAILED' })
    expect(finish({ at: 5, ...base([turnEnd({ kind: 'max-tokens' })]) })).toMatchObject({ status: 'TRUNCATED', stopReason: 'budget' })
  })

  it('prices usage when a price table is configured', () => {
    const mapper = createEventMapper({ submitToolName: 'submit_x' })
    feed(mapper, [assistant(1, 'a', { inputTokens: 1_000_000, outputTokens: 500_000, cacheReadTokens: 500_000 }), turnEnd({ kind: 'completed' })])
    const limits = createLimits({ maxTurns: 5, price: { input: 2, output: 8, cacheRead: 0.5 } })
    // 500k uncached input @2 + 500k cached @0.5 + 500k output @8
    expect(finish({ at: 5, mapper, limits }).cost).toEqual({ usd: 1 + 0.25 + 4, source: 'price-table' })
  })
})

describe('skill utilization', () => {
  it('reports inline for prompt-inline delivery and the read fraction otherwise', () => {
    const mapper = createEventMapper({ submitToolName: 'submit_x', skillToolName: 'skill' })
    const limits = createLimits({ maxTurns: 5 })
    expect(finish({ at: 5, mapper, limits }).skillUtilization).toBe('inline')
    expect(finish({ at: 5, mapper, limits, skillDelivery: 'agents-skills-dir' }).skillUtilization).toBe(0)
    mapper.map({ type: 'tool/call', time: 1, data: { callId: 'k', name: 'skill', arguments: '{}' } } as never)
    expect(mapper.skillToolCalls).toBe(1)
    expect(finish({ at: 5, mapper, limits, skillDelivery: 'agents-skills-dir' }).skillUtilization).toBe(1)
  })
})
