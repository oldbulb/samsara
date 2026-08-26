// `gate bench` on the recorded fixture (83 tasks x 3 same-config reruns). The
// task list is derived from the fixture's task ids (entity = the id's last
// segment, as the pack that recorded it keys entities), written to a temp file
// so the command reads two files exactly as it would from the command line.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GATE_DEFAULT_NAME, GATE_DEFAULT_VERSION } from '@oldbulb/samsara-gate'
import { CATALOG } from '@oldbulb/samsara-gate-catalog'
import { benchGatesOf, benchRun, formatBench, readJsonl } from '../src/bench.ts'
import { runProgram, type SamsaraRunValues } from '../src/startup.ts'

const ATTEMPTS = resolve(import.meta.dirname, '..', '..', '..', 'tests', 'fixtures', 'runs', 'run-dsh-noise-closed.attempts.jsonl')

function tasksFile(): string {
  const rows = readJsonl<{ task_id: string; scores: { metric: string; kind: string }[] }>(ATTEMPTS)
  const ids = [...new Set(rows.map((r) => r.task_id))]
  const dir = mkdtempSync(join(tmpdir(), 'samsara-bench-'))
  const file = join(dir, 'tasks.jsonl')
  writeFileSync(file, ids.map((id) => JSON.stringify({ task_id: id, entity_key: id.split('/').pop(), stratum: id.split('/')[0] })).join('\n') + '\n')
  return file
}

const DEFAULT = `${GATE_DEFAULT_NAME}@${GATE_DEFAULT_VERSION}`

describe('gate bench', () => {
  const tasks = tasksFile()
  const metric = readJsonl<{ scores: { metric: string; kind: string }[] }>(ATTEMPTS)[0]!.scores.find((s) => s.kind === 'reality')!.metric

  it('builds the gate list from presets, catalog names and a command', () => {
    expect(benchGatesOf({}).map((g) => g.name)).toEqual([GATE_DEFAULT_NAME, ...CATALOG.map((g) => g.name)])
    const gates = benchGatesOf({ gates: ['default', 'fast', 'keep-better', 'miller@0.1.0'], gateCommand: './gates/mine.py' })
    expect(gates.map((g) => `${g.name}@${g.version}`)).toEqual([DEFAULT, 'gate-fast@0.1.0', 'keep-better@0.1.0', 'miller@0.1.0', 'mine.py@command'])
    expect(() => benchGatesOf({ gates: ['nope'] })).toThrow(/unknown gate policy "nope"/)
  })

  it('reads the two files, runs the bench and prints the table', async () => {
    const out = join(tmpdir(), `samsara-bench-${process.pid}.json`)
    const r = await benchRun({ attempts: ATTEMPTS, tasks, metric, gates: ['default', 'keep-better', 'miller'], resamples: 25, seed: 1, out })
    expect(r).toMatchObject({ metric, tasks: 83, entities: 43, reruns: 3, rows: 249, excluded: 0, resamples: 25, seed: 1, gates: [DEFAULT, 'keep-better@0.1.0', 'miller@0.1.0'] })
    expect(r.scenarios).toEqual([{ name: 'null', effect: null }])
    expect(r.cells.map((c) => [c.gate, c.scenario])).toEqual([[DEFAULT, 'null'], ['keep-better@0.1.0', 'null'], ['miller@0.1.0', 'null']])
    const cell = (gate: string) => r.cells.find((c) => c.gate === gate)!
    expect(cell('keep-better@0.1.0').rate).toBeGreaterThanOrEqual(0.3)
    expect(cell('keep-better@0.1.0').rate).toBeLessThanOrEqual(0.7)
    expect(cell('miller@0.1.0').rate).toBeLessThan(0.2)
    expect(cell(DEFAULT).rate).toBeLessThan(0.3)
    expect(r.exact.filter((e) => e.gate === 'keep-better@0.1.0' && e.verdict === 'promote')).toHaveLength(3)
    const md = formatBench(r)
    expect(md).toContain(`# bench: ${metric}`)
    expect(md).toContain('83 tasks, 43 entities, 3 reruns')
    expect(md).toContain('| gate | null |')
    expect(md).toContain(`| ${DEFAULT} |`)
    expect(md).toContain('| keep-better@0.1.0 |')
    expect(md).toContain('## Exact decisions on the real ordered pairs')
    // the same request is deterministic, so the JSON the command writes round-trips to the result
    expect(JSON.parse(JSON.stringify(r))).toEqual(await benchRun({ attempts: ATTEMPTS, tasks, metric, gates: ['default', 'keep-better', 'miller'], resamples: 25, seed: 1 }))
    expect(existsSyncJson(out)).toBe(false)
  })

  it('reports an empty attempts file as an error, not a RangeError', async () => {
    const empty = join(mkdtempSync(join(tmpdir(), 'samsara-bench-')), 'attempts.jsonl')
    writeFileSync(empty, '')
    await expect(benchRun({ attempts: empty, tasks, metric, gates: ['default'] })).rejects.toThrow(/^bench: no attempt rows$/)
  })

  it('reads a file with re-recorded attempts as attemptId -> last row', async () => {
    const doubled = join(mkdtempSync(join(tmpdir(), 'samsara-bench-')), 'attempts.jsonl')
    const text = readFileSync(ATTEMPTS, 'utf8')
    writeFileSync(doubled, text + text)
    const r = await benchRun({ attempts: doubled, tasks, metric, gates: ['keep-better'], resamples: 2, seed: 1 })
    expect(r).toEqual(await benchRun({ attempts: ATTEMPTS, tasks, metric, gates: ['keep-better'], resamples: 2, seed: 1 }))
    expect(r).toMatchObject({ reruns: 3, rows: 249 })
  })

  it('refuses --resamples 0 with a named error', async () => {
    await expect(benchRun({ attempts: ATTEMPTS, tasks, metric, gates: ['default'], resamples: 0 })).rejects.toThrow(/^bench: resamples must be a positive integer, got 0$/)
  })

  it('hands sesoi and the n_eff floor to every policy', async () => {
    const r = await benchRun({ attempts: ATTEMPTS, tasks, metric, gates: ['default'], resamples: 2, sesoi: 0.5, nEffFloor: 100 })
    // 43 entities under a floor of 100: gate-default's rule 3 holds every exact pair as underpowered
    expect(r.exact.map((e) => e.verdict)).toEqual(Array(6).fill('hold:underpowered'))
  })
})

