// Session log → LoopEvent mapping (docs/design/loops.md "Event mapping per loop",
// dsh row). Pure: feed it SessionEvents in order, collect LoopEvents. The
// provider owns the `finished` event because it must wait for whenIdle + flush
// first; `finish()` builds it from what the mapper has seen plus the limits.

import { createHash } from 'node:crypto'
import type { SessionEvent, ContentBlock } from '@samsara/kernel'
import type { HarnessFacts, LoopEvent, TokenUsage } from '@samsara/loops'
import { addUsage, type Limits } from './limits.ts'

type Finished = Extract<LoopEvent, { t: 'finished' }>

export interface MapperOptions {
  /** Name of the submit tool: its successful call becomes `output{source:'submit-tool'}`. */
  submitToolName: string
  /** Bytes of serialized arguments kept in `argsPreview`. */
  previewBytes?: number
  /** Name of a skill-reading tool (when the skill is not prompt-inline); its calls count as utilization. */
  skillToolName?: string
}

export interface EventMapper {
  /** Map one committed session event to zero or more loop events. */
  map(event: SessionEvent): LoopEvent[]
  readonly usage: TokenUsage
  readonly turns: number
  readonly toolCalls: number
  readonly submitted: boolean
  /** Calls of `skillToolName`. */
  readonly skillToolCalls: number
  /** The `turn/end` reason seen, if any. */
  readonly turnEnd: SessionEvent<'turn/end'>['data']['reason'] | undefined
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function textBytes(content: readonly ContentBlock[]): number {
  let n = 0
  for (const block of content) if (block.type === 'text') n += Buffer.byteLength(block.text)
  return n
}

export function createEventMapper(options: MapperOptions): EventMapper {
  const previewBytes = options.previewBytes ?? 256
  const calls = new Map<string, { name: string; at: number; args: string }>()
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 }
  let turns = 0
  let toolCalls = 0
  let submitted = false
  let skillToolCalls = 0
  let sawHeader = false
  let turnEnd: EventMapper['turnEnd']

  return {
    get usage() {
      return usage
    },
    get turns() {
      return turns
    },
    get toolCalls() {
      return toolCalls
    },
    get submitted() {
      return submitted
    },
    get skillToolCalls() {
      return skillToolCalls
    },
    get turnEnd() {
      return turnEnd
    },
    map(event) {
      switch (event.type) {
        case 'request/header': {
          if (sawHeader) return []
          sawHeader = true
          const { header } = event.data
          const system = header.system ?? ''
          return [{
            t: 'system_prompt',
            at: event.time,
            sha256: sha256(system),
            bytes: Buffer.byteLength(system),
            tools: (header.tools ?? []).map((tool) => tool.name),
          }]
        }
        case 'tool/call': {
          const { callId, name, arguments: args } = event.data
          toolCalls += 1
          if (options.skillToolName !== undefined && name === options.skillToolName) skillToolCalls += 1
          calls.set(String(callId), { name, at: event.time, args })
          const out: LoopEvent = {
            t: 'tool_call',
            at: event.time,
            callId: String(callId),
            name,
            argsSha256: sha256(args),
            argsBytes: Buffer.byteLength(args),
          }
          if (args.length > 0) out.argsPreview = args.slice(0, previewBytes)
          return [out]
        }
        case 'tool/result': {
          const block = event.data.message.content[0]
          const callId = String(block.toolCallId)
          const isError = block.isError === true || event.data.error !== undefined
          const call = calls.get(callId)
          const result: LoopEvent = {
            t: 'tool_result',
            at: event.time,
            callId,
            isError,
            bytes: Buffer.byteLength(JSON.stringify(block.content)),
          }
          if (call) result.durationMs = Math.max(0, event.time - call.at)
          const out: LoopEvent[] = [result]
          if (call && call.name === options.submitToolName && !isError) {
            submitted = true
            let structured: unknown
            try {
              structured = JSON.parse(call.args)
            } catch {
              structured = undefined
            }
            const output: LoopEvent = { t: 'output', at: event.time, text: call.args, source: 'submit-tool' }
            if (structured !== undefined) output.structured = structured
            out.push(output)
          }
          return out
        }
        case 'assistant/message': {
          const { step, message } = event.data
          turns += 1
          usage = addUsage(usage, event.data.usage)
          const out: LoopEvent = { t: 'assistant', at: event.time, turn: step, textBytes: textBytes(message.content) }
          if (event.data.usage) out.usage = event.data.usage
          return [out]
        }
        case 'turn/end': {
          turnEnd = event.data.reason
          return []
        }
        default:
          return []
      }
    },
  }
}

export interface FinishInput {
  at: number
  mapper: Pick<EventMapper, 'usage' | 'turns' | 'toolCalls' | 'submitted' | 'turnEnd'> & Partial<Pick<EventMapper, 'skillToolCalls'>>
  limits: Pick<Limits, 'stop' | 'costUsd'>
  /** How the skill reached the model; default 'prompt-inline' (the provider's harness facts). */
  skillDelivery?: HarnessFacts['skillDelivery']
  /** A driver-level failure (agent creation/drive threw). */
  error?: unknown
}

/** Build the single `finished` event from the mapped log, the limits and the drive outcome. */
export function finish(input: FinishInput): Finished {
  const { mapper, limits } = input
  const usd = limits.costUsd(mapper.usage)
  const cost: Finished['cost'] = usd === undefined ? { source: 'unknown' } : { usd, source: 'price-table' }
  const skillUtilization: Finished['skillUtilization'] =
    (input.skillDelivery ?? 'prompt-inline') === 'prompt-inline' ? 'inline' : (mapper.skillToolCalls ?? 0) > 0 ? 1 : 0
  const base = { t: 'finished' as const, at: input.at, usage: mapper.usage, cost, turns: mapper.turns, toolCalls: mapper.toolCalls, artifacts: [], skillUtilization }

  if (input.error !== undefined) return { ...base, status: 'FAILED', stopReason: 'error' }

  switch (limits.stop) {
    case 'max_turns':
      return { ...base, status: 'TRUNCATED', stopReason: 'max_turns' }
    case 'timeout':
      return { ...base, status: 'TRUNCATED', stopReason: 'timeout' }
    case 'budget':
      return { ...base, status: 'TRUNCATED', stopReason: 'budget' }
    case 'aborted':
      return { ...base, status: 'ABORTED', stopReason: 'aborted' }
    case undefined:
      break
  }

  const kind = mapper.turnEnd?.kind
  switch (kind) {
    case 'completed':
    case undefined:
      // The loop ended by itself: COMPLETED only with a submit; a plain-text
      // ending is kept and scored as a failure (TRUNCATED/schema_failed).
      return mapper.submitted
        ? { ...base, status: 'COMPLETED', stopReason: 'completed' }
        : { ...base, status: 'TRUNCATED', stopReason: 'schema_failed' }
    case 'max-tokens':
      return { ...base, status: 'TRUNCATED', stopReason: 'budget' }
    case 'aborted':
      return { ...base, status: 'ABORTED', stopReason: 'aborted' }
    default:
      // error | blocked | interrupted | any plugin-extended reason
      return { ...base, status: 'FAILED', stopReason: 'error' }
  }
}
