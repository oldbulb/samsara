// @oldbulb/samsara-loops — OpenTelemetry GenAI vocabulary for a loop's event stream.
//
// LoopEvent stays the seam; this module is the one place that maps it to the
// OTel GenAI semantic conventions (gen-ai-agent-spans.md) and renders the
// result as OTLP/JSON resource spans. Pure: ids derive from the attempt id, so
// the same events export to the same spans. The mapping table is in README.md.

import { createHash } from 'node:crypto'
import type { LoopEvent, TokenUsage } from './types.ts'

/** What the host knows about an attempt beyond its events; every field but attemptId is optional. */
export interface AttemptMeta {
  attemptId: string
  challengerId?: string
  tier?: string
  factsSha?: string
  loop?: string
  /** gen_ai.provider.name / gen_ai.request.model when the route is known. */
  provider?: string
  model?: string
}

export type OtlpValue = { stringValue: string } | { intValue: string } | { boolValue: boolean } | { arrayValue: { values: OtlpValue[] } }
export interface OtlpAttribute { key: string; value: OtlpValue }

export interface OtlpSpan {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  /** OTLP SpanKind: 1 INTERNAL, 3 CLIENT. */
  kind: 1 | 3
  startTimeUnixNano: string
  endTimeUnixNano: string
  attributes: OtlpAttribute[]
  status: { code: 0 | 1 | 2; message?: string }
}

export interface OtlpResourceSpans {
  resource: { attributes: OtlpAttribute[] }
  scopeSpans: { scope: { name: string }; spans: OtlpSpan[] }[]
}

export const OTEL_SCOPE_NAME = 'samsara'
const SPAN_KIND_INTERNAL = 1
const SPAN_KIND_CLIENT = 3
const STATUS_OK = 1
const STATUS_ERROR = 2

function hex(input: string, bytes: number): string {
  return createHash('sha256').update(input).digest('hex').slice(0, bytes * 2)
}

function nanos(ms: number): string {
  return (BigInt(Math.round(ms)) * 1_000_000n).toString()
}

function str(key: string, value: string): OtlpAttribute {
  return { key, value: { stringValue: value } }
}

function int(key: string, value: number): OtlpAttribute {
  return { key, value: { intValue: String(Math.trunc(value)) } }
}

function usageAttrs(usage: TokenUsage | undefined): OtlpAttribute[] {
  if (!usage) return []
  return [int('gen_ai.usage.input_tokens', usage.inputTokens), int('gen_ai.usage.output_tokens', usage.outputTokens)]
}

function samsaraAttrs(meta: AttemptMeta): OtlpAttribute[] {
  const out = [str('samsara.attempt_id', meta.attemptId)]
  if (meta.challengerId !== undefined) out.push(str('samsara.challenger_id', meta.challengerId))
  if (meta.tier !== undefined) out.push(str('samsara.tier', meta.tier))
  if (meta.factsSha !== undefined) out.push(str('samsara.facts_sha', meta.factsSha))
  if (meta.loop !== undefined) out.push(str('samsara.loop', meta.loop))
  return out
}

function routeAttrs(meta: AttemptMeta): OtlpAttribute[] {
  const out: OtlpAttribute[] = []
  if (meta.provider !== undefined) out.push(str('gen_ai.provider.name', meta.provider))
  if (meta.model !== undefined) out.push(str('gen_ai.request.model', meta.model))
  return out
}

/**
 * One attempt's events → one trace: an `invoke_agent` root, a `chat` child per
 * assistant event (spanning from the previous event to it), and an
 * `execute_tool` child per tool_call paired with its tool_result by callId.
 */
