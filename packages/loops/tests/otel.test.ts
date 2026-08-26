import { describe, expect, it } from 'vitest'
import { toSpans, toResourceSpans, type LoopEvent, type OtlpSpan } from '../src/index.ts'

const T0 = 1_700_000_000_000
const EVENTS: LoopEvent[] = [
  { t: 'started', at: T0, native: { kind: 'fake', id: 'n-1' } },
  { t: 'envelope', at: T0 + 1, config: { sha256: 'a'.repeat(64), provider: 'prov', model: 'm-1' }, system: { sha256: 'a'.repeat(64), bytes: 10 }, tools: { sha256: 'a'.repeat(64), names: ['read'] } },
  { t: 'assistant', at: T0 + 100, turn: 0, textBytes: 5, usage: { inputTokens: 10, outputTokens: 3 } },
  { t: 'tool_call', at: T0 + 110, callId: 'c1', name: 'read', argsSha256: 'b'.repeat(64), argsBytes: 7 },
  { t: 'tool_result', at: T0 + 150, callId: 'c1', isError: false, bytes: 20, durationMs: 40 },
  { t: 'tool_call', at: T0 + 160, callId: 'c2', name: 'bash', argsSha256: 'c'.repeat(64), argsBytes: 9 },
  { t: 'tool_result', at: T0 + 200, callId: 'c2', isError: true, bytes: 1 },
  { t: 'assistant', at: T0 + 300, turn: 1, textBytes: 8, usage: { inputTokens: 20, outputTokens: 4 } },
  { t: 'output', at: T0 + 301, text: '{}', source: 'submit-tool' },
  { t: 'finished', at: T0 + 310, status: 'COMPLETED', stopReason: 'completed', usage: { inputTokens: 30, outputTokens: 7 }, cost: { source: 'unknown' }, turns: 2, toolCalls: 2, artifacts: [] },
]
const META = { attemptId: 'att-1', challengerId: 'ch-1', tier: 'smoke', factsSha: 'f'.repeat(64), loop: 'fake', provider: 'prov', model: 'm-1' }

function attr(s: OtlpSpan, key: string): unknown {
  const a = s.attributes.find((x) => x.key === key)
  if (!a) return undefined
  const v = a.value as Record<string, unknown>
  if ('arrayValue' in v) return (v['arrayValue'] as { values: { stringValue: string }[] }).values.map((x) => x.stringValue)
  return v['stringValue'] ?? v['intValue'] ?? v['boolValue']
}
function op(s: OtlpSpan): unknown { return attr(s, 'gen_ai.operation.name') }

describe('toSpans', () => {
  const spans = toSpans(META, EVENTS)
  const root = spans[0]!
  it('builds one invoke_agent root, a chat per assistant and an execute_tool per call', () => {
    expect(spans.map(op)).toEqual(['invoke_agent', 'chat', 'execute_tool', 'execute_tool', 'chat'])
    expect(root.name).toBe('invoke_agent fake')
    expect(root.parentSpanId).toBeUndefined()
    for (const s of spans.slice(1)) {
      expect(s.parentSpanId).toBe(root.spanId)
      expect(s.traceId).toBe(root.traceId)
    }
    expect(new Set(spans.map((s) => s.spanId)).size).toBe(spans.length)
    expect(root.traceId).toMatch(/^[0-9a-f]{32}$/)
    expect(root.spanId).toMatch(/^[0-9a-f]{16}$/)
  })
  it('uses the convention attribute names exactly', () => {
    expect(attr(root, 'gen_ai.agent.name')).toBe('fake')
    expect(attr(root, 'gen_ai.provider.name')).toBe('prov')
    expect(attr(root, 'gen_ai.request.model')).toBe('m-1')
    expect(attr(root, 'gen_ai.usage.input_tokens')).toBe('30')
    expect(attr(root, 'gen_ai.usage.output_tokens')).toBe('7')
    expect(attr(root, 'gen_ai.response.finish_reasons')).toEqual(['completed'])
    expect(attr(root, 'samsara.challenger_id')).toBe('ch-1')
    expect(attr(root, 'samsara.attempt_id')).toBe('att-1')
    expect(attr(root, 'samsara.tier')).toBe('smoke')
    expect(attr(root, 'samsara.facts_sha')).toBe('f'.repeat(64))
    expect(attr(root, 'samsara.loop')).toBe('fake')
    const chat = spans[1]!
    expect(chat.name).toBe('chat m-1')
    expect(attr(chat, 'gen_ai.usage.input_tokens')).toBe('10')
    expect(attr(chat, 'gen_ai.usage.output_tokens')).toBe('3')
    const tool = spans[2]!
    expect(tool.name).toBe('execute_tool read')
    expect(attr(tool, 'gen_ai.tool.name')).toBe('read')
    expect(attr(tool, 'gen_ai.tool.call.id')).toBe('c1')
    expect(tool.status.code).toBe(1)
    const failed = spans[3]!
    expect(attr(failed, 'error.type')).toBe('tool_error')
    expect(failed.status.code).toBe(2)
    for (const s of spans) for (const a of s.attributes) expect(a.key).toMatch(/^(gen_ai|samsara|error)\./)
  })
  it('has monotonic timestamps and tool timing from call to result', () => {
    const ns = (s: string) => BigInt(s)
    for (const s of spans) {
      expect(ns(s.endTimeUnixNano) >= ns(s.startTimeUnixNano)).toBe(true)
      expect(ns(s.startTimeUnixNano) >= ns(root.startTimeUnixNano)).toBe(true)
      expect(ns(s.endTimeUnixNano) <= ns(root.endTimeUnixNano)).toBe(true)
    }
    expect(root.startTimeUnixNano).toBe(`${T0}000000`)
    expect(root.endTimeUnixNano).toBe(`${T0 + 310}000000`)
    expect(spans[2]!.startTimeUnixNano).toBe(`${T0 + 110}000000`)
    expect(spans[2]!.endTimeUnixNano).toBe(`${T0 + 150}000000`)
    expect(spans[1]!.startTimeUnixNano).toBe(`${T0 + 1}000000`)
    expect(spans[1]!.endTimeUnixNano).toBe(`${T0 + 100}000000`)
    const children = spans.slice(1)
    for (let i = 1; i < children.length; i++) expect(ns(children[i]!.startTimeUnixNano) >= ns(children[i - 1]!.startTimeUnixNano)).toBe(true)
  })
  it('is deterministic and marks an unfinished or failed attempt as an error', () => {
    expect(toSpans(META, EVENTS)).toEqual(spans)
    const partial = toSpans({ attemptId: 'att-2' }, EVENTS.slice(0, 4))
    expect(partial[0]!.status.code).toBe(2)
    expect(attr(partial[0]!, 'error.type')).toBe('unfinished')
    expect(partial[0]!.name).toBe('invoke_agent fake')
    expect(partial.map(op)).toEqual(['invoke_agent', 'chat', 'execute_tool'])
    expect(partial[2]!.endTimeUnixNano).toBe(partial[2]!.startTimeUnixNano)
    expect(toSpans({ attemptId: 'x' }, [])).toEqual([])
  })
  it('wraps spans as OTLP resourceSpans', () => {
    const rs = toResourceSpans(spans, { 'samsara.run_dir': 'r' })
    expect(rs.scopeSpans[0]!.scope.name).toBe('samsara')
    expect(rs.scopeSpans[0]!.spans).toBe(spans)
    expect(rs.resource.attributes).toEqual([{ key: 'service.name', value: { stringValue: 'samsara' } }, { key: 'samsara.run_dir', value: { stringValue: 'r' } }])
  })
})
