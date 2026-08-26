// End-to-end: a Harbor task as a pack (packs/harbor-hello, what
// tools/pack-from-harbor makes of Harbor's hello-world example) through the
// runner's runSet for real — the task's own image built by the docker
// provider, materialize on the host and the sealed workdir put at the image's
// working directory, an installed loop running Harbor's oracle (the pack's
// bin/oracle: solution/solve.sh in the container), truth inside
// (tests/test.sh writing reward.txt), score on the host — and the same task
// under an installed loop that does nothing. CI runs this on ubuntu (docker
// is there); anywhere without a daemon it skips.
import { afterAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context } from '../packages/kernel/src/index.ts'
import { DockerEnvironmentProvider, Environments, environmentSha } from '../packages/environments/src/index.ts'
import { realSpawn } from '../packages/environments/tests/fixtures/real-spawn.ts'
import { InstalledLoopProvider, LoopRegistry } from '../packages/loops/src/index.ts'
import { loadPack } from '../packages/pack/src/index.ts'
import { runSet, sanitizeId, type AttemptRow, type RunRequest } from '../packages/runner/src/run.ts'

const PACK_DIR = resolve(import.meta.dirname, '..', 'packs', 'harbor-hello')
const TASK_ID = 'harbor/hello-world'
const ROUTE = { provider: 'none', model: 'none', credentialRef: 'none' }
const SHA_RE = /^[0-9a-f]{64}$/

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 20_000 })
    return true
  } catch {
    return false
  }
}

const roots: string[] = []
afterAll(async () => {
  await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })))
})
function tmp(): string {
  const root = mkdtempSync(join(tmpdir(), 'samsara-harbor-'))
  roots.push(root)
  return root
}

describe.skipIf(!dockerAvailable())('packs/harbor-hello in a docker environment (skipped: docker is not on PATH or the daemon is down)', () => {
  const containersOf = (attemptId: string) => execFileSync('docker', ['ps', '-aq', '--filter', `label=samsara.attempt=${attemptId}`], { encoding: 'utf8' }).trim()

  /**
   * The host as `run --loop installed --env docker` mounts it: `ctx.loops` with
   * the installed loop as Harbor's oracle — the pack's `bin/oracle` on the
   * attempt token, reachable because the runner mounts the pack read-only at
   * its own path — and `idle`, the same loop doing nothing; `ctx.environments`
   * with the docker provider.
   */
  async function host(root: string): Promise<Context> {
    const ctx = new Context()
    await ctx.plugin(LoopRegistry)
    ctx.loops.register(new InstalledLoopProvider({ command: ['bash', join(PACK_DIR, 'bin', 'oracle'), '{attempt}'] }))
    const idle = new InstalledLoopProvider({ command: ['true'] })
    ctx.loops.register({ ...idle, name: 'idle', start: (spec) => idle.start(spec) })
    await ctx.plugin(Environments)
    ctx.environments.register(new DockerEnvironmentProvider({ spawn: realSpawn, baseDir: join(root, 'base') }))
    return ctx
  }

  /** The pack's one smoke task once under `loop`, in its own container. */
  async function run(ctx: Context, loop: string, out: string): Promise<AttemptRow> {
    const req: RunRequest = { pack: PACK_DIR, loop, set: 'smoke', repeat: 1, parallel: 1, out, maxTurns: 1, maxMinutes: 10, env: 'docker' }
    const result = await runSet(req, { loops: ctx.loops, route: ROUTE, environments: ctx.environments, runId: `harbor-${loop}`, log: (line) => process.stderr.write(`${line}\n`) })
    expect(result.rows).toHaveLength(1)
    return result.rows[0]!
  }

  it('the oracle scores reward 1 and a loop that does nothing reward 0: the workdir at the image WORKDIR, truth inside, score on the host', { timeout: 900_000 }, async () => {
    const root = tmp()
    const ctx = await host(root)
    const def = loadPack(PACK_DIR)
    const task = def.taskSets.smoke.tasks[0]!
    expect(task.task_id).toBe(TASK_ID)
    // the task's tests assume the image's working directory; the row says so and the runner opens the environment there
    expect(task['workdir']).toBe('/app')

    const oracle = await run(ctx, 'installed', join(root, 'oracle'))
    expect(oracle.error).toBeUndefined()
    expect(oracle).toMatchObject({
      attemptId: `harbor-installed-${sanitizeId(TASK_ID)}-0`, task_id: TASK_ID, loop: 'installed', status: 'COMPLETED', stopReason: 'completed',
      truth: { status: 'settled', truth_sha: expect.stringMatching(SHA_RE) },
    })
    // the contract is {} and finishing is the submission: the oracle leaves no submit file, so the output is not valid — the reward never depended on it
    expect(oracle.output).toMatchObject({ valid: false, error: expect.stringMatching(/no submit file/) })
    expect(oracle.scores).toEqual([{ task_id: TASK_ID, metric: 'reward', value: 1, kind: 'reality', stratum: 'harbor-hello' }])
    // what ran: the task's own image (a dockerfile build — the daemon's image id stands for the digest), its resources, the network it asked for
    expect(oracle.environment).toEqual({
      provider: 'docker', version: expect.any(String),
      image: { digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) }, resources: { cpus: 1, memoryMb: 2048, timeoutS: 600 }, network: 'public',
    })
    // the oracle's stdout (solve.sh's "Done!") came back into the attempt dir
    expect(readFileSync(join(root, 'oracle', 'attempts', oracle.attemptId, '.installed', 'stdout'), 'utf8')).toContain('Done!')

    const idle = await run(ctx, 'idle', join(root, 'idle'))
    expect(idle.error).toBeUndefined()
    expect(idle).toMatchObject({ loop: 'idle', status: 'COMPLETED', stopReason: 'completed', truth: { status: 'settled', truth_sha: oracle.truth.truth_sha } })
    expect(idle.scores).toEqual([{ task_id: TASK_ID, metric: 'reward', value: 0, kind: 'reality', stratum: 'harbor-hello' }])
    // rule 0: one design across the two runs (the same image, resources and network); two harnesses (the commands differ), so the rows never pool
    expect(environmentSha(idle.environment!)).toBe(environmentSha(oracle.environment!))
    expect(idle.facts_sha).not.toBe(oracle.facts_sha)

    // E4: disposed with the attempt, nothing lingers
    for (const row of [oracle, idle]) expect(containersOf(row.attemptId)).toBe('')
  })
})
