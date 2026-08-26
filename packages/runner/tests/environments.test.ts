// runSet behind the environment seam: a fake registry stands in for
// ctx.environments, so the sealed workdir's put, the loop's spec, the
// in_environment truth's exec, the facts on the row and the dispose order are
// all observable without a provider.

import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import type { Environment, EnvironmentFacts, EnvironmentSpec, ExecOptions } from '@oldbulb/samsara-environments'
import { attemptRowSchema, challengerId, type AttemptRow as LedgerAttemptRow } from '@oldbulb/samsara-ledger'
import { factsSha, type AttemptSpec, type FinishedEvent, type HarnessFacts, type LoopEvent, type LoopProvider, type LoopRun } from '@oldbulb/samsara-loops'
import { declaredEnvironmentSha, environmentCommandEnv, environmentSpecOf, resumableLoop, runSet, championProposal, bookOf, type LedgerSink, type Loops, type RunDeps } from '../src/run.ts'
import { readStep, stepPath, writeStep } from '../src/steps.ts'
import { loadPack } from '@oldbulb/samsara-pack'

const MINI = resolve(import.meta.dirname, '..', '..', 'pack', 'tests', 'fixtures', 'minipack')

const FACTS: HarnessFacts = {
  systemPromptMode: 'none', skillDelivery: 'agents-skills-dir', schemaEnforcement: 'permissive-tool',
  permission: 'none', reasoning: {}, envelope: { config: 'absent', system: 'absent', tools: 'absent' }, version: { loop: 'fake' },
}

/** minipack with a declared environment and its truth marked in_environment. */
function packWithEnvironment(): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'envpack-'))
  cpSync(MINI, dir, { recursive: true })
  const manifest = readFileSync(resolve(dir, 'pack.yaml'), 'utf8')
    .replace('commands:\n  truth: ./bin/truth', 'environment: { image: "example/image:1", network: none, resources: { timeout_s: 30, cpus: 2 } }\ncommands:\n  truth: { run: ./bin/truth, in_environment: true }')
  writeFileSync(resolve(dir, 'pack.yaml'), manifest)
  return dir
}

interface FakeEnvironment extends Environment {
  puts: [string, string][]
  gets: [string, string][]
  execs: { argv: string[]; opts: ExecOptions }[]
  disposed: number
}

/**
 * An environment on this host: put/get copy, exec runs the argv from the pack dir so `./bin/truth` resolves, on the
 * image's own PATH plus the call's env. A `spec.workdir` is honoured as the local provider does (the caller's dir).
 */
function fakeEnvironment(spec: EnvironmentSpec, packDir: string, facts: Partial<EnvironmentFacts> = {}): FakeEnvironment {
  const workdir = spec.workdir === undefined ? mkdtempSync(resolve(tmpdir(), 'fake-env-')) : resolve(spec.workdir)
  mkdirSync(workdir, { recursive: true })
  const env: FakeEnvironment = {
    id: spec.attemptId, provider: 'fake', workdir, puts: [], gets: [], execs: [], disposed: 0,
    async exec(argv, opts) {
      env.execs.push({ argv, opts })
      const r = spawnSync(argv[0]!, argv.slice(1), { cwd: packDir, input: opts.stdin ?? '', env: { PATH: process.env['PATH'] ?? '', ...opts.env }, encoding: 'utf8' })
      return { code: r.status, stdout: r.stdout, stderr: r.stderr }
    },
    async put(localPath, remotePath) {
      env.puts.push([localPath, remotePath])
      mkdirSync(dirname(resolve(workdir, remotePath)), { recursive: true })
      cpSync(localPath, resolve(workdir, remotePath), { recursive: true })
    },
    async get(remotePath, localPath) {
      env.gets.push([remotePath, localPath])
      cpSync(resolve(workdir, remotePath), localPath)
    },
    facts: () => ({ provider: 'fake', version: '1', image: { ref: spec.image?.ref ?? 'none', digest: 'sha256:deadbeef' }, resources: { ...spec.resources }, network: spec.network, ...facts }),
    async dispose() { env.disposed++ },
  }
  return env
}