/** `benchRun` itself never writes; the plugin does (index.ts). */
function existsSyncJson(file: string): boolean {
  try {
    readFileSync(file)
    return true
  } catch {
    return false
  }
}

describe('gate bench command line', () => {
  function parse(argv: string[]): { values?: SamsaraRunValues; error?: string } {
    let values: SamsaraRunValues | undefined
    const program = runProgram((v) => { values = v })
    const quiet = (c: typeof program) => { c.exitOverride().configureOutput({ writeErr: () => {}, writeOut: () => {} }); c.commands.forEach(quiet) }
    quiet(program)
    try {
      program.parse(argv, { from: 'user' })
    } catch (e) {
      return { error: (e as Error).message }
    }
    return values ? { values } : {}
  }

  it('parses gate bench with its gate list and rejects an unknown gate', () => {
    const { values } = parse(['gate', 'bench', '--attempts', '/a.jsonl', '--tasks', '/t.jsonl', '--metric', 'm', '--gates', 'default, keep-better,miller', '--gate-command', './g.py', '--resamples', '10', '--seed', '3', '--sesoi', '0.05', '--n-eff-floor', '20', '--out', '/b.json'])
    expect(values).toEqual({ command: 'gate-bench', attempts: '/a.jsonl', tasks: '/t.jsonl', metric: 'm', gates: ['default', 'keep-better', 'miller'], gateCommand: './g.py', resamples: 10, seed: 3, sesoi: 0.05, nEffFloor: 20, out: '/b.json' })
    expect(parse(['gate', 'bench', '--attempts', '/a', '--tasks', '/t', '--metric', 'm']).values).toEqual({ command: 'gate-bench', attempts: '/a', tasks: '/t', metric: 'm' })
    expect(parse(['gate', 'bench', '--attempts', '/a', '--tasks', '/t', '--metric', 'm', '--gates', 'nope']).error).toMatch(/--gates must be one of .*keep-better/)
    expect(parse(['gate', 'bench', '--attempts', '/a', '--tasks', '/t']).error).toMatch(/--metric/)
  })
})
