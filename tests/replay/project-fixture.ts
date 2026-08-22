// Project a raw persisted dsh session log into the dsh-llm-replay fixture shape.
//
//   node tests/replay/project-fixture.ts tests/fixtures/replay/<scenario>/session.jsonl
//
// Reads <scenario>/session.jsonl (decompressed, as persisted by
// dsh-session-persistence-jsonl), writes <scenario>/session.replay.jsonl:
//   - the header line keeps every field; its `cwd` becomes `{{cwd}}`
//   - body rows lose the storage envelope (`seq`/`time`, `seq0`/`time0`)
//   - every string leaf has the recorded cwd replaced by `{{cwd}}`
// Nothing else changes: assistant/chunk, tool/call, request/header … are kept
// verbatim, so the replay script derived from the fixture is the recording.

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export const CWD_TOKEN = '{{cwd}}'

export function replaceStrings(value: unknown, from: string, to: string): unknown {
  if (typeof value === 'string') return value.split(from).join(to)
  if (Array.isArray(value)) return value.map((v) => replaceStrings(v, from, to))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, replaceStrings(v, from, to)]))
  }
  return value
}

/** Raw persisted log text → projected fixture text (trailing newline). */
export function projectSessionLog(raw: string): string {
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0)
  const header = JSON.parse(lines[0] ?? '') as Record<string, unknown>
  if (header['type'] !== 'session') throw new Error('session fixture must start with a session header')
  const cwd = header['cwd']
  if (typeof cwd !== 'string' || cwd.length === 0) throw new Error('session header has no cwd to tokenize')
  const out = [JSON.stringify({ ...header, cwd: CWD_TOKEN })]
  for (const line of lines.slice(1)) {
    const record = JSON.parse(line) as Record<string, unknown>
    delete record['seq']
    delete record['time']
    delete record['seq0']
    delete record['time0']
    out.push(JSON.stringify(replaceStrings(record, cwd, CWD_TOKEN)))
  }
  return out.join('\n') + '\n'
}

/** Fixture text → a concrete fixture with `{{cwd}}` replaced (string-level, JSON-safe). */
export function bindFixtureCwd(fixture: string, replacement: string): string {
  return fixture
    .split('\n')
    .map((line) => (line.length === 0 ? line : JSON.stringify(replaceStrings(JSON.parse(line), CWD_TOKEN, replacement))))
    .join('\n')
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const input = process.argv[2]
  if (!input) {
    console.error('usage: node tests/replay/project-fixture.ts <scenario>/session.jsonl')
    process.exit(2)
  }
  const source = resolve(input)
  const target = join(dirname(source), 'session.replay.jsonl')
  writeFileSync(target, projectSessionLog(readFileSync(source, 'utf8')))
  console.error(`wrote ${target}`)
}
