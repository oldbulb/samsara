// End-to-end: the synthetic pack (a coin with a known bias) through the pack
// contract alone, then through the runner's paths on a real ledger with the
// null loop (canned submit) and gate-default — `challenge` on smoke, a
// tampering loop and the held-in screen; then the loop closed by the
// lifecycle: calibrate → experiment → campaign, where the null diff must never
// promote and the injected effect must, with the consent from a fake sign-off.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context, DomainFacility, Storage, storageBackendServiceKey, type KvUnit, type StorageBackend } from '../packages/kernel/src/index.ts'
import { createBook, type Task, type TaskSet } from '../packages/book/src/index.ts'
import { DockerEnvironmentProvider, Environments, LocalEnvironmentProvider, environmentSha, type Environment } from '../packages/environments/src/index.ts'
import { realSpawn } from '../packages/environments/tests/fixtures/real-spawn.ts'
import { gateDefault, GATE_DEFAULT_NAME, GATE_DEFAULT_VERSION, type CompareRequest, type GatePolicyProvider } from '../packages/gate/src/index.ts'
import { Ledger, sha256, type ConsentRow, type ExperimentRow, type NoiseFloorRow } from '../packages/ledger/src/index.ts'
import { Lifecycle, campaignHistory, gateRefOf, roundPolicy, type CampaignEvent, type CampaignHooks, type CampaignInput, type CampaignProposer, type HistoryLine } from '../packages/lifecycle/src/index.ts'
import { FakeChampion, FakeGate, FakeScopes, type FakeLedger } from '../packages/lifecycle/tests/fakes.ts'
import { LoopRegistry, NullLoopProvider } from '../packages/loops/src/index.ts'
import * as pluginNull from '../packages/loops/src/plugin-null.ts'
import { loadPack, runCommand as runPackCommand, PackError, type CommandExec, type PackDefinition } from '../packages/pack/src/index.ts'
import { challenge, type ChallengeDeps, type ChallengeRequest } from '../packages/runner/src/challenge.ts'
import { renderView, viewEnvironmentOf } from '../packages/runner/src/round.ts'
import { bookOf, championProposal, environmentSpecOf, runSet, type Loops, type RunRequest } from '../packages/runner/src/run.ts'
import { hashDir } from '../packages/workdir/src/index.ts'

const PACK_DIR = resolve(import.meta.dirname, '..', 'packs', 'synthetic')
const SHA_RE = /^[0-9a-f]{64}$/
const ROUTE = { provider: 'none', model: 'none', credentialRef: 'none' }
const METRIC = 'pass_rate'
const GATE = `${GATE_DEFAULT_NAME}@${GATE_DEFAULT_VERSION}`
/** Below the pack's 24 held-in / 48 held-out entities. */
const N_EFF_FLOOR = 20
// The numbers (README "Power"): the floor is the entity-level sd of a paired
// A/A difference, ≈ 0.18, measured from RERUNS same-config reruns of the
// held-in set; at holdout (48 entities) the design's MDE is
// 2.8 · sd / √(48 · R), which reaches the SESOI 0.05 at R = 6 for any floor
// estimate under 0.30 (the assertion below), so an underpowered hold cannot
// be the null loop's luck.
const RERUNS = 5
const HOLDOUT_REPEAT = 6
/**
 * A/A rounds (seeds): the spec's gate is 0 promotions over SPEC_AA_ROUNDS; a
 * powered held-out test on this pack is 96 × 6 attempts and the null loop
 * runs ≈ 70 attempts/s here, so the default is what fits the file's time
 * budget and SAMSARA_E2E_AA_ROUNDS=20 runs the gate (≈ 4 min). Every A/A
 * round spends one held-out reveal, and so does the injected round after it
 * on the same host: the pack's `holdout.budget` must cover both.
 */
const SPEC_AA_ROUNDS = 20
const AA_ROUNDS = Number(process.env['SAMSARA_E2E_AA_ROUNDS'] ?? 3)

/**
 * The pack's `truth` is `in_environment`: under the `local` provider (the
 * default) that is a host subprocess from the pack dir, which is the binding
 * given to `runCommand` here, so the contract tests run as `--env local` runs
 * them. Commands not so marked spawn on the host whatever is bound.
 */
const hostExec = (def: PackDefinition): CommandExec => async (argv, stdin, o) => {
  const r = spawnSync(argv[0]!, argv.slice(1), { cwd: o.cwd ?? def.dir, input: stdin, env: { ...process.env, ...o.env }, encoding: 'utf8', timeout: o.timeoutMs })
  return { code: r.status, ...(r.signal ? { signal: r.signal } : {}), stdout: r.stdout, stderr: r.stderr }
}
const runCommand: typeof runPackCommand = (def, name, lines, opts = {}) => runPackCommand(def, name, lines, { exec: hostExec(def), ...opts })

let def: PackDefinition
const roots: string[] = []
const hosts: Host[] = []
beforeAll(() => { def = loadPack(PACK_DIR) })
// Twenty A/A rounds leave ≈ 100k files under the roots: removing them takes
// longer than vitest's 10 s hook default, and a hook that times out fails the
// file with every test green (and orphans the roots in $TMPDIR).
const TEARDOWN_MS = 300_000
afterAll(async () => {
  for (const h of hosts) await h.close()
  await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })))
}, TEARDOWN_MS)

function tmp(): string {
  const root = mkdtempSync(join(tmpdir(), 'samsara-synthetic-'))
  roots.push(root)
  return root
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
const sd = (xs: number[]) => {
  const m = mean(xs)
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1))
}