function fakeRegistry(packDir: string, fail = false) {
  const opened: { name: string; spec: EnvironmentSpec; env: FakeEnvironment }[] = []
  const registry: NonNullable<RunDeps['environments']> & { opened: typeof opened } = {
    opened,
    async open(name, spec) {
      if (fail) throw new Error('no daemon')
      // the facts name the provider opened, as a real one's do (the runner keys the host provider on it)
      const env = fakeEnvironment(spec, packDir, { provider: name })
      opened.push({ name, spec, env })
      return env
    },
  }
  return registry
}

function fakeLoops(onSpec: (s: AttemptSpec) => void): Loops {
  const provider: LoopProvider = {
    name: 'fake', harnessFacts: FACTS,
    capabilities: { perAttemptBaseUrl: false, perAttemptEnv: false, nativeSchema: 'none', toolFilter: false, nativeMaxTurns: false },
    async start(spec) {
      onSpec(spec)
      writeFileSync(resolve(spec.workdir, `${spec.tools.submitTool.name}.json`), JSON.stringify({ summary: 'done' }))
      const fin: FinishedEvent = { t: 'finished', at: 1, status: 'COMPLETED', stopReason: 'completed', usage: { inputTokens: 1, outputTokens: 1 }, cost: { source: 'unknown' }, turns: 1, toolCalls: 0, artifacts: [] }
      const events: LoopEvent[] = [{ t: 'started', at: 0, native: { kind: 'fake', id: spec.attemptId } }, fin]
      const run: LoopRun = { id: spec.attemptId, events: (async function* () { for (const e of events) yield e })(), result: Promise.resolve(fin), cancel() {}, async dispose() {} }
      return run
    },
  }
  return { get: (n) => (n === 'fake' ? provider : undefined), start: (_n, spec) => provider.start(spec) }
}

const ROUTE = { provider: 'p', model: 'm', credentialRef: 'cred' }

