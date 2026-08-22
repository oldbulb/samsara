// SDKMessage → LoopEvent. Stateful over one run (turn counter, open tool
// calls, the terminal result) but free of I/O, so it is unit-testable from a
// hand-written message fixture.

import { createHash } from 'node:crypto'
import type { SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import type { LoopEvent, StopReason, TokenUsage } from './seam.ts'

export const PRESET_ID = 'preset:claude_code'
const ARGS_PREVIEW_CHARS = 200

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/** Anthropic `usage` object (message or result) → seam TokenUsage. */
export function tokenUsage(usage: unknown): TokenUsage {
  const u = isRecord(usage) ? usage : {}
  const out: TokenUsage = { inputTokens: num(u['input_tokens']), outputTokens: num(u['output_tokens']) }
  if (u['cache_read_input_tokens'] !== undefined) out.cacheReadTokens = num(u['cache_read_input_tokens'])
  if (u['cache_creation_input_tokens'] !== undefined) out.cacheWriteTokens = num(u['cache_creation_input_tokens'])
  return out
}

export interface ResultOutcome {
  status: Extract<LoopEvent, { t: 'finished' }>['status']
  stopReason: StopReason
}

/** Terminal classification from the SDK result subtype; `aborted` wins when the host cancelled. */
export function classifyResult(result: SDKResultMessage | undefined, aborted: boolean, timedOut: boolean): ResultOutcome {
  if (timedOut) return { status: 'TRUNCATED', stopReason: 'timeout' }
  if (aborted) return { status: 'ABORTED', stopReason: 'aborted' }
  if (!result) return { status: 'FAILED', stopReason: 'error' }
  switch (result.subtype) {
    case 'success':
      return { status: 'COMPLETED', stopReason: 'completed' }
    case 'error_max_turns':
      return { status: 'TRUNCATED', stopReason: 'max_turns' }
    case 'error_max_budget_usd':
      return { status: 'TRUNCATED', stopReason: 'budget' }
    case 'error_max_structured_output_retries':
      return { status: 'FAILED', stopReason: 'schema_failed' }
    default:
      return { status: 'FAILED', stopReason: 'error' }
  }
}

export interface MapperOptions {
  /** Text appended to the preset system prompt; part of the system_prompt hash. */
  systemPromptAppend: string
  pid?: number
  now?: () => number
}

export class MessageMapper {
  private readonly now: () => number
  private readonly append: string
  private readonly pid: number | undefined
  private turn = 0
  private started = false
  private readonly openCalls = new Map<string, number>()
  toolCalls = 0
  result: SDKResultMessage | undefined

  constructor(opts: MapperOptions) {
    this.now = opts.now ?? Date.now
    this.append = opts.systemPromptAppend
    this.pid = opts.pid
  }

  /** Map one SDK message to zero or more seam events (never `finished`; the run emits that). */
  map(message: SDKMessage): LoopEvent[] {
    const at = this.now()
    switch (message.type) {
      case 'system':
        if (message.subtype !== 'init') return []
        return this.onInit(message.session_id, message.tools, at)
      case 'assistant':
        return this.onAssistant(message.message.content, message.message.usage, at)
      case 'user':
        return this.onUser(message.message.content, at)
      case 'result':
        this.result = message
        return []
      default:
        return []
    }
  }

  private onInit(sessionId: string, tools: string[], at: number): LoopEvent[] {
    const events: LoopEvent[] = []
    if (!this.started) {
      this.started = true
      const native: { kind: string; id: string; pid?: number } = { kind: 'claude-code', id: sessionId }
      if (this.pid !== undefined) native.pid = this.pid
      events.push({ t: 'started', at, native })
    }
    const hashed = [PRESET_ID, this.append, ...tools].join('\n')
    events.push({ t: 'system_prompt', at, sha256: sha256(hashed), bytes: byteLength(hashed), tools: [...tools] })
    return events
  }

  private onAssistant(content: unknown, usage: unknown, at: number): LoopEvent[] {
    const events: LoopEvent[] = []
    let textBytes = 0
    for (const block of Array.isArray(content) ? content : []) {
      if (!isRecord(block)) continue
      if (block['type'] === 'text' && typeof block['text'] === 'string') {
        textBytes += byteLength(block['text'])
      } else if (block['type'] === 'tool_use' && typeof block['id'] === 'string') {
        const args = JSON.stringify(block['input'] ?? {})
        this.openCalls.set(block['id'], at)
        this.toolCalls++
        events.push({
          t: 'tool_call',
          at,
          callId: block['id'],
          name: typeof block['name'] === 'string' ? block['name'] : '',
          argsSha256: sha256(args),
          argsBytes: byteLength(args),
          argsPreview: args.slice(0, ARGS_PREVIEW_CHARS),
        })
      }
    }
    this.turn++
    const ev: Extract<LoopEvent, { t: 'assistant' }> = { t: 'assistant', at, turn: this.turn, textBytes }
    if (isRecord(usage)) ev.usage = tokenUsage(usage)
    events.push(ev)
    return events
  }

  private onUser(content: unknown, at: number): LoopEvent[] {
    const events: LoopEvent[] = []
    for (const block of Array.isArray(content) ? content : []) {
      if (!isRecord(block) || block['type'] !== 'tool_result' || typeof block['tool_use_id'] !== 'string') continue
      const body = block['content']
      const bytes = body === undefined ? 0 : byteLength(typeof body === 'string' ? body : JSON.stringify(body))
      const startedAt = this.openCalls.get(block['tool_use_id'])
      this.openCalls.delete(block['tool_use_id'])
      const ev: Extract<LoopEvent, { t: 'tool_result' }> = {
        t: 'tool_result',
        at,
        callId: block['tool_use_id'],
        isError: block['is_error'] === true,
        bytes,
      }
      if (startedAt !== undefined) ev.durationMs = at - startedAt
      events.push(ev)
    }
    return events
  }
}
