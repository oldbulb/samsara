import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { exportRun, findEventFiles } from '../src/export.ts'
import { runProgram, type SamsaraRunValues } from '../src/startup.ts'

function runDir(): string {
  const dir = mkdtempSync(join(process.env['TMPDIR'] ?? tmpdir(), 'samsara-export-'))
  const T0 = 1_700_000_000_000
  const mk = (sub: string, id: string, loop: string) => {
    const d = join(dir, sub, 'attempts', id)
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'events.jsonl'), [
      JSON.stringify({ t: 'started', at: T0, native: { kind: loop, id } }),
      JSON.stringify({ t: 'tool_call', at: T0 + 5, callId: 'c', name: 'read', argsSha256: 'a'.repeat(64), argsBytes: 1 }),
      JSON.stringify({ t: 'tool_result', at: T0 + 9, callId: 'c', isError: false, bytes: 2 }),
      JSON.stringify({ t: 'assistant', at: T0 + 10, turn: 0, textBytes: 1, usage: { inputTokens: 1, outputTokens: 2 } }),
      JSON.stringify({ t: 'finished', at: T0 + 20, status: 'COMPLETED', stopReason: 'completed', usage: { inputTokens: 1, outputTokens: 2 }, cost: { source: 'unknown' }, turns: 1, toolCalls: 1, artifacts: [] }),
    ].join('\n') + '\n')
    writeFileSync(join(dir, sub, 'attempts.jsonl'), JSON.stringify({ attemptId: id, task_id: 't', loop, facts_sha: 'f'.repeat(64) }) + '\n')
  }
  mk('.', 'run-1-t-0', 'null')
  mk('nested', 'run-2-t-0', 'dsh')
  mkdirSync(join(dir, 'attempts', 'run-1-t-0', 'src'))
  writeFileSync(join(dir, 'attempts', 'run-1-t-0', 'src', 'events.jsonl'), 'not an attempt\n')
  return dir
}

describe('samsara export', () => {
  it('finds every attempts/<id>/events.jsonl and exports one trace per attempt with row attributes', () => {
    const dir = runDir()
    expect(findEventFiles(dir).map((f) => f.slice(dir.length + 1))).toEqual(['attempts/run-1-t-0/events.jsonl', 'nested/attempts/run-2-t-0/events.jsonl'])
    const doc = exportRun({ run: dir, challengerId: 'ch', tier: 'holdin', model: 'm' })
    expect(doc.attempts).toBe(2)
    expect(doc.spans).toBe(6)
    const spans = doc.resourceSpans[0]!.scopeSpans[0]!.spans
    expect(new Set(spans.map((s) => s.traceId)).size).toBe(2)
    const roots = spans.filter((s) => !s.parentSpanId)
    expect(roots.map((r) => r.name)).toEqual(['invoke_agent null', 'invoke_agent dsh'])
    const a = (s: typeof roots[number], k: string) => (s.attributes.find((x) => x.key === k)?.value as { stringValue?: string } | undefined)?.stringValue
    expect(a(roots[1]!, 'samsara.facts_sha')).toBe('f'.repeat(64))
    expect(a(roots[1]!, 'samsara.challenger_id')).toBe('ch')
    expect(a(roots[1]!, 'samsara.tier')).toBe('holdin')
    expect(a(roots[1]!, 'gen_ai.request.model')).toBe('m')
    expect(JSON.parse(JSON.stringify(doc.resourceSpans))).toEqual(doc.resourceSpans)
    expect(() => exportRun({ run: join(dir, 'missing') })).toThrow(/not found/)
  })
  it('parses the export subcommand', () => {
    let values: SamsaraRunValues | undefined
    const program = runProgram((v) => { values = v })
    const quiet = (c: typeof program) => { c.exitOverride().configureOutput({ writeErr: () => {}, writeOut: () => {} }); c.commands.forEach(quiet) }
    quiet(program)
    program.parse(['export', '--run', '/r', '--format', 'otlp-json', '--out', '/o.json', '--tier', 'smoke'], { from: 'user' })
    expect(values).toEqual({ command: 'export', run: '/r', format: 'otlp-json', out: '/o.json', tier: 'smoke' })
    expect(() => program.parse(['export', '--run', '/r', '--format', 'csv', '--out', '/o'], { from: 'user' })).toThrow(/--format must be otlp-json/)
  })
})