describe('book from pack task sets', () => {
  it('has 8 / 48 / 96 tasks in 3 strata, two tasks per entity, holdout disjoint by entity', () => {
    const book = createBook({
      sets: { smoke: def.taskSets.smoke.tasks as Task[], holdin: def.taskSets.holdin.tasks as Task[], holdout: def.taskSets.holdout.tasks as Task[] },
      entityKey: def.manifest.tasks.entity_key,
      holdoutPolicy: { mde: def.manifest.holdout?.mde ?? 0.05, budget: def.manifest.holdout?.budget ?? 1 },
    })
    expect(() => book.assertDisjointHoldout()).not.toThrow()
    expect([book.tasks('smoke').length, book.tasks('holdin').length, book.tasks('holdout').length]).toEqual([8, 48, 96])
    const holdout = book.tasks('holdout')
    expect(new Set(holdout.map((t) => t.stratum)).size).toBe(3)
    expect(new Set(holdout.map((t) => t.entity_key)).size).toBe(48)
    for (const t of def.taskSets.holdout.tasks) {
      expect(t['base_rate']).toBeGreaterThanOrEqual(0.3)
      expect(t['base_rate']).toBeLessThanOrEqual(0.7)
    }
  })
})

describe('materialize → truth → score through the pack contract', () => {
  /** A workdir sealed the way @oldbulb/samsara-workdir seals one: the attempt token and the skill snapshot, with `effect` set. */
  const skillPath = () => `.agents/skills/${def.manifest.skill.name}`
  function token(attemptId: string, taskId: string, sample: number, over: Record<string, unknown> = {}): string {
    return JSON.stringify({ attemptId, taskId, challengerId: 'c', sample, skill_path: skillPath(), issuedAt: 'now', ...over })
  }
  function seal(root: string, taskId: string, attemptId: string, effect: number, sample = 0): string {
    const workdir = join(root, attemptId)
    mkdirSync(join(workdir, '.task'), { recursive: true })
    mkdirSync(join(workdir, skillPath()), { recursive: true })
    writeFileSync(join(workdir, '.task', 'token.json'), token(attemptId, taskId, sample))
    writeFileSync(join(workdir, skillPath(), 'params.json'), JSON.stringify({ effect }))
    return workdir
  }

  async function passedOf(root: string, runId: string, effect: number, sample = 0): Promise<number[]> {
    const lines = def.taskSets.holdout.tasks.map((t) => ({ task_id: t.task_id, workdir: seal(root, t.task_id, `${runId}-${t.task_id.replace('/', '_')}-${sample}`, effect, sample) }))
    const rows = await runCommand(def, 'truth', lines)
    expect(rows).toHaveLength(lines.length)
    return rows.map((r, i) => {
      expect(r.task_id).toBe(lines[i]!.task_id)
      expect(r.status).toBe('settled')
      expect(r.truth_sha).toMatch(SHA_RE)
      return (r.truth as { passed: number }).passed
    })
  }

  it('materialize writes task.json; truth is deterministic, paired across skills, and moves with effect', async () => {
    const root = tmp()
    const workdir = seal(root, 'f29/t1', 'm-f29_t1-0', 0)
    const [mat] = await runCommand(def, 'materialize', [{ task_id: 'f29/t1', workdir }])
    expect(mat).toEqual({ task_id: 'f29/t1', ok: true, files: ['task.json'] })
    expect(JSON.parse(readFileSync(join(workdir, 'task.json'), 'utf8'))).toEqual({ task_id: 'f29/t1' })

    const champion = await passedOf(root, 'x-champion', 0)
    expect(await passedOf(root, 'x-champion', 0)).toEqual(champion)
    // A/A: a rerun disagrees on some tasks (the per-attempt jitter) but not many (the shared draw)
    const rerun = await passedOf(root, 'x-challenger', 0)
    const aa = rerun.map((v, i) => v - champion[i]!)
    expect(Math.abs(mean(aa))).toBeLessThan(0.12)
    expect(sd(aa)).toBeGreaterThan(0.15)
    expect(sd(aa)).toBeLessThan(0.4)
    // injected: the paired delta is the effect, give or take the jitter
    const injected = await passedOf(root, 'x-injected', 0.15)
    const delta = injected.map((v, i) => v - champion[i]!)
    expect(mean(delta)).toBeGreaterThan(0.08)
    expect(mean(delta)).toBeLessThan(0.25)
    expect(mean(await passedOf(root, 'x-all', 1))).toBe(1)
    expect(mean(await passedOf(root, 'x-none', -1))).toBe(0)
    // a token rewritten to name another attempt (a re-rolled jitter) is refused
    const forged = seal(root, 'f29/t1', 'x-forged-f29_t1-0', 0)
    writeFileSync(join(forged, '.task', 'token.json'), token('x-forged-f29_t1-7', 'f29/t1', 0))
    await expect(runCommand(def, 'truth', [{ task_id: 'f29/t1', workdir: forged }])).rejects.toBeInstanceOf(PackError)

    // replicates are paired by sample index: sample 1 is another coin, not sample 0 plus jitter
    const sample1 = await passedOf(root, 'x-champion', 0, 1)
    const across = sample1.filter((v, i) => v !== champion[i]).length / sample1.length
    expect(across).toBeGreaterThan(0.25)
    // the two token fields truth pairs on are errors when absent, never defaults (README "What truth reads from the token")
    const unsampled = seal(root, 'f29/t1', 'x-nosample-f29_t1-0', 0)
    writeFileSync(join(unsampled, '.task', 'token.json'), token('x-nosample-f29_t1-0', 'f29/t1', 0, { sample: undefined }))
    await expect(runCommand(def, 'truth', [{ task_id: 'f29/t1', workdir: unsampled }])).rejects.toThrow(/token has no sample index/)
    const pathless = seal(root, 'f29/t1', 'x-nopath-f29_t1-0', 0)
    writeFileSync(join(pathless, '.task', 'token.json'), token('x-nopath-f29_t1-0', 'f29/t1', 0, { skill_path: undefined }))
    await expect(runCommand(def, 'truth', [{ task_id: 'f29/t1', workdir: pathless }])).rejects.toThrow(/token has no skill_path/)
    const snapshotless = seal(root, 'f29/t1', 'x-nosnapshot-f29_t1-0', 0)
    rmSync(join(snapshotless, '.agents'), { recursive: true })
    await expect(runCommand(def, 'truth', [{ task_id: 'f29/t1', workdir: snapshotless }])).rejects.toThrow(/skill snapshot not readable at \.agents\/skills\/answer\/params\.json/)

    const score = await runCommand(def, 'score', [{ task_id: 'f29/t1', truth: { passed: 1 }, output: { usage: { input_tokens: 0, output_tokens: 0, cost_usd: null } } }])
    expect(score).toEqual([
      { task_id: 'f29/t1', metric: 'pass_rate', value: 1, kind: 'reality', stratum: 's2' },
      { task_id: 'f29/t1', metric: 'cost_usd', value: 0, kind: 'mechanical', stratum: 's2' },
    ])
  })

  it('truth_sha covers the truth code: the same tasks under another NOISE are another truth snapshot', async () => {
    const root = tmp()
    const copy = join(root, 'pack')
    cpSync(PACK_DIR, copy, { recursive: true })
    const lib = join(copy, 'bin', 'lib.mjs')
    const src = readFileSync(lib, 'utf8')
    expect(src).toContain('export const NOISE = 0.1')
    writeFileSync(lib, src.replace('export const NOISE = 0.1', 'export const NOISE = 0.2'))
    const line = { task_id: 'f29/t1', workdir: seal(root, 'f29/t1', 'sha-f29_t1-0', 0) }
    const [ours] = await runCommand(def, 'truth', [line])
    const [same] = await runCommand(def, 'truth', [line])
    const [theirs] = await runCommand(loadPack(copy), 'truth', [line])
    expect(ours!.truth_sha).toMatch(SHA_RE)
    expect(same!.truth_sha).toBe(ours!.truth_sha)
    expect(theirs!.truth_sha).not.toBe(ours!.truth_sha)
  })
})


