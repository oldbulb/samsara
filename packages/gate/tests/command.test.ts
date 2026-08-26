// CommandGatePolicy: a gate as a subprocess, held to the stdin/stdout JSON
// contract (examples/gates/README.md). The fixture is a node script; the
// shipped Python example runs through the same harness when python3 is on PATH.
// The child runs asynchronously: a slow gate must leave the host event loop free.

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Context } from '@oldbulb/samsara-kernel'
import {
  CommandGatePolicy,
  GateCommandError,
  GateRegistry,
  gateDefault,
  gatePolicy,
  parseGateJudgement,
  type CompareRequest,
  type ScoredAttempt,
} from '../src/index.ts'
import * as pluginCommand from '../src/plugin-command.ts'

const FIXTURE = fileURLToPath(new URL('./fixtures/echo-gate.mjs', import.meta.url))
const KEEP_BETTER = fileURLToPath(new URL('../../../examples/gates/keep_better.py', import.meta.url))

function arm(id: string, values: number[]): ScoredAttempt[] {
  return values.map((value, i) => ({
    attemptId: `${id}-${i}`, challengerId: id, taskId: `t${i}`, entityKey: `e${i}`, sample: 0, status: 'COMPLETED',
    metric: 'm', value, kind: 'reality', cost: { usd: 1, tokens: 100 },
  }))
}

function request(challenger: number[], champion: number[]): CompareRequest {
  return {
    challenger: arm('a', challenger), champion: arm('b', champion), tier: 'holdin', primaryMetric: 'm',
    noiseFloor: { sdPaired: 0.1, nReruns: 3 }, policy: gatePolicy({ nEffFloor: 2 }), round: { k: 2, index: 0 }, seed: 1,
  }
}

const fixture = (mode?: string, extra: Partial<ConstructorParameters<typeof CommandGatePolicy>[0]> = {}) =>
  new CommandGatePolicy({ command: process.execPath, args: mode ? [FIXTURE, mode] : [FIXTURE], name: 'echo', version: '1', ...extra })

const hasPython = await new Promise<boolean>(resolve => {
  const child = spawn('python3', ['--version'], { stdio: 'ignore' })
  child.on('error', () => resolve(false))
  child.on('close', status => resolve(status === 0))
})

describe('CommandGatePolicy', () => {
  it('promotes when the subprocess says so, with the full Compare', async () => {
    const j = await fixture().judge(request([1, 1, 1], [0, 0, 0]))
    expect(j.verdict).toBe('promote')
    expect(j.compare.mean).toBe(1)
    expect(j.compare.nEff).toBe(3)
    expect(j.compare.method).toBe('echo')
    expect(j.compare.perTask.map(d => d.taskId)).toEqual(['t0', 't1', 't2'])
  })

  it('holds when the mean delta is not positive', async () => {
    const j = await fixture().judge(request([0, 0, 1], [1, 0, 0]))
    expect(j.verdict).toBe('hold')
    expect(j.compare.mean).toBe(0)
  })

  it('is deterministic: the same request gives the same output', async () => {
    const req = request([0.2, 0.4, 0.9], [0.1, 0.5, 0.3])
    expect(await fixture().judge(req)).toEqual(await fixture().judge(req))
  })

  it('reports BAD_OUTPUT naming the field when stdout is not a GateJudgement', async () => {
    const err = await catchErr(() => fixture('garbage').judge(request([1], [0])))
    expect(err.code).toBe('BAD_OUTPUT')
    expect(err.message).toContain('compare')
  })

  it('reports EXIT with the child stderr on a non-zero exit', async () => {
    const err = await catchErr(() => fixture('exit').judge(request([1], [0])))
    expect(err.code).toBe('EXIT')
    expect(err.message).toContain('exited 3')
    expect(err.stderr).toContain('refusing on purpose')
  })

  it('reports TIMEOUT when the child does not answer in time', async () => {
    const err = await catchErr(() => fixture('sleep', { timeoutMs: 300 }).judge(request([1], [0])))
    expect(err.code).toBe('TIMEOUT')
  })

  it('leaves the event loop free while the child runs: a 100 ms timer keeps firing', async () => {
    let ticks = 0
    const timer = setInterval(() => { ticks++ }, 100)
    try {
      const j = await fixture('slow').judge(request([1], [0]))
      expect(j.verdict).toBe('promote')
    } finally {
      clearInterval(timer)
    }
    expect(ticks).toBeGreaterThanOrEqual(5)
  })

  it('passes a minimal explicit env, never the parent env (E5)', async () => {
    process.env['SAMSARA_TEST_LEAK'] = 'leaked'
    try {
      expect((await fixture('leak-env').judge(request([1], [0]))).compare.ruleFired).toBe('env:absent')
      expect((await fixture('leak-env', { env: { SAMSARA_TEST_LEAK: 'given' } }).judge(request([1], [0]))).compare.ruleFired).toBe('env:given')
    } finally {
      delete process.env['SAMSARA_TEST_LEAK']
    }
  })

  it('rejects a non-positive timeout', () => {
    expect(() => fixture(undefined, { timeoutMs: 0 })).toThrow(RangeError)
  })

  it('mounts on ctx.gate through the plugin and stamps gateMethod', async () => {
    const ctx = new Context()
    await ctx.plugin(GateRegistry)
    const fiber = await ctx.plugin(pluginCommand, { command: process.execPath, args: [FIXTURE], name: 'echo', version: '1' })
    expect(ctx.gate.current()?.name).toBe('echo')
    const row = await ctx.gate.judge(request([1, 1], [0, 0]))
    expect(row.gateMethod).toBe('echo@1')
    expect(row.verdict).toBe('promote')
    await fiber.dispose()
    expect(ctx.gate.current()).toBeUndefined()
  })

  it('can run under the registry with a direct provider instance', async () => {
    const ctx = new Context()
    await ctx.plugin(GateRegistry)
    ctx.gate.register(fixture())
    expect((await ctx.gate.judge(request([0], [1]))).verdict).toBe('hold')
  })
})

