import { describe, expect, it } from 'vitest'
import { MessageMapper, classifyResult, PRESET_ID } from '../src/mapper.ts'
import { createHash } from 'node:crypto'
import { assistantToolUse, initMessage, resultMessage, stream, toolResult } from './fixture.ts'
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

function clock() {
  let t = 1000
  return () => (t += 100)
}

describe('MessageMapper', () => {
  it('maps a full stream to seam events in order', () => {
    const m = new MessageMapper({ systemPromptAppend: 'APPEND', pid: 42, now: clock() })
    const events = stream().flatMap((msg) => m.map(msg))
    expect(events.map((e) => e.t)).toEqual(['started', 'system_prompt', 'tool_call', 'assistant', 'tool_result', 'assistant'])
    expect(m.result?.type).toBe('result')
    expect(m.toolCalls).toBe(1)
  })

  it('system/init → started + system_prompt hashed over preset id, append and tools', () => {
    const m = new MessageMapper({ systemPromptAppend: 'APPEND', pid: 42, now: clock() })
    const [started, sp] = m.map(initMessage(['Bash', 'Read']))
    expect(started).toMatchObject({ t: 'started', native: { kind: 'claude-code', pid: 42 } })
    const hashed = [PRESET_ID, 'APPEND', 'Bash', 'Read'].join('\n')
    expect(sp).toMatchObject({ t: 'system_prompt', sha256: sha(hashed), bytes: Buffer.byteLength(hashed), tools: ['Bash', 'Read'] })
  })

  it('tool_use → tool_call with args hash/preview; assistant carries usage', () => {
    const m = new MessageMapper({ systemPromptAppend: '', now: clock() })
    const [call, asst] = m.map(assistantToolUse('toolu_9', 'Bash', { command: 'ls' }))
    const args = JSON.stringify({ command: 'ls' })
    expect(call).toMatchObject({ t: 'tool_call', callId: 'toolu_9', name: 'Bash', argsSha256: sha(args), argsBytes: args.length, argsPreview: args })
    expect(asst).toMatchObject({
      t: 'assistant',
      turn: 1,
      textBytes: Buffer.byteLength('Let me look.'),
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 10, cacheWriteTokens: 5 },
    })
  })

  it('tool_result → tool_result with durationMs from the matching call', () => {
    const m = new MessageMapper({ systemPromptAppend: '', now: clock() })
    m.map(assistantToolUse('toolu_9', 'Bash', {}))
    const [res] = m.map(toolResult('toolu_9', 'out', true))
    expect(res).toMatchObject({ t: 'tool_result', callId: 'toolu_9', isError: true, bytes: 3, durationMs: 100 })
  })

  it('ignores message kinds outside the seam', () => {
    const m = new MessageMapper({ systemPromptAppend: '', now: clock() })
    expect(m.map({ type: 'rate_limit_event' } as never)).toEqual([])
    expect(m.map({ type: 'system', subtype: 'permission_denied' } as never)).toEqual([])
  })
})

describe('classifyResult', () => {
  const r = (s: string) => resultMessage(s) as SDKResultMessage
  it('maps subtypes', () => {
    expect(classifyResult(r('success'), false, false)).toEqual({ status: 'COMPLETED', stopReason: 'completed' })
    expect(classifyResult(r('error_max_turns'), false, false)).toEqual({ status: 'TRUNCATED', stopReason: 'max_turns' })
    expect(classifyResult(r('error_max_budget_usd'), false, false)).toEqual({ status: 'TRUNCATED', stopReason: 'budget' })
    expect(classifyResult(r('error_max_structured_output_retries'), false, false)).toEqual({ status: 'FAILED', stopReason: 'schema_failed' })
    expect(classifyResult(r('error_during_execution'), false, false)).toEqual({ status: 'FAILED', stopReason: 'error' })
  })
  it('abort / timeout / missing result', () => {
    expect(classifyResult(undefined, true, false)).toEqual({ status: 'ABORTED', stopReason: 'aborted' })
    expect(classifyResult(r('success'), true, true)).toEqual({ status: 'TRUNCATED', stopReason: 'timeout' })
    expect(classifyResult(undefined, false, false)).toEqual({ status: 'FAILED', stopReason: 'error' })
  })
})