// ------------------------------------------------------------------- host

/**
 * `ctx.loops` with the loops-null row configured with a canned submission that
 * satisfies the contract, plus `tamper`: the same loop, except that on the
 * first task of every family it rewrites the skill snapshot's `params.json`
 * to effect 1 (the task passes for sure if the attempt counts).
 */
async function nullLoops(): Promise<Loops> {
  const ctx = new Context()
  await ctx.plugin(LoopRegistry)
  await ctx.plugin(pluginNull, { submit: { answer: 'heads' } })
  const tamper = new NullLoopProvider({ submit: { answer: 'heads' } })
  ctx.loops.register({ ...tamper, name: 'tamper', start(spec) {
    if (/_t1-\d+$/.test(spec.attemptId)) writeFileSync(join(spec.skill.dir, 'params.json'), JSON.stringify({ effect: 1 }))
    return tamper.start(spec)
  } })
  return ctx.loops
}

interface Host {
  root: string
  loops: Loops
  ledger: Ledger
  champion: FakeChampion
  lifecycle: Lifecycle
  /** The last request the gate judged. */
  request: () => CompareRequest | undefined
  /** The deps the runner hands `challenge`. */
  deps(over?: Partial<ChallengeDeps>): ChallengeDeps
  close(): Promise<void>
}

/** A storage backend that keeps every unit in memory: the file backends rewrite the unit per record, and this test writes thousands. */
function memoryBackend(): StorageBackend {
  return {
    kv: {
      async open(descriptor) {
        const tables = new Map(descriptor.tables.map((t) => [t, new Map<string, unknown>()]))
        let global: unknown = null
        const unit: KvUnit = {
          async loadAll() { return { tables: Object.fromEntries([...tables].map(([t, r]) => [t, Object.fromEntries(r)])), global } },
          async putRecord(table, key, value) { tables.get(table)!.set(key, value) },
          async deleteRecord(table, key) { tables.get(table)!.delete(key) },
          async setGlobal(value) { global = value },
          async close() {},
        }
        return unit
      },
    },
    async close() {},
  }
}

/**
 * The host as the runner's commands see it: a real Ledger on an in-memory
 * storage backend, a real Lifecycle over it with this repository's runSet as
 * the executor, gate-default and the local environment provider mounted, and the lifecycle package's fakes for
 * the champion (state in memory, no profile) and the scopes (no diff scan) —
 * the pieces this test is not about.
 */
