// Hand-written SDKMessage stream in the shape of @anthropic-ai/claude-agent-sdk 0.3.220.
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'

export const SESSION = '11111111-1111-4111-8111-111111111111'

function usage(input: number, output: number) {
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: 10,
    cache_creation_input_tokens: 5,
    server_tool_use: null,
    service_tier: null,
    cache_creation: null,
    inference_geo: null,
    iterations: null,
    speed: null,
  }
}

export function initMessage(tools = ['Bash', 'Read', 'Write']): SDKMessage {
  return {
    type: 'system',
    subtype: 'init',
    apiKeySource: 'ANTHROPIC_API_KEY',
    claude_code_version: '2.0.0',
    cwd: '/work',
    tools,
    mcp_servers: [],
    model: 'm',
    permissionMode: 'bypassPermissions',
    slash_commands: [],
    output_style: 'default',
    skills: [],
    plugins: [],
    uuid: '22222222-2222-4222-8222-222222222222',
    session_id: SESSION,
  } as unknown as SDKMessage
}

export function assistantToolUse(id: string, name: string, input: unknown): SDKMessage {
  return {
    type: 'assistant',
    parent_tool_use_id: null,
    uuid: '33333333-3333-4333-8333-333333333333',
    session_id: SESSION,
    message: {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'm',
      content: [{ type: 'text', text: 'Let me look.' }, { type: 'tool_use', id, name, input }],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: usage(100, 20),
    },
  } as unknown as SDKMessage
}

export function toolResult(id: string, content: string, isError = false): SDKMessage {
  return {
    type: 'user',
    parent_tool_use_id: null,
    session_id: SESSION,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] },
  } as unknown as SDKMessage
}

export function assistantText(text: string): SDKMessage {
  return {
    type: 'assistant',
    parent_tool_use_id: null,
    uuid: '44444444-4444-4444-8444-444444444444',
    session_id: SESSION,
    message: {
      id: 'msg_2',
      type: 'message',
      role: 'assistant',
      model: 'm',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: usage(200, 40),
    },
  } as unknown as SDKMessage
}

export function resultMessage(subtype: string, text = 'done'): SDKMessage {
  const base = {
    type: 'result',
    subtype,
    duration_ms: 1000,
    duration_api_ms: 800,
    is_error: subtype !== 'success',
    num_turns: 2,
    stop_reason: 'end_turn',
    total_cost_usd: 0.0123,
    usage: usage(300, 60),
    modelUsage: {},
    permission_denials: [],
    uuid: '55555555-5555-4555-8555-555555555555',
    session_id: SESSION,
  }
  return (subtype === 'success' ? { ...base, result: text } : { ...base, errors: ['x'] }) as unknown as SDKMessage
}

export function stream(): SDKMessage[] {
  return [
    initMessage(),
    assistantToolUse('toolu_1', 'Bash', { command: 'ls' }),
    toolResult('toolu_1', 'a\nb'),
    assistantText('All done.'),
    resultMessage('success', 'All done.'),
  ]
}
