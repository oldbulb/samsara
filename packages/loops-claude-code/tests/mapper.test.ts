import { describe, expect, it } from 'vitest'
import { MessageMapper, classifyResult, PRESET_ID } from '../src/mapper.ts'
import { canonicalJson } from '@oldbulb/samsara-loops'
import { createHash } from 'node:crypto'
import { assistantToolUse, initMessage, resultMessage, stream, toolResult } from './fixture.ts'
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

function clock() {
  let t = 1000
  return () => (t += 100)
}

const OPTS = { sdkVersion: '0.0.0', provider: 'anthropic' }

describe('MessageMapper', () => {
  it('maps a full stream to seam events in order', () => {
    const m = new MessageMapper({ ...OPTS, systemPromptAppend: 'APPEND', pid: 42, now: clock() })
    const events = stream().flatMap((msg) => m.map(msg))
    expect(events.map((e) => e.t)).toEqual(['started', 'envelope', 'tool_call', 'assistant', 'tool_result', 'assistant'])
    expect(m.result?.type).toBe('result')
    expect(m.toolCalls).toBe(1)
  })

  it('system/init → started + a proxy envelope: preset id + sdk version + append, init model, tool names', () => {
    const m = new MessageMapper({ ...OPTS, systemPromptAppend: 'APPEND', pid: 42, now: clock() })
    const [started, env] = m.map(initMessage(['Bash', 'Read']))
    expect(started).toMatchObject({ t: 'started', native: { kind: 'claude-code', pid: 42 } })
    const system = [PRESET_ID, '0.0.0', 'APPEND'].join('\n')
    expect(env).toEqual({
      t: 'envelope',
      at: 1100,
      config: { sha256: sha(canonicalJson({ provider: 'anthropic', model: 'm' })), provider: 'anthropic', model: 'm' },
      system: { sha256: sha(system), bytes: Buffer.byteLength(system) },
      tools: { sha256: sha(canonicalJson(['Bash', 'Read'])), names: ['Bash', 'Read'] },
    })
  })

  it('tool_use → tool_call with args hash/preview; assistant carries usage', () => {
    const m = new MessageMapper({ ...OPTS, systemPromptAppend: '', now: clock() })
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
    const m = new MessageMapper({ ...OPTS, systemPromptAppend: '', now: clock() })
    m.map(assistantToolUse('toolu_9', 'Bash', {}))
    const [res] = m.map(toolResult('toolu_9', 'out', true))
    expect(res).toMatchObject({ t: 'tool_result', callId: 'toolu_9', isError: true, bytes: 3, durationMs: 100 })
  })

  it('ignores message kinds outside the seam', () => {
    const m = new MessageMapper({ ...OPTS, systemPromptAppend: '', now: clock() })
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