export function toSpans(meta: AttemptMeta, events: LoopEvent[]): OtlpSpan[] {
  if (events.length === 0) return []
  const traceId = hex(`trace:${meta.attemptId}`, 16)
  const rootId = hex(`span:${meta.attemptId}:invoke_agent`, 8)
  const started = events.find((e) => e.t === 'started')
  const finished = events.find((e) => e.t === 'finished')
  const first = events[0]!
  const rootStart = started?.at ?? first.at
  const rootEnd = Math.max(rootStart, finished?.at ?? events[events.length - 1]!.at)

  const base = [...routeAttrs(meta), ...samsaraAttrs(meta)]
  const agentName = meta.loop ?? started?.native.kind
  const rootAttrs: OtlpAttribute[] = [str('gen_ai.operation.name', 'invoke_agent')]
  if (agentName !== undefined) rootAttrs.push(str('gen_ai.agent.name', agentName))
  rootAttrs.push(...base)
  if (finished) {
    rootAttrs.push(...usageAttrs(finished.usage))
    rootAttrs.push({ key: 'gen_ai.response.finish_reasons', value: { arrayValue: { values: [{ stringValue: finished.stopReason }] } } })
    rootAttrs.push(int('samsara.turns', finished.turns), int('samsara.tool_calls', finished.toolCalls), str('samsara.status', finished.status))
    if (finished.status !== 'COMPLETED') rootAttrs.push(str('error.type', finished.stopReason))
  } else {
    rootAttrs.push(str('error.type', 'unfinished'))
  }
  const rootOk = finished?.status === 'COMPLETED'
  const spans: OtlpSpan[] = [{
    traceId, spanId: rootId, name: agentName !== undefined ? `invoke_agent ${agentName}` : 'invoke_agent',
    kind: SPAN_KIND_CLIENT, startTimeUnixNano: nanos(rootStart), endTimeUnixNano: nanos(rootEnd),
    attributes: rootAttrs,
    status: rootOk ? { code: STATUS_OK } : { code: STATUS_ERROR, message: finished ? finished.stopReason : 'no finished event' },
  }]

  const results = new Map<string, Extract<LoopEvent, { t: 'tool_result' }>>()
  for (const e of events) if (e.t === 'tool_result' && !results.has(e.callId)) results.set(e.callId, e)

  let prevAt = rootStart
  let chatIndex = 0
  let toolIndex = 0
  for (const e of events) {
    if (e.t === 'assistant') {
      const start = Math.max(rootStart, Math.min(prevAt, e.at))
      const end = Math.max(start, e.at)
      spans.push({
        traceId, spanId: hex(`span:${meta.attemptId}:chat:${chatIndex++}`, 8), parentSpanId: rootId,
        name: meta.model !== undefined ? `chat ${meta.model}` : 'chat',
        kind: SPAN_KIND_CLIENT, startTimeUnixNano: nanos(start), endTimeUnixNano: nanos(end),
        attributes: [str('gen_ai.operation.name', 'chat'), ...base, ...usageAttrs(e.usage), int('samsara.turn', e.turn), int('samsara.text_bytes', e.textBytes)],
        status: { code: STATUS_OK },
      })
    } else if (e.t === 'tool_call') {
      const result = results.get(e.callId)
      const start = Math.max(rootStart, e.at)
      const end = Math.max(start, result?.at ?? (e.at + (result?.durationMs ?? 0)))
      const attrs = [str('gen_ai.operation.name', 'execute_tool'), str('gen_ai.tool.name', e.name), str('gen_ai.tool.call.id', e.callId), ...base, int('samsara.args_bytes', e.argsBytes)]
      if (result) attrs.push(int('samsara.result_bytes', result.bytes))
      if (result?.isError) attrs.push(str('error.type', 'tool_error'))
      spans.push({
        traceId, spanId: hex(`span:${meta.attemptId}:execute_tool:${toolIndex++}:${e.callId}`, 8), parentSpanId: rootId,
        name: `execute_tool ${e.name}`,
        kind: SPAN_KIND_INTERNAL, startTimeUnixNano: nanos(start), endTimeUnixNano: nanos(end),
        attributes: attrs,
        status: result?.isError ? { code: STATUS_ERROR, message: 'tool_error' } : { code: STATUS_OK },
      })
    }
    if (e.at > prevAt) prevAt = e.at
  }
  return spans
}

/** Wrap span lists into one OTLP/JSON `resourceSpans` entry (the shape `ExportTraceServiceRequest` carries). */
export function toResourceSpans(spans: OtlpSpan[], resource: Record<string, string> = {}): OtlpResourceSpans {
  const attributes = [str('service.name', OTEL_SCOPE_NAME), ...Object.entries(resource).map(([k, v]) => str(k, v))]
  return { resource: { attributes }, scopeSpans: [{ scope: { name: OTEL_SCOPE_NAME }, spans }] }
}
