import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { Context, type SessionEvent } from '@oldbulb/samsara-kernel'
import { canonicalJson, type NotebookRow } from '@oldbulb/samsara-ledger'
import { NotebookMapper, apply, notebookId, type NotebookSession } from '../src/notebook.ts'

const sha = (v: unknown) => createHash('sha256').update(canonicalJson(v)).digest('hex')

/** A session as the notebook sees it: an id and the latest route. */
function session(id = 'sess-1', route: { provider: string; model: string } | undefined = { provider: 'p', model: 'm' }): NotebookSession {
  return { id, requestContext: () => route } as unknown as NotebookSession
}

let seq = 0
function event(type: string, data: unknown, at = seq++): SessionEvent {
  return { type, seq: at, time: 1_700_000_000_000 + at, data } as unknown as SessionEvent
}
const call = (name: string, args: unknown, callId = `c-${seq}`, at?: number) => event('tool/call', { turn: 1, step: 1, callId, name, arguments: typeof args === 'string' ? args : JSON.stringify(args) }, at)
const result = (callId: string, content: unknown[], failure?: { isError?: boolean; error?: { name: string; code: string } }) =>
  event('tool/result', {
    turn: 1, step: 1,
    message: { role: 'user', content: [{ type: 'tool-result', toolCallId: callId, content, ...(failure?.isError ? { isError: true } : {}) }] },
    ...(failure?.error ? { error: failure.error } : {}),
  })
const asked = (id: string, toolName: string, callId: string | undefined, reason: string | undefined) => event('approval/asked', { id, toolName, ...(callId !== undefined ? { callId } : {}), ...(reason !== undefined ? { reason } : {}) })
const decided = (id: string, outcome: string) => event('approval/decided', { id, outcome })
const run = (name: string, args: string | undefined, commandId = `k-${seq}`) => event('command/run', { commandId, name, args, source: { kind: 'user' } })
const done = (commandId: string, kind: 'success' | 'error', text?: string) => event('command/done', { commandId, kind, text })

