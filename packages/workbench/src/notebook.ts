// workbench-notebook: mirrors the decision-relevant session events of an
// operator conversation into the ledger's `notebook` table. A call to or a
// result of a framework tool (`samsara_*`), the spend approval it asked and
// its answer, and the run/done of the `samsara` command become one row each,
// carrying content addresses of what was said (never the content) and the
// route the session ran on. The listener is the post-commit `session/event`
// feed, which runs ahead of the session log's flush: a row's id binds the
// content as well as the position, so a seq reused after a crash-tail loss
// names a new row instead of adopting the old one. Re-recording an id is a
// no-op on the ledger side.

import type { Context, Session, SessionEvent } from '@oldbulb/samsara-kernel'
import { canonicalJson, keyOf, sha256, type NotebookRow } from '@oldbulb/samsara-ledger'

export const name = 'workbench-notebook'
export const inject = ['ledger']

/** The tools the notebook mirrors: every framework tool carries this prefix. */
export const TOOL_PREFIX = 'samsara_'
/** The command the notebook mirrors. */
export const COMMAND_NAME = 'samsara'

/** The slice of a session the notebook reads (structural, so fakes compose). */
export type NotebookSession = Pick<Session, 'id' | 'requestContext'>

/** The event fields the notebook reads, over the kinds it mirrors. */
interface RawEvent {
  type: string
  seq: number
  time: number
  data: unknown
}
interface ToolCallData { callId: string; name: string; arguments: string }
interface ToolResultData { message: { content: { type: string; toolCallId?: string; content?: unknown; isError?: boolean }[] }; error?: { name: string; code: string } }
interface ApprovalAskedData { id: string; toolName: string; callId?: string; reason?: string }
interface ApprovalDecidedData { id: string; outcome: string }
interface CommandRunData { commandId: string; name: string; args?: string }
interface CommandDoneData { commandId: string; kind: string; text?: string }

/** What a call leaves behind for its result: the name and the addresses the result row repeats. */
interface Pending {
  name: string
  args_sha: string
  round_id?: string | undefined
  experiment_id?: string | undefined
}

/** The row's id: its session, its position, and the content it addresses. */
export function notebookId(row: Pick<NotebookRow, 'session_id' | 'seq' | 'kind' | 'args_sha' | 'result_sha'>): string {
  return keyOf(row.session_id, row.seq, row.kind, row.args_sha, row.result_sha ?? '')
}

/** Folds session events into notebook rows; one per session log, keyed by call/approval/command id. */
export class NotebookMapper {
  private readonly pending = new Map<string, Pending>()

  /** The row for `event`, or undefined when the event is not one the notebook mirrors. */
  map(session: NotebookSession, event: SessionEvent): NotebookRow | undefined {
    const raw = event as unknown as RawEvent
    const partial = this.fold(session, raw)
    if (!partial) return undefined
    const route = session.requestContext()
    const session_id = String(session.id)
    const row = {
      session_id,
      seq: raw.seq,
      at: new Date(raw.time).toISOString(),
      operator: route ? { provider: route.provider, model: route.model } : {},
      ...partial,
    }
    return { id: notebookId(row), ...row }
  }

  private fold(session: NotebookSession, event: RawEvent): Pick<NotebookRow, 'kind' | 'name' | 'args_sha' | 'result_sha' | 'error' | 'round_id' | 'experiment_id'> | undefined {
    const key = (id: string) => `${String(session.id)}\0${id}`
    switch (event.type) {
      case 'tool/call': {
        const data = event.data as ToolCallData
        if (!data.name.startsWith(TOOL_PREFIX)) return undefined
        const args = parseJson(data.arguments) ?? data.arguments
        const entry: Pending = { name: data.name, args_sha: sha256(canonicalJson(args)), ...idsOf(args) }
        this.pending.set(key(data.callId), entry)
        return { kind: 'tool/call', ...entry }
      }
      case 'tool/result': {
        const data = event.data as ToolResultData
        const block = data.message.content.find((b) => b.type === 'tool-result')
        if (!block?.toolCallId) return undefined
        const entry = this.pending.get(key(block.toolCallId))
        if (!entry) return undefined
        this.pending.delete(key(block.toolCallId))
        const content = block.content ?? []
        const error = data.error?.code ?? (block.isError ? 'ERROR' : undefined)
        return { kind: 'tool/result', ...entry, ...idsOf(resultValue(content)), result_sha: sha256(canonicalJson(content)), ...(error !== undefined ? { error } : {}) }
      }
      case 'approval/asked': {
        const data = event.data as ApprovalAskedData
        if (!data.toolName.startsWith(TOOL_PREFIX)) return undefined
        const call = data.callId !== undefined ? this.pending.get(key(data.callId)) : undefined
        const entry: Pending = { name: data.toolName, args_sha: sha256(canonicalJson(data.reason ?? '')), ...(call ? idsOf(call) : {}) }
        this.pending.set(key(data.id), entry)
        return { kind: 'approval/asked', ...entry }
      }
      case 'approval/decided': {
        const data = event.data as ApprovalDecidedData
        const entry = this.pending.get(key(data.id))
        if (!entry) return undefined
        this.pending.delete(key(data.id))
        return { kind: 'approval/decided', ...entry, result_sha: sha256(canonicalJson(data.outcome)) }
      }
      case 'command/run': {
        const data = event.data as CommandRunData
        if (data.name !== COMMAND_NAME) return undefined
        const args = data.args ?? ''
        const entry: Pending = { name: data.name, args_sha: sha256(canonicalJson(args)) }
        this.pending.set(key(data.commandId), entry)
        return { kind: 'command/run', ...entry }
      }
      case 'command/done': {
        const data = event.data as CommandDoneData
        const entry = this.pending.get(key(data.commandId))
        if (!entry) return undefined
        this.pending.delete(key(data.commandId))
        return { kind: 'command/done', ...entry, result_sha: sha256(canonicalJson({ kind: data.kind, text: data.text })) }
      }
      default:
        return undefined
    }
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** The round and experiment a value names, when it is an object with those string fields. */
function idsOf(value: unknown): Pick<NotebookRow, 'round_id' | 'experiment_id'> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const { round_id, experiment_id } = value as Record<string, unknown>
  return {
    ...(typeof round_id === 'string' ? { round_id } : {}),
    ...(typeof experiment_id === 'string' ? { experiment_id } : {}),
  }
}

/** A tool result's canonical value: the first text block that parses as JSON, else nothing. */
function resultValue(content: unknown): unknown {
  if (!Array.isArray(content)) return undefined
  for (const block of content) {
    if (block && typeof block === 'object' && (block as { type?: string }).type === 'text' && typeof (block as { text?: unknown }).text === 'string') {
      return parseJson((block as { text: string }).text)
    }
  }
  return undefined
}

export function apply(ctx: Context): void {
  const mapper = new NotebookMapper()
  const log = ctx.logger(name)
  ctx.on('session/event', (session, event) => {
    const row = mapper.map(session, event)
    if (!row) return
    void ctx.ledger.recordNotebook(row).catch((e: unknown) => {
      log.warn('notebook row %s (%s %s) not recorded: %s', row.id, row.kind, row.name, e instanceof Error ? e.message : String(e))
    })
  })
}