describe('runSet with an environments registry', () => {
  it('opens one environment per attempt on the named provider, puts the sealed workdir in, runs the loop and the in_environment truth there, records the facts, disposes last', async () => {
    const pack = packWithEnvironment()
    const out = mkdtempSync(resolve(tmpdir(), 'runner-env-'))
    const environments = fakeRegistry(pack)
    const specs: AttemptSpec[] = []
    const tracked: { dispose: () => Promise<void>; untracked: number }[] = []
    const attempts: LedgerAttemptRow[] = []
    const ledger: LedgerSink = {
      async propose(p) { return challengerId(p) },
      async recordAttempt(r) { attempts.push(attemptRowSchema.parse(r)); return r.id },
      async appendScores(rows) { return rows.map((r) => r.metric) },
    }
    process.env['MINIPACK_MODE'] = 'ok'
    let res
    try {
      res = await runSet({ pack, loop: 'fake', set: 'smoke', repeat: 1, out, maxTurns: 5, maxMinutes: 1, env: 'fake' }, {
        loops: fakeLoops((s) => specs.push(s)), route: ROUTE, runId: 'run-E', environments, ledger,
        track: (dispose) => { const t = { dispose, untracked: 0 }; tracked.push(t); return () => { t.untracked++ } },
      })
    } finally {
      delete process.env['MINIPACK_MODE']
    }
    expect(environments.opened).toHaveLength(1)
    const { name, spec, env } = environments.opened[0]!
    expect(name).toBe('fake')
    // the pack dir is mounted read-only at its own path: the in_environment truth runs `sh -c ./bin/truth` from it
    expect(spec).toEqual({ attemptId: 'run-E-s1-0', image: { ref: 'example/image:1' }, resources: { cpus: 2, timeoutS: 30 }, network: 'none', env: {}, mounts: [{ from: pack, to: pack, readOnly: true }] })
    // the sealed workdir went in, entry by entry, and the loop ran there
    const localPath = resolve(out, 'attempts', 'run-E-s1-0')
    expect(env.puts).toEqual(['.agents', '.claude', '.task', '.tmp'].map((e) => [resolve(localPath, e), e]))
    expect(specs[0]!.workdir).toBe(env.workdir)
    expect(specs[0]!.tmpdir).toBe(resolve(env.workdir, '.tmp'))
    expect(specs[0]!.environment).toBe(env)
    expect(existsSync(resolve(env.workdir, '.agents', 'skills', 'mini', 'SKILL.md'))).toBe(true)
    // the submit came back to the host copy and validated
    expect(env.gets).toEqual([['submit_mini.json', resolve(localPath, 'submit_mini.json')]])
    const row = res.rows[0]!
    expect(row.output).toEqual({ valid: true, file: resolve(localPath, 'submit_mini.json') })
    // truth ran through exec over the line protocol; score (host-side) followed
    expect(env.execs).toHaveLength(1)
    expect(env.execs[0]!.argv).toEqual(['sh', '-c', './bin/truth'])
    expect(env.execs[0]!.opts.stdin).toBe(JSON.stringify({ task_id: 's1', workdir: env.workdir }) + '\n')
    expect(env.execs[0]!.opts.timeoutMs).toBe(30_000)
    // E5: the image's own environment plus the pack's declared names and the attempt's TMPDIR — nothing of the host's PATH/HOME/shell
    expect(env.execs[0]!.opts.env).toEqual({ MINIPACK_MODE: 'ok', TMPDIR: resolve(env.workdir, '.tmp') })
    expect(row.truth.status).toBe('settled')
    expect(row.scores.map((s) => s.metric)).toEqual(['pass_rate', 'cost_usd'])
    // S8: the agent's wall time in the environment is on the row
    expect(row.cost.wallMs).toBeTypeOf('number')
    expect(attempts[0]!.cost.wall_s).toBe(row.cost.wallMs! / 1000)
    // the facts are on the row, in its facts_sha, in the materialize marker and on the ledger row
    const facts = env.facts()
    expect(row.environment).toEqual(facts)
    expect(row.facts_sha).toBe(factsSha({ ...FACTS, environment: facts }))
    expect(readStep(localPath, 'materialize')).toMatchObject({ tmpdir: '.tmp', environment: facts })
    expect(attempts[0]!.environment).toEqual(facts)
    // E4: tracked on the scope while open, disposed once with the attempt, then untracked
    expect(env.disposed).toBe(1)
    expect(tracked).toHaveLength(1)
    expect(tracked[0]!.untracked).toBe(1)
    expect(row.error).toBeUndefined()
    // macOS charges the first exec of every freshly copied pack script (~0.4s each); under the full suite's load that passed 5s
  }, 30_000)

  it('defaults to the local provider, and a failed open is a host error on the row before any loop starts', async () => {
    const out = mkdtempSync(resolve(tmpdir(), 'runner-env-'))
    const environments = fakeRegistry(MINI)
    let started = 0
    await runSet({ pack: MINI, loop: 'fake', set: 'smoke', repeat: 1, out, maxTurns: 5, maxMinutes: 2 }, { loops: fakeLoops(() => started++), route: ROUTE, runId: 'run-L', environments })
    expect(environments.opened[0]!.name).toBe('local')
    // the host provider is opened on the attempt dir itself
    expect(environments.opened[0]!.spec).toEqual({ attemptId: 'run-L-s1-0', resources: { timeoutS: 120 }, network: 'none', env: {}, mounts: [], workdir: resolve(out, 'attempts', 'run-L-s1-0') })
    expect(started).toBe(1)
    // the host is no design choice: local facts are on the row as evidence but not in facts_sha, so rows from before the seam still pool
    const local = readFileSync(resolve(out, 'attempts.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))[0]!
    expect(local.environment).toEqual(environments.opened[0]!.env.facts())
    expect(local.facts_sha).toBe(factsSha(FACTS))
    const failing = fakeRegistry(MINI, true)
    const res = await runSet({ pack: MINI, loop: 'fake', set: 'smoke', repeat: 1, out: mkdtempSync(resolve(tmpdir(), 'runner-env-')), maxTurns: 5, maxMinutes: 1 }, { loops: fakeLoops(() => started++), route: ROUTE, runId: 'run-F', environments: failing })
    expect(started).toBe(1)
    expect(res.rows[0]).toMatchObject({ status: 'FAILED', stopReason: 'host_error', error: 'environment: no daemon' })
    expect(res.rows[0]!.environment).toBeUndefined()
  })

  it('resume: a finished loop whose environment is gone is re-run from scratch unless the truth is already on disk', async () => {
    const pack = packWithEnvironment()
    const out = mkdtempSync(resolve(tmpdir(), 'runner-env-'))
    const environments = fakeRegistry(pack)
    let started = 0
    const loops = fakeLoops(() => started++)
    process.env['MINIPACK_MODE'] = 'crash'
    try {
      // the truth crashed after the loop: markers materialize/loop/submit, no truth
      const first = await runSet({ pack, loop: 'fake', set: 'smoke', repeat: 1, out, maxTurns: 5, maxMinutes: 1, env: 'fake' }, { loops, route: ROUTE, runId: 'run-R', environments })
      expect(first.rows[0]!.truth.status).toBe('error')
      const dir = resolve(out, 'attempts', 'run-R-s1-0')
      expect(existsSync(stepPath(dir, 'loop'))).toBe(true)
      expect(existsSync(stepPath(dir, 'truth'))).toBe(false)
      expect(environments.opened[0]!.env.disposed).toBe(1)
      const def = loadPack(pack)
      expect(resumableLoop(def, dir)).toBeUndefined()
      // with the truth settled, the loop is not re-entered
      writeStep(dir, 'run-R-s1-0', 'truth', { truth: { status: 'settled', truth_sha: 'ab'.repeat(32) }, value: { passed: 1, total: 1 } })
      expect(resumableLoop(def, dir)?.step).toBe('loop')
      rmSync(stepPath(dir, 'truth'))
      process.env['MINIPACK_MODE'] = 'ok'
      const res = await runSet({ pack, loop: 'fake', set: 'smoke', repeat: 1, out, maxTurns: 5, maxMinutes: 1, resume: true }, { loops, route: ROUTE, environments })
      // a fresh environment, the loop again, then the truth against the workdir the agent edited
      expect(started).toBe(2)
      expect(environments.opened).toHaveLength(2)
      expect(environments.opened[1]!.env.execs[0]!.opts.stdin).toBe(JSON.stringify({ task_id: 's1', workdir: environments.opened[1]!.env.workdir }) + '\n')
      expect(res.rows[0]!.truth.status).toBe('settled')
      expect(res.rows[0]!.scores.map((s) => s.metric)).toEqual(['pass_rate', 'cost_usd'])
      expect(res.rows[0]!.cost.wallMs).toBeTypeOf('number')
    } finally {
      delete process.env['MINIPACK_MODE']
    }
  }, 30_000)

  it('local: the loop runs in the attempt dir itself, nothing is put or fetched, the agent\'s tree stays after the run, and a resume past a failed truth judges that tree without re-running the loop', async () => {
    const out = mkdtempSync(resolve(tmpdir(), 'runner-env-'))
    const environments = fakeRegistry(MINI)
    const specs: AttemptSpec[] = []
    const loops = fakeLoops((s) => { specs.push(s); writeFileSync(resolve(s.workdir, 'edited'), 'by the agent') })
    const attemptDir = resolve(out, 'attempts', 'run-P-s1-0')
    process.env['MINIPACK_MODE'] = 'crash'
    try {
      const first = await runSet({ pack: MINI, loop: 'fake', set: 'smoke', repeat: 1, out, maxTurns: 5, maxMinutes: 1 }, { loops, route: ROUTE, runId: 'run-P', environments })
      expect(first.rows[0]!.truth.status).toBe('error')
      const { env } = environments.opened[0]!
      // byte-identical to the host workdir before the seam: the attempt dir is the loop's workdir, the sandbox root and TMPDIR
      expect(env.workdir).toBe(attemptDir)
      expect(specs[0]!.workdir).toBe(attemptDir)
      expect(specs[0]!.tmpdir).toBe(resolve(attemptDir, '.tmp'))
      expect(specs[0]!.sandbox?.readWrite).toContain(attemptDir)
      expect(env.puts).toEqual([])
      expect(env.gets).toEqual([])
      expect(env.disposed).toBe(1)
      // what the agent did is still there for post-mortem and for the truth on resume
      expect(readFileSync(resolve(attemptDir, 'edited'), 'utf8')).toBe('by the agent')
      expect(first.rows[0]!.output.valid).toBe(true)
      expect(resumableLoop(loadPack(MINI), attemptDir)?.step).toBe('loop')
      process.env['MINIPACK_MODE'] = 'ok'
      const res = await runSet({ pack: MINI, loop: 'fake', set: 'smoke', repeat: 1, out, maxTurns: 5, maxMinutes: 1, resume: true }, { loops, route: ROUTE, environments })
      // the finished loop stands: no second environment, no second loop, the truth over the tree the agent edited
      expect(specs).toHaveLength(1)
      expect(environments.opened).toHaveLength(1)
      expect(readFileSync(resolve(attemptDir, 'edited'), 'utf8')).toBe('by the agent')
      expect(res.rows[0]!.truth.status).toBe('settled')
      expect(res.rows[0]!.scores.map((s) => s.metric)).toEqual(['pass_rate', 'cost_usd'])
      expect(res.rows[0]!.environment).toEqual(env.facts())
      expect(res.rows[0]!.facts_sha).toBe(factsSha(FACTS))
    } finally {
      delete process.env['MINIPACK_MODE']
    }
  }, 30_000)

  it('local: an attempt re-entered from scratch (no loop marker) replaces what a killed host left in its attempt dir', async () => {
    const out = mkdtempSync(resolve(tmpdir(), 'runner-env-'))
    const environments = fakeRegistry(MINI)
    const loops = fakeLoops(() => {})
    const attemptDir = resolve(out, 'attempts', 'run-K-s1-0')
    const first = await runSet({ pack: MINI, loop: 'fake', set: 'smoke', repeat: 1, out, maxTurns: 5, maxMinutes: 1 }, { loops, route: ROUTE, runId: 'run-K', environments })
    expect(first.rows[0]!.truth.status).toBe('settled')
    // a host killed mid-loop: the tree is there, the loop marker is not
    rmSync(stepPath(attemptDir, 'loop'))
    writeFileSync(resolve(attemptDir, 'left-behind'), 'x')
    const res = await runSet({ pack: MINI, loop: 'fake', set: 'smoke', repeat: 1, out, maxTurns: 5, maxMinutes: 1, resume: true }, { loops, route: ROUTE, environments })
    expect(res.rows[0]).toMatchObject({ status: 'COMPLETED', truth: { status: 'settled' } })
    expect(res.rows[0]!.error).toBeUndefined()
    expect(environments.opened).toHaveLength(2)
    expect(existsSync(resolve(attemptDir, 'left-behind'))).toBe(false)
  })

  it('refuses a named provider without a registry', async () => {
    const out = mkdtempSync(resolve(tmpdir(), 'runner-env-'))
    await expect(runSet({ pack: MINI, loop: 'fake', set: 'smoke', repeat: 1, out, maxTurns: 5, maxMinutes: 1, env: 'docker' }, { loops: fakeLoops(() => {}), route: ROUTE })).rejects.toThrow(/no environments registry/)
  })
})

describe('environment coordinates', () => {
  it('environmentSpecOf: a task row overrides the pack block; the lifetime falls back to the attempt limit; the pack dir is mounted only when a command runs inside', () => {
    const def = loadPack(packWithEnvironment())
    const packMount = [{ from: def.dir, to: def.dir, readOnly: true }]
    expect(environmentSpecOf(def, def.manifest.environment, 'a', { maxMinutes: 1 })).toEqual({ attemptId: 'a', image: { ref: 'example/image:1' }, resources: { cpus: 2, timeoutS: 30 }, network: 'none', env: {}, mounts: packMount })
    const spec = environmentSpecOf(def, { dockerfile: 'env', network: 'allowlist', allowed_hosts: ['example.com'] }, 'b', { maxMinutes: 1.5 })
    expect(spec).toEqual({ attemptId: 'b', image: { dockerfileDir: resolve(def.dir, 'env') }, resources: { timeoutS: 90 }, network: 'allowlist', allowedHosts: ['example.com'], env: {}, mounts: packMount })
    // every command on the host: nothing of the pack goes in
    const host = loadPack(MINI)
    expect(environmentSpecOf(host, { image: 'example/image:1' }, 'c', { maxMinutes: 1 })).toEqual({ attemptId: 'c', image: { ref: 'example/image:1' }, resources: { timeoutS: 60 }, network: 'none', env: {}, mounts: [] })
  })

  it('declaredEnvironmentSha: absent on local, the declared block elsewhere; the champion row carries it', () => {
    const def = loadPack(packWithEnvironment())
    expect(declaredEnvironmentSha(def, { maxMinutes: 1 })).toBeUndefined()
    expect(declaredEnvironmentSha(def, { env: 'local', maxMinutes: 1 })).toBeUndefined()
    const sha = declaredEnvironmentSha(def, { env: 'docker', maxMinutes: 1 })
    expect(sha).toMatch(/^[0-9a-f]{64}$/)
    // rule 0: the provider is not in it
    expect(declaredEnvironmentSha(def, { env: 'modal', maxMinutes: 1 })).toBe(sha)
    const book = bookOf(def)
    const req = { pack: def.dir, loop: 'fake', set: 'smoke' as const, repeat: 1, out: '/o', maxTurns: 5, maxMinutes: 1 }
    const deps = { loops: fakeLoops(() => {}), route: ROUTE }
    expect(championProposal(def, book, req, deps).environment_sha).toBeUndefined()
    expect(championProposal(def, book, { ...req, env: 'docker' }, deps).environment_sha).toBe(sha)
    expect(challengerId(championProposal(def, book, { ...req, env: 'docker' }, deps))).not.toBe(challengerId(championProposal(def, book, req, deps)))
  })

  it('declaredEnvironmentSha: a dockerfile build is declared by the content of its build context', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'envpack-'))
    cpSync(MINI, dir, { recursive: true })
    mkdirSync(resolve(dir, 'env'))
    writeFileSync(resolve(dir, 'env', 'Dockerfile'), 'FROM scratch\n')
    writeFileSync(resolve(dir, 'pack.yaml'), readFileSync(resolve(dir, 'pack.yaml'), 'utf8').replace('commands:\n', 'environment: { dockerfile: env }\ncommands:\n'))
    const one = declaredEnvironmentSha(loadPack(dir), { env: 'docker', maxMinutes: 1 })
    expect(one).toMatch(/^[0-9a-f]{64}$/)
    expect(declaredEnvironmentSha(loadPack(dir), { env: 'docker', maxMinutes: 1 })).toBe(one)
    writeFileSync(resolve(dir, 'env', 'Dockerfile'), 'FROM scratch\nRUN true\n')
    expect(declaredEnvironmentSha(loadPack(dir), { env: 'docker', maxMinutes: 1 })).not.toBe(one)
  })

  it('environmentCommandEnv: the pack\'s declared names and TMPDIR, none of the host allow-list', () => {
    const def = loadPack(MINI)
    const source = { PATH: '/host/bin', HOME: '/Users/host', SHELL: '/bin/zsh', MINIPACK_MODE: 'ok', OTHER: 'x' }
    expect(environmentCommandEnv(def, '/w/.tmp', source)).toEqual({ MINIPACK_MODE: 'ok', TMPDIR: '/w/.tmp' })
  })
})