async function openHost(loops: Loops): Promise<Host> {
  const root = tmp()
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = memoryBackend()
  ctx.storage.backend.register('memory', backend)
  ctx.provide(storageBackendServiceKey('memory'), backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const fiber = ctx.plugin(Ledger)
  await fiber
  const ledger = ctx.ledger
  // The fake calls challenger() and setStatus() on it, which the real ledger has.
  const champion = new FakeChampion(ledger as unknown as FakeLedger)
  let request: CompareRequest | undefined
  const provider: GatePolicyProvider = { name: GATE_DEFAULT_NAME, version: GATE_DEFAULT_VERSION, judge: (req) => { request = req; return gateDefault(req) } }
  const gate = new FakeGate([provider])
  ctx.provide('scopes', new FakeScopes())
  ctx.provide('gate', gate)
  ctx.provide('loops', loops)
  ctx.provide('champion', champion)
  ctx.provide('executor', { runSet })
  // One local environment per attempt, what the CLI's default provider gives: the pack's truth is `in_environment`.
  await ctx.plugin(Environments)
  ctx.environments.register(new LocalEnvironmentProvider({ spawn: realSpawn, baseDir: join(root, 'environments') }))
  await ctx.plugin(Lifecycle)
  const lifecycle = ctx.lifecycle
  const gateDep: ChallengeDeps['gate'] = { current: () => gate.current(), list: () => gate.list(), judge: (req) => ({ ...provider.judge(req), gateMethod: GATE }) }
  const host: Host = {
    root, loops, ledger, champion, lifecycle,
    request: () => request,
    deps: (over = {}) => ({ loops, route: ROUTE, ledger, gate: gateDep, lifecycle, environments: ctx.environments, ...over }),
    close: async () => { await fiber.dispose(); await backend.close() },
  }
  hosts.push(host)
  return host
}

// -------------------------------------------------------------- challenge

interface Outcome {
  verdict: string
  rule: string
  request: CompareRequest
  rows: { status: string; valid: boolean; settled: boolean; metrics: string[] }[]
}

/** One challenger (the pack skill with `effect`) against the champion (the pack skill, effect 0) on `set` under `loop`, everything fresh. */
async function challengeWith(set: TaskSet, effect: number, runId: string, loop = 'null'): Promise<Outcome> {
  const host = await openHost(await nullLoops())
  const skillDir = join(host.root, 'skill')
  cpSync(def.skillDir, skillDir, { recursive: true })
  writeFileSync(join(skillDir, 'params.json'), JSON.stringify({ effect }) + '\n')
  const req: ChallengeRequest = {
    pack: PACK_DIR, loop, set, repeat: 1, parallel: 8, out: join(host.root, 'out'), maxTurns: 1, maxMinutes: 1,
    surface: 'skill', skillDir, intent: `effect ${effect}`, metric: METRIC, nEffFloor: N_EFF_FLOOR, withChampion: true, gatePolicy: 'default',
  }
  const result = await challenge(req, host.deps({ runId }))
  expect(result.rejected).toBeUndefined()
  expect(result.invalid).toBeUndefined()
  expect(result.verdictExists).toBeUndefined()
  expect(result.shadow).toBe(false)
  expect(result.compare?.verdict.value).toBeDefined()
  // decide closes the round: a drop is decided, a hold stays judged (it may re-enter)
  const verdict = result.compare!.verdict.value
  expect(host.ledger.challenger(result.challengerId)).toMatchObject({ status: verdict === 'drop' ? 'decided' : 'judged', tier_reached: set, pack: def.name, verdict: { by: GATE, round_id: result.roundId } })
  expect(host.ledger.round(result.roundId)).toMatchObject({ status: 'decided', sibling_ids: [result.challengerId], k: 1 })
  expect(host.ledger.attemptsOf(result.championId)).toHaveLength(result.champion!.rows.length)
  const rows = [...result.champion!.rows, ...result.challenger!.rows].map((r) => ({ status: r.status, valid: r.output.valid, settled: r.truth.status === 'settled', metrics: r.scores.map((s) => s.metric) }))
  return { verdict, rule: result.compare!.rule_fired, request: host.request()!, rows }
}

describe('challenge with the null loop, gate-default and a real ledger', () => {
  it('smoke: every attempt submits, settles and scores; the tier decides validity only', { timeout: 60_000 }, async () => {
    const o = await challengeWith('smoke', 0.15, 'smoke')
    expect(o.rows).toHaveLength(16)
    for (const r of o.rows) expect(r).toEqual({ status: 'COMPLETED', valid: true, settled: true, metrics: ['pass_rate', 'cost_usd'] })
    expect(o.request.challenger.every((a) => a.valid === true)).toBe(true)
    expect([o.verdict, o.rule]).toEqual(['hold', 'validity'])
  })

  it('smoke under a loop that rewrites the skill snapshot: the tampered attempts fail at the seam and never pair', { timeout: 60_000 }, async () => {
    const o = await challengeWith('smoke', 0, 'tamper', 'tamper')
    expect(o.rows).toHaveLength(16)
    expect(o.rows.filter((r) => r.status === 'FAILED')).toHaveLength(8)
    expect(o.rows.filter((r) => r.status === 'COMPLETED' && r.valid)).toHaveLength(8)
    expect(o.request.challenger.filter((a) => a.status === 'FAILED')).toHaveLength(4)
    expect([o.verdict, o.rule]).toEqual(['drop', 'validity'])
    expect(gateDefault(o.request).compare.counts).toMatchObject({ paired: 4, validRate: 0.5 })
  })

  it('holdin: the injected effect survives the futility screen but the tier never promotes', { timeout: 60_000 }, async () => {
    const o = await challengeWith('holdin', 0.15, 'screen')
    expect(o.rows).toHaveLength(96)
    expect([o.verdict, o.rule]).toEqual(['hold', 'screen'])
    // no noise floor yet: the MDE is 0 and only the entity floor binds
    expect(o.request.noiseFloor).toEqual({ sdPaired: 0, nReruns: 0 })
    expect(gateDefault(o.request).compare.nEff).toBe(24)
  })
})

// --------------------------------------------------------------- campaign

/** The test proposer: the champion skill from the view with `effect` set; every call is its own config sha, so every round is a new row (a seed). */
function effectProposer(effect: number, seed: string): CampaignProposer & { seen: HistoryLine[][] } {
  const seen: HistoryLine[][] = []
  return {
    name: 'effect', version: '1', configSha: sha256(seed), seen,
    async propose({ viewDir, workDir }) {
      const n = seen.push(readFileSync(join(viewDir, 'history.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as HistoryLine))
      const skill = join(workDir, 'skill')
      cpSync(join(viewDir, 'champion-skill'), skill, { recursive: true })
      writeFileSync(join(skill, 'params.json'), JSON.stringify({ effect }) + '\n')
      return {
        surface: 'skill', patch: { surface: 'skill', skill_dir: 'skill' }, intent: `effect ${effect} (${seed}/${n})`,
        prediction: { metric: METRIC, direction: 'up' }, proposer: { name: 'effect', version: '1', config_sha: sha256(`${seed}/${n}`) },
      }
    },
  }
}

describe('calibrate → experiment → campaign: the loop closed on the null loop', () => {
  let host: Host
  let out: string
  let runReq: RunRequest
  let floor: NoiseFloorRow
  let championId: string
  const events: CampaignEvent[] = []
  const signed: ConsentRow[] = []
  let hooks: CampaignHooks

  /** The champion the rounds anchor on: the kept skill after a promotion, the pack's before (the runner's `championProposal`). */
  const champion = () => {
    const kept = host.champion.state.kept.at(-1)
    const skillDir = kept ? host.ledger.challenger(kept.challenger_id)!.patch.skill_ref! : def.skillDir
    return { proposal: championProposal(def, bookOf(def), runReq, { loops: host.loops, route: ROUTE, championSkillDir: skillDir }), skillDir }
  }

  function input(experiment: ExperimentRow, proposer: CampaignProposer, over: Pick<CampaignInput['stop'], 'maxRounds' | 'stopOnPromote'>): CampaignInput {
    return {
      experimentId: experiment.id, pack: PACK_DIR, champion, proposer, metric: METRIC, nEffFloor: N_EFF_FLOOR, set: 'holdin',
      tiers: { holdin: { repeat: 1 }, holdout: { repeat: HOLDOUT_REPEAT } },
      stop: { maxConsecutiveHolds: over.maxRounds, ...over },
      autoHoldout: true, out: join(out, experiment.id.slice(0, 12)),
      run: { maxTurns: runReq.maxTurns, maxMinutes: runReq.maxMinutes, parallel: 8, route: ROUTE },
    }
  }

  async function preregister(hypothesis: string, rounds: number): Promise<ExperimentRow> {
    return host.lifecycle.preregister({
      hypothesis, prediction: { metric: METRIC, direction: 'up', magnitude: 0.15 }, pack: def.name,
      gate: gateRefOf(host.deps().gate.current()!, roundPolicy(N_EFF_FLOOR, def.manifest.holdout?.mde)),
      budget: { rounds }, created_by: { channel: 'test', who: 'e2e' },
    })
  }

  const holdinOf = (id: string) => host.ledger.comparesOf(id).find((c) => c.tier === 'holdin')
  const holdoutOf = (id: string) => host.ledger.comparesOf(id).find((c) => c.tier === 'holdout')

  beforeAll(async () => {
    host = await openHost(await nullLoops())
    out = join(host.root, 'out')
    runReq = { pack: PACK_DIR, loop: 'null', set: 'holdin', repeat: 1, parallel: 8, out, maxTurns: 1, maxMinutes: 1 }
    hooks = {
      onEvent: (e) => { events.push(e) },
      signal: new AbortController().signal,
      // The fake sign-off: the consent row lands on the ledger, as the socket path records one; decide reads it there.
      consent: async (action, subject, roundId) => {
        const row: ConsentRow = { id: `${action}:${subject.slice(0, 12)}`, challenger_id: subject, action, who: 'e2e', channel: 'test', proof_sha: sha256(`${action}\0${subject}`), at: new Date().toISOString(), ...(action === 'promote' ? { round_id: roundId } : {}) }
        await host.ledger.recordConsent(row)
        signed.push(row)
        return row
      },
      renderView: (dir, view) => renderView(dir, { championId: view.championId, championSkillDir: view.championSkillDir, metric: view.metric, tasks: view.tasks, ledger: host.ledger, environment: viewEnvironmentOf(def, runReq, host.loops) }),
      hashDir,
    }
  })

  it('calibrate: same-config reruns of the champion on the held-in set measure the jitter, not the coin', { timeout: 60_000 }, async () => {
    floor = await host.lifecycle.calibrate({ pack: PACK_DIR, champion: champion().proposal, metric: METRIC, set: 'holdin', reruns: RERUNS, run: { out: join(out, 'calibrate'), maxTurns: 1, maxMinutes: 1, parallel: 8, route: ROUTE } })
    championId = floor.champion_id
    expect(floor).toMatchObject({ loop: 'null', metric: METRIC, tier: 'holdin', unit: 'entity', n_reruns: RERUNS, n_tasks: 48 })
    // README "Noise": the paired A/A difference has sd ≈ 0.26 per task, ≈ 0.18 per two-task entity; the coin itself (≈ 0.5) never enters
    expect(floor.sd_paired).toBeGreaterThan(0.08)
    expect(floor.sd_paired).toBeLessThan(0.3)
    // every rerun is the same replicate: the champion's attempts all sit at sample 0, RERUNS per task, under one proposed row
    const attempts = host.ledger.attemptsOf(championId)
    expect(attempts).toHaveLength(48 * RERUNS)
    expect(attempts.every((a) => a.sample === 0 && a.tier === 'holdin' && a.status === 'COMPLETED')).toBe(true)
    expect(host.ledger.challenger(championId)).toMatchObject({ parent_ids: [], status: 'proposed', pack: def.name, prediction: { metric: METRIC }, eval_config_sha: floor.eval_config_sha })
    expect(host.ledger.noiseFloorFor(floor.eval_config_sha, championId, 'null', METRIC)).toEqual(floor)
    expect(host.lifecycle.status()).toMatchObject({ rounds: [], pending: [], noiseFloors: [floor], experiments: [] })
  })

  it('the pack\'s held-out budget covers the spec\'s A/A seeds, the injected round and the README\'s control round', () => {
    // one reveal per challenger run on the held-out set (README "Held-out reveals"); a smaller budget stops the A/A on `budget` before its seeds are up
    expect(def.manifest.holdout?.budget).toBeGreaterThanOrEqual(SPEC_AA_ROUNDS + 1 + 1)
    expect(AA_ROUNDS + 1).toBeLessThanOrEqual(def.manifest.holdout!.budget!)
  })

  it(`A/A: the null diff over ${AA_ROUNDS} rounds never promotes; every held-out test ran powered; the proposer's history carries held-in numbers only`, { timeout: 900_000 }, async () => {
    const experiment = await preregister('the null diff does not promote', AA_ROUNDS)
    const proposer = effectProposer(0, 'aa')
    const result = await host.lifecycle.campaign(input(experiment, proposer, { maxRounds: AA_ROUNDS, stopOnPromote: false }), hooks)
    expect(result.paused).toBeUndefined()
    expect(result).toMatchObject({ stopped: 'max_rounds', promoted: [] })
    expect(result.rounds).toHaveLength(AA_ROUNDS)
    expect(signed).toEqual([])
    // every round is its own row (seed) in its own decided round, judged against the calibrated champion
    expect(new Set(result.rounds.map((r) => r.challengerId)).size).toBe(AA_ROUNDS)
    let reveals = 0
    for (const r of result.rounds) {
      const row = host.ledger.challenger(r.challengerId!)!
      expect(row).toMatchObject({ parent_ids: [championId], pack: def.name, intent: expect.stringMatching(/^effect 0 \(aa\/\d+\)$/) })
      expect(host.ledger.round(r.roundId)).toMatchObject({ status: 'decided', experiment_id: experiment.id, noise_floor_id: floor.id, sibling_ids: [r.challengerId], k: 1, outcome: { superseded: [] } })
      expect(host.ledger.round(r.roundId)?.outcome?.promoted).toBeUndefined()
      // held-in under a pinned floor: 24 entities at one replicate cannot see the SESOI, and the power floor (rule 3) comes before
      // the futility screen (rule 5), so the null diff is held on power — never dropped — and every round goes on to holdout
      const h = holdinOf(r.challengerId!)!
      expect(h).toMatchObject({ rule_fired: 'power:mde', verdict: { value: 'hold', by: GATE }, n_eff: 24, replicates: 1, sd_source: 'noise_floor', min_effect: 0.05, round_id: r.roundId })
      expect(h.mde).toBeGreaterThan(0.05)
      expect(r.tier).toBe('holdout')
      reveals++
      // one pre-registered test at the SESOI, powered by the replicates: the null diff is indistinguishable from the champion on
      // quality and on cost under a powered design, so the test drops it (S8) — never on power; one reveal debited
      const c = holdoutOf(r.challengerId!)!
      expect(c).toMatchObject({ verdict: { by: GATE }, n_eff: 48, replicates: HOLDOUT_REPEAT, sd_source: 'noise_floor', min_effect: 0.05, round_id: r.roundId, holm: { m: 1, rank: 0 }, holdout_budget_remaining: def.manifest.holdout!.budget! - reveals })
      expect(c.mde).toBeLessThan(0.05)
      expect(Math.abs(c.mean)).toBeLessThan(0.1)
      // the interval brackets zero (the usual case): indistinguishable, dropped; a round whose interval happens to leave zero is a hold on the test itself
      const dropped = c.rule_fired === 'indistinguishable'
      expect(c).toMatchObject(dropped ? { verdict: { value: 'drop' } } : { rule_fired: 'holdout', verdict: { value: 'hold' } })
      expect(row).toMatchObject({ status: dropped ? 'decided' : 'judged', tier_reached: 'holdout', verdict: { value: dropped ? 'drop' : 'hold', rule: c.rule_fired } })
    }
    expect(reveals).toBe(AA_ROUNDS)
    expect(host.ledger.experiment(experiment.id)).toMatchObject({ status: 'active', round_ids: result.rounds.map((r) => r.roundId), spent: { rounds: AA_ROUNDS, holdout_reveals: reveals, usd: 0 } })
    expect(host.ledger.experiment(experiment.id)!.spent.attempts).toBe(result.rounds.map((r) => host.ledger.attemptsOf(r.challengerId!).length).reduce((a, b) => a + b, 0) + host.ledger.attemptsOf(championId).filter((a) => a.tier !== 'holdin').length)

    // The proposer saw one history line per earlier round, none of them a held-out number.
    expect(proposer.seen.map((h) => h.length)).toEqual(result.rounds.map((_, i) => i))
    for (const line of proposer.seen.at(-1)!) {
      expect(Object.keys(line).every((k) => ['round_id', 'challenger_id', 'tier', 'verdict', 'mean', 'ci', 'n_eff', 'mde'].includes(k))).toBe(true)
      const holdin = holdinOf(line.challenger_id)!
      expect(line).toMatchObject({ mean: holdin.mean, ci: holdin.ci, n_eff: 24, mde: holdin.mde, verdict: host.ledger.challenger(line.challenger_id)!.verdict!.value })
    }
    const lastRound = result.rounds.at(-1)!.roundId.slice(0, 12)
    const view = JSON.parse(readFileSync(join(out, experiment.id.slice(0, 12), lastRound, 'view', 'view.json'), 'utf8')) as { files: string[] }
    expect(view.files).toContain('history.jsonl')
    expect(existsSync(join(out, experiment.id.slice(0, 12), lastRound, 'view', 'environment.md'))).toBe(true)
    expect(events.filter((e) => e.kind === 'round:opened')).toHaveLength(AA_ROUNDS)
    expect(events.at(-1)).toMatchObject({ kind: 'stopped', reason: 'max_rounds' })
  })

  it('injected +0.15: promotes at holdout in round 1 with the consent from the fake sign-off; the serving row, the spend and the status follow', { timeout: 120_000 }, async () => {
    const experiment = await preregister('effect 0.15 promotes', 3)
    const proposer = effectProposer(0.15, 'inject')
    const result = await host.lifecycle.campaign(input(experiment, proposer, { maxRounds: 3, stopOnPromote: true }), hooks)
    expect(result.paused).toBeUndefined()
    expect(result).toMatchObject({ stopped: 'promoted', promoted: [expect.any(String)] })
    expect(result.rounds).toHaveLength(1)
    const [id] = result.promoted as [string]
    const [round] = result.rounds
    expect(round).toMatchObject({ challengerId: id, tier: 'holdout', verdict: 'promote', promoted: id })
    const [consent] = signed as [ConsentRow]
    expect(signed).toHaveLength(1)
    expect(consent).toMatchObject({ action: 'promote', challenger_id: id })
    expect(host.ledger.consentsOf(id)).toEqual([consent])

    // smoke on validity, held-in a hold the design cannot power at one replicate, held-out the test — then the decision with the consent
    expect(host.ledger.comparesOf(id).map((c) => [c.tier, c.verdict.value, c.rule_fired])).toEqual([['smoke', 'hold', 'validity'], ['holdin', 'hold', 'power:mde'], ['holdout', 'promote', 'holdout']])
    const c = holdoutOf(id)!
    // the reveal after the A/A's: the budget is one count across the host's ledger
    expect(c).toMatchObject({ vs_id: championId, n_eff: 48, replicates: HOLDOUT_REPEAT, sd_source: 'noise_floor', min_effect: 0.05, round_id: round!.roundId, gate: GATE, shadow: false, holdout_budget_remaining: def.manifest.holdout!.budget! - AA_ROUNDS - 1 })
    expect(c.mde).toBeLessThan(0.05)
    expect(c.mean).toBeGreaterThan(0.08)
    expect(c.mean).toBeLessThan(0.25)
    expect(c.ci[0]).toBeGreaterThan(0.05)
    expect(host.ledger.challenger(id)).toMatchObject({ status: 'decided', tier_reached: 'holdout', parent_ids: [championId], verdict: { value: 'promote', by: GATE, rule: 'holdout', round_id: round!.roundId, consent_id: consent.id } })
    expect(host.ledger.round(round!.roundId)).toMatchObject({ status: 'decided', experiment_id: experiment.id, noise_floor_id: floor.id, outcome: { promoted: id, superseded: [], consent_id: consent.id } })
    expect(host.ledger.attemptsOf(id)).toHaveLength(8 + 48 + 96 * HOLDOUT_REPEAT)

    // the champion moved, the serving row opened, the spend landed, the status shows the new champion and nothing pending
    expect(host.champion.promoted).toEqual([[id, consent.id]])
    expect(host.ledger.servings()).toHaveLength(1)
    expect(host.ledger.servings()[0]).toMatchObject({ champion_id: id, by: 'promote', consent_id: consent.id })
    expect(host.ledger.servings()[0]!.to).toBeUndefined()
    const spent = host.ledger.experiment(experiment.id)!.spent
    expect(spent).toMatchObject({ rounds: 1, holdout_reveals: 1, usd: 0 })
    expect(spent.attempts).toBeGreaterThanOrEqual(8 + 48 + 96 * HOLDOUT_REPEAT)
    expect(host.lifecycle.status()).toMatchObject({ champion: { rows: [`skill:${host.ledger.challenger(id)!.skill_sha}`] }, rounds: [], pending: [] })
    expect(events.at(-1)).toMatchObject({ kind: 'stopped', reason: 'promoted', spent })

    // what a later round's proposer would read of this one: the tier and the verdict, with the held-in numbers
    expect(proposer.seen).toEqual([[]])
    const [line] = campaignHistory(host.ledger.experiment(experiment.id)!, host.ledger)
    expect(line).toEqual({ round_id: round!.roundId, challenger_id: id, tier: 'holdout', verdict: 'promote', mean: holdinOf(id)!.mean, ci: holdinOf(id)!.ci, n_eff: 24, mde: holdinOf(id)!.mde })
    expect(line!.mean).not.toBe(c.mean)
  })
})

// ----------------------------------------------------------------- docker

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 20_000 })
    return true
  } catch {
    return false
  }
}