describe('parseGateJudgement', () => {
  it('names the offending field on a malformed document', () => {
    const doc = JSON.parse(JSON.stringify(gateDefault(request([1, 1, 1], [0, 0, 0]))))
    doc.compare.ci = [0, 'x']
    expect(() => parseGateJudgement(JSON.stringify(doc))).toThrow(/compare\.ci\[1\]/)
    expect(() => parseGateJudgement('{"verdict":"promote"}')).toThrow(/compare/)
    expect(() => parseGateJudgement('nope')).toThrow(/not JSON/)
  })

  it('accepts a serialised gate-default judgement', () => {
    const j = gateDefault(request([1, 1, 1], [0, 0, 0]))
    expect(parseGateJudgement(JSON.stringify(j))).toEqual(j)
  })

  it('rejects an unknown verdict', () => {
    const doc = JSON.parse(JSON.stringify(gateDefault(request([1, 1, 1], [0, 0, 0]))))
    doc.verdict = 'maybe'
    expect(() => parseGateJudgement(JSON.stringify(doc))).toThrow(/verdict/)
  })
})

describe('examples/gates/keep_better.py', () => {
  it.skipIf(!hasPython)('speaks the contract through CommandGatePolicy', async () => {
    const gate = new CommandGatePolicy({ command: 'python3', args: [KEEP_BETTER], name: 'keep-better', version: '0.1.0' })
    const up = await gate.judge(request([1, 1, 1], [0, 0, 0]))
    expect(up.verdict).toBe('promote')
    expect(up.compare.method).toBe('keep-better')
    expect(up.compare.ci).toEqual([1, 1])
    expect(up.compare.nEff).toBe(3)
    expect(up.compare.replicates).toBe(1)
    expect(up.compare.counts.paired).toBe(3)
    expect(up.compare.holm.adjustedAlpha).toBeCloseTo(0.025)
    expect(up.compare.mde).toBeCloseTo(gateDefault(request([1, 1, 1], [0, 0, 0])).compare.mde, 4)

    const down = await gate.judge(request([0, 0, 0], [1, 1, 1]))
    expect(down.verdict).toBe('hold')

    const empty = await gate.judge(request([], []))
    expect(empty.verdict).toBe('invalid')
    expect(empty.compare.ruleFired).toBe('type:no-data')
  })
  if (!hasPython) it('is skipped: python3 is not on PATH', () => {})
})

async function catchErr(fn: () => Promise<unknown>): Promise<GateCommandError> {
  try {
    await fn()
  } catch (e) {
    expect(e).toBeInstanceOf(GateCommandError)
    return e as GateCommandError
  }
  throw new Error('expected a GateCommandError')
}