describe('NotebookMapper', () => {
  it('mirrors a samsara_* call and its result with content addresses, never the content', () => {
    const m = new NotebookMapper()
    const s = session()
    const args = { round_id: 'r1', reruns: 3 }
    const c = call('samsara_calibrate', args, 'c1')
    const row = m.map(s, c)!
    expect(row).toMatchObject({ session_id: 'sess-1', seq: c.seq, kind: 'tool/call', name: 'samsara_calibrate', args_sha: sha(args), round_id: 'r1', operator: { provider: 'p', model: 'm' } })
    expect(row.at).toBe(new Date(c.time).toISOString())
    expect(row.result_sha).toBeUndefined()
    expect(row.error).toBeUndefined()
    expect(JSON.stringify(row)).not.toContain('reruns')

    const content = [{ type: 'text', text: JSON.stringify({ ok: true, experiment_id: 'e1' }) }]
    const r = m.map(s, result('c1', content))!
    expect(r).toMatchObject({ kind: 'tool/result', name: 'samsara_calibrate', args_sha: sha(args), result_sha: sha(content), round_id: 'r1', experiment_id: 'e1' })
    expect(r.error).toBeUndefined()
    expect(r.id).not.toBe(row.id)
    // a result without its call is nothing the notebook can name
    expect(m.map(s, result('c1', content))).toBeUndefined()
  })

  it('binds the id to the content, not the position alone: a seq reused after a crash-tail loss names a new row', () => {
    const m = new NotebookMapper()
    const s = session()
    const first = m.map(s, call('samsara_status', { pack: 'a' }, 'c1', 40))!
    const other = m.map(s, call('samsara_status', { pack: 'b' }, 'c2', 40))!
    expect([first.seq, other.seq]).toEqual([40, 40])
    expect(other.id).not.toBe(first.id)
    expect(first.id).toBe(notebookId(first))
    // the same event again is the same row
    expect(m.map(s, call('samsara_status', { pack: 'a' }, 'c3', 40))!.id).toBe(first.id)
    // a result at a call's position (never in one log, but across two logs it can be) is another row
    const r = m.map(s, event('tool/result', { turn: 1, step: 1, message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [] }] } }, 40))!
    expect(r.id).not.toBe(first.id)
  })

  it('records a failed result: the harness code for a name no tool answers to, ERROR for a tool that threw', () => {
    const m = new NotebookMapper()
    const s = session()
    m.map(s, call('samsara_nope', {}, 'c1'))
    const unknown = m.map(s, result('c1', [{ type: 'text', text: 'Error: unknown tool "samsara_nope"' }], { isError: true, error: { name: 'ToolNotFoundError', code: 'UNKNOWN_TOOL' } }))!
    expect(unknown).toMatchObject({ kind: 'tool/result', name: 'samsara_nope', error: 'UNKNOWN_TOOL' })
    m.map(s, call('samsara_status', {}, 'c2'))
    const threw = m.map(s, result('c2', [{ type: 'text', text: 'Error: boom' }], { isError: true }))!
    expect(threw.error).toBe('ERROR')
    m.map(s, call('samsara_status', {}, 'c3'))
    const aborted = m.map(s, result('c3', [{ type: 'text', text: 'Error: tool call aborted before dispatch' }], { isError: true, error: { name: 'AbortError', code: 'TOOL_ABORTED_BEFORE_DISPATCH' } }))!
    expect(aborted.error).toBe('TOOL_ABORTED_BEFORE_DISPATCH')
    expect(unknown.id).not.toBe(threw.id)
  })

  it('mirrors the approval a samsara_* tool asked and its answer, under the call\'s round and experiment', () => {
    const m = new NotebookMapper()
    const s = session()
    m.map(s, call('samsara_campaign_start', { experiment_id: 'e1', rounds: 2 }, 'c1'))
    const reason = '2 round(s) on experiment e1: cost unknown (20 attempts)'
    const a = m.map(s, asked('ap-1', 'samsara_campaign_start', 'c1', reason))!
    expect(a).toMatchObject({ kind: 'approval/asked', name: 'samsara_campaign_start', args_sha: sha(reason), experiment_id: 'e1', operator: { provider: 'p', model: 'm' } })
    expect(a.result_sha).toBeUndefined()
    expect(JSON.stringify(a)).not.toContain('attempts')
    const d = m.map(s, decided('ap-1', 'rejected'))!
    expect(d).toMatchObject({ kind: 'approval/decided', name: 'samsara_campaign_start', args_sha: sha(reason), result_sha: sha('rejected'), experiment_id: 'e1' })
    expect(d.id).not.toBe(a.id)
    // once answered, an id is spent; an answer to nothing asked is nothing
    expect(m.map(s, decided('ap-1', 'allowed-once'))).toBeUndefined()
    expect(m.map(s, decided('ap-9', 'allowed-once'))).toBeUndefined()
    // asked without a call or a reason still records the question
    expect(m.map(s, asked('ap-2', 'samsara_calibrate', undefined, undefined))).toMatchObject({ kind: 'approval/asked', name: 'samsara_calibrate', args_sha: sha('') })
    // another tool's approval is not the notebook's
    expect(m.map(s, asked('ap-3', 'bash', 'c7', 'rm -rf'))).toBeUndefined()
    expect(m.map(s, decided('ap-3', 'allowed-once'))).toBeUndefined()
  })

  it('ignores other tools and other commands', () => {
    const m = new NotebookMapper()
    const s = session()
    expect(m.map(s, call('bash', { cmd: 'ls' }, 'c2'))).toBeUndefined()
    expect(m.map(s, result('c2', [{ type: 'text', text: 'x' }]))).toBeUndefined()
    expect(m.map(s, run('goal', 'set x', 'k2'))).toBeUndefined()
    expect(m.map(s, done('k2', 'success'))).toBeUndefined()
    expect(m.map(s, event('assistant/message', { turn: 1, step: 1, message: {} }))).toBeUndefined()
  })

  it('mirrors the samsara command run and done', () => {
    const m = new NotebookMapper()
    const s = session('sess-2', undefined)
    const r = m.map(s, run('samsara', 'approve abc --wait 30', 'k1'))!
    expect(r).toMatchObject({ kind: 'command/run', name: 'samsara', args_sha: sha('approve abc --wait 30'), operator: {} })
    const d = m.map(s, done('k1', 'success', 'served'))!
    expect(d).toMatchObject({ kind: 'command/done', name: 'samsara', args_sha: sha('approve abc --wait 30'), result_sha: sha({ kind: 'success', text: 'served' }) })
    expect(m.map(s, run('samsara', undefined, 'k3'))!.args_sha).toBe(sha(''))
  })

  it('hashes unparsable arguments as the raw string and keys calls per session', () => {
    const m = new NotebookMapper()
    expect(m.map(session('a'), call('samsara_status', '{not json', 'c9'))!.args_sha).toBe(sha('{not json'))
    // the same callId in another session is another call
    expect(m.map(session('b'), result('c9', []))).toBeUndefined()
    expect(m.map(session('a'), result('c9', []))!.kind).toBe('tool/result')
  })
})

describe('workbench-notebook plugin', () => {
  it('records rows through ctx.ledger for session/event', async () => {
    const rows: NotebookRow[] = []
    const ctx = new Context()
    ctx.provide('ledger', { recordNotebook: async (row: NotebookRow) => { rows.push(row); return row.id } })
    await ctx.plugin({ name: 'workbench-notebook', inject: ['ledger'], apply })
    const s = session()
    ctx.emit('session/event', s as never, call('samsara_status', {}, 'c1') as never)
    ctx.emit('session/event', s as never, call('bash', {}, 'c2') as never)
    ctx.emit('session/event', s as never, asked('ap-1', 'samsara_status', 'c1', 'free') as never)
    ctx.emit('session/event', s as never, decided('ap-1', 'allowed-once') as never)
    ctx.emit('session/event', s as never, result('c1', [{ type: 'text', text: '{}' }]) as never)
    await new Promise((r) => setTimeout(r, 0))
    expect(rows.map((r) => r.kind)).toEqual(['tool/call', 'approval/asked', 'approval/decided', 'tool/result'])
    expect(rows.every((r) => r.name === 'samsara_status')).toBe(true)
  })
})