/**
 * The pack's `environment` block for real: three smoke attempts, each in its
 * own `node:22-slim` container opened by the docker provider on the spec the
 * runner composes — materialize on the host, the sealed workdir put in, truth
 * (`in_environment`) through `exec` from the pack dir mounted read-only at
 * its own path, score on the host. CI runs this describe on ubuntu
 * (`-t docker`); anywhere without a daemon it skips.
 */
describe.skipIf(!dockerAvailable())('in a docker environment (skipped: docker is not on PATH or the daemon is down)', () => {
  const skillPath = () => `.agents/skills/${def.manifest.skill.name}`
  /** Sealed on the host the way @oldbulb/samsara-workdir seals: the token names the attempt, the snapshot carries `effect`. */
  function seal(root: string, taskId: string, attemptId: string, effect: number): string {
    const workdir = join(root, attemptId)
    mkdirSync(join(workdir, '.task'), { recursive: true })
    mkdirSync(join(workdir, skillPath()), { recursive: true })
    writeFileSync(join(workdir, '.task', 'token.json'), JSON.stringify({ attemptId, taskId, challengerId: 'c', sample: 0, skill_path: skillPath(), issuedAt: 'now' }))
    writeFileSync(join(workdir, skillPath(), 'params.json'), JSON.stringify({ effect }))
    return workdir
  }
  const containersOf = (attemptId: string) => execFileSync('docker', ['ps', '-aq', '--filter', `label=samsara.attempt=${attemptId}`], { encoding: 'utf8' }).trim()

  it('materialize on the host → put → truth in the container → score on the host; the same attempt on local is the same coin; the facts carry the digest', { timeout: 600_000 }, async () => {
    const root = tmp()
    const provider = new DockerEnvironmentProvider({ spawn: realSpawn, baseDir: join(root, 'base') })
    const tasks = def.taskSets.smoke.tasks.slice(0, 3)
    const opened: Environment[] = []
    const designs = new Set<string>()
    try {
      for (const [i, task] of tasks.entries()) {
        const attemptId = `docker-${task.task_id.replace('/', '_')}-0`
        const effect = i === 2 ? 1 : 0
        // the runner's spec: the pack's block, the pack dir mounted read-only at its own path because truth runs inside
        const spec = environmentSpecOf(def, task.environment ?? def.manifest.environment, attemptId, { maxMinutes: 1 })
        expect(spec).toEqual({ attemptId, image: { ref: 'node:22-slim' }, resources: { timeoutS: 60 }, network: 'none', env: {}, mounts: [{ from: def.dir, to: def.dir, readOnly: true }] })
        const env = await provider.open(spec)
        opened.push(env)
        expect(env.workdir).toBe(`/workspace/${attemptId}`)
        const short = containersOf(attemptId)
        expect(short).not.toBe('')
        expect(env.id.startsWith(short)).toBe(true)

        const local = seal(root, task.task_id, attemptId, effect)
        const [mat] = await runCommand(def, 'materialize', [{ task_id: task.task_id, workdir: local }])
        expect(mat).toEqual({ task_id: task.task_id, ok: true, files: ['task.json'] })
        for (const entry of readdirSync(local).sort()) await env.put(join(local, entry), entry)

        // inside: node from the image, the pack dir at its own path, nothing reaches out
        const probe = await env.exec(['sh', '-c', `node --version && ls tasks && pwd && (node -e "fetch('https://example.com').then(() => process.exit(0), () => process.exit(3))" || echo offline $?)`], { cwd: def.dir, timeoutMs: 60_000 })
        expect(probe.code).toBe(0)
        expect(probe.stdout).toMatch(/^v22\./)
        expect(probe.stdout).toContain('holdout.jsonl')
        expect(probe.stdout).toContain(`${def.dir}\n`)
        expect(probe.stdout).toMatch(/offline 3\n$/)

        // truth is in_environment: the runner's binding, from the pack dir, the same jsonl; the host's variables never enter
        const exec: CommandExec = (argv, stdin, o) => env.exec(argv, { cwd: def.dir, ...o, stdin })
        const [inside] = await runCommand(def, 'truth', [{ task_id: task.task_id, workdir: env.workdir }], { exec, env: {} })
        expect(inside).toMatchObject({ task_id: task.task_id, status: 'settled', truth_sha: expect.stringMatching(SHA_RE) })
        const passed = (inside!.truth as { passed: number }).passed
        expect([0, 1]).toContain(passed)
        if (effect === 1) expect(passed).toBe(1)

        // the same attempt under the local provider (its own path for the pack dir too) is the same coin: the provider is no input of truth
        const hostSpec = { ...spec, workdir: local }
        delete hostSpec.image
        const mirror = await new LocalEnvironmentProvider({ spawn: realSpawn }).open(hostSpec)
        try {
          const [onHost] = await runCommand(def, 'truth', [{ task_id: task.task_id, workdir: mirror.workdir }], { exec: (argv, stdin, o) => mirror.exec(argv, { cwd: def.dir, ...o, stdin }) })
          expect(onHost).toEqual(inside)
        } finally {
          await mirror.dispose()
        }

        // score stays on the host
        const scores = await runCommand(def, 'score', [{ task_id: task.task_id, truth: inside!.truth, output: { usage: { input_tokens: 0, output_tokens: 0, cost_usd: null } } }])
        expect(scores).toEqual([
          { task_id: task.task_id, metric: 'pass_rate', value: passed, kind: 'reality', stratum: task['stratum'] },
          { task_id: task.task_id, metric: 'cost_usd', value: 0, kind: 'mechanical', stratum: task['stratum'] },
        ])

        // what ran, as the row records it: the image by digest, no network; one design across the three attempts (rule 0)
        expect(env.facts()).toEqual({ provider: 'docker', version: env.facts().version, image: { ref: 'node:22-slim', digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) }, resources: { timeoutS: 60 }, network: 'none' })
        designs.add(environmentSha(env.facts()))
      }
      expect(designs.size).toBe(1)
    } finally {
      await Promise.all(opened.map((env) => env.dispose()))
    }
    // E4: dispose is the kill, nothing lingers
    for (const task of tasks) expect(containersOf(`docker-${task.task_id.replace('/', '_')}-0`)).toBe('')
  })
})

// The pack's own skill must be the effect-0 champion the README describes.
it('the pack skill declares effect 0', () => {
  expect(existsSync(join(def.skillDir, 'SKILL.md'))).toBe(true)
  expect(JSON.parse(readFileSync(join(def.skillDir, 'params.json'), 'utf8'))).toEqual({ effect: 0 })
})
