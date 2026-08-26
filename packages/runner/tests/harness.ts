// The runner's commands through a real Lifecycle over the lifecycle package's
// fakes (ledger, champion, gate, scopes) — built the way packages/lifecycle/tests
// builds the service — with this package's runSet mounted as the executor (as
// the plugin mounts it) and a loop that submits on every attempt, so champion
// and challenger score the same on the minipack.

import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { gateMethodOf, type CompareRequest, type GatePolicyProvider } from '@oldbulb/samsara-gate'
import { Context } from '@oldbulb/samsara-kernel'
import { Lifecycle, type Executor } from '@oldbulb/samsara-lifecycle'
import type { AttemptSpec, FinishedEvent, HarnessFacts, LoopEvent, LoopProvider, LoopRun } from '@oldbulb/samsara-loops'
import { FakeChampion, FakeGate, FakeLedger, FakeScopes } from '../../lifecycle/tests/fakes.ts'
import type { ChallengeDeps } from '../src/challenge.ts'
import { runSet, type Loops, type RouteConfig } from '../src/run.ts'

export { consent, sha, GATE_DEFAULT, DEFAULT, PACK as FIXTURE_PACK } from '../../lifecycle/tests/fakes.ts'

export const MINI = resolve(import.meta.dirname, '..', '..', 'pack', 'tests', 'fixtures', 'minipack')
export const MINI_SKILL = resolve(MINI, 'skill')
export const ROUTE: RouteConfig = { provider: 'p', model: 'm', credentialRef: 'cred' }

const FACTS: HarnessFacts = {
  systemPromptMode: 'none', skillDelivery: 'agents-skills-dir', schemaEnforcement: 'permissive-tool',
  permission: 'none', reasoning: {}, envelope: { config: 'absent', system: 'absent', tools: 'absent' }, version: { loop: 'fake' },
}

/** A loop that submits `{summary: 'done'}` on every attempt. */
export function fakeLoops(): Loops {
  const provider: LoopProvider = {
    name: 'fake', harnessFacts: FACTS,
    capabilities: { perAttemptBaseUrl: false, perAttemptEnv: false, nativeSchema: 'none', toolFilter: false, nativeMaxTurns: false },
    async start(spec: AttemptSpec) {
      writeFileSync(resolve(spec.workdir, `${spec.tools.submitTool.name}.json`), JSON.stringify({ summary: 'done' }))
      const fin: FinishedEvent = {
        t: 'finished', at: 1, status: 'COMPLETED', stopReason: 'completed',
        usage: { inputTokens: 10, outputTokens: 5 }, cost: { usd: 0.02, source: 'self-reported' }, turns: 1, toolCalls: 1, artifacts: [],
      }
      const events: LoopEvent[] = [{ t: 'started', at: 0, native: { kind: 'fake', id: spec.attemptId } }, fin]
      const run: LoopRun = { id: spec.attemptId, events: (async function* () { for (const e of events) yield e })(), result: Promise.resolve(fin), cancel() {}, async dispose() {} }
      return run
    },
  }
  return { get: (n) => (n === 'fake' ? provider : undefined), start: (n, spec) => provider.start(spec) }
}

export interface Harness {
  ctx: Context
  ledger: FakeLedger
  champion: FakeChampion
  gate: FakeGate
  scopes: FakeScopes
  loops: Loops
  lifecycle: Lifecycle
  /** The deps the plugin hands `challenge` / `round` / `certify` / `calibrate` / `control` / `campaign`. */
  deps(over?: Partial<ChallengeDeps>): ChallengeDeps
}

export async function openHarness(over: { gate?: GatePolicyProvider[]; executor?: Executor; loops?: Loops } = {}): Promise<Harness> {
  const ctx = new Context()
  const ledger = new FakeLedger()
  const champion = new FakeChampion(ledger)
  const gate = new FakeGate(over.gate)
  const scopes = new FakeScopes()
  const loops = over.loops ?? fakeLoops()
  ctx.provide('ledger', ledger)
  ctx.provide('scopes', scopes)
  ctx.provide('gate', gate)
  ctx.provide('loops', loops)
  ctx.provide('champion', champion)
  ctx.provide('executor', over.executor ?? { runSet })
  await ctx.plugin(Lifecycle)
  const lifecycle = ctx.lifecycle
  // ctx.gate as the commands read it: the mounted policies, the last one judging.
  const gateDep: ChallengeDeps['gate'] = {
    current: () => gate.current(),
    list: () => gate.list(),
    judge: async (req: CompareRequest) => { const p = gate.current()!; return { ...(await p.judge(req)), gateMethod: gateMethodOf(p) } },
  }
  return {
    ctx, ledger, champion, gate, scopes, loops, lifecycle,
    deps: (o = {}) => ({ loops, route: ROUTE, ledger, gate: gateDep, lifecycle, ...o }),
  }
}
