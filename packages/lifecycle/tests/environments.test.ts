// The executor pass-through for environments: `RunOptions.env` reaches the
// executor's request, `ctx.environments` (when mounted) reaches its deps, and
// a challenger run gets a `track` that binds an environment's dispose to the
// scope's own context (E4).

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@oldbulb/samsara-kernel'
import type { RunDeps, RunRequest } from '../src/executor.ts'
import { challengerProposal, championProposal, openLifecycle, runOptions, PACK, type Harness } from './fakes.ts'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function out(): string {
  const d = mkdtempSync(join(tmpdir(), 'samsara-lifecycle-env-'))
  dirs.push(d)
  return d
}

/** Every executor call's request and deps, recorded around the fake executor. */
function record(h: Harness): { req: RunRequest; deps: RunDeps }[] {
  const seen: { req: RunRequest; deps: RunDeps }[] = []
  const runSet = h.executor.runSet.bind(h.executor)
  h.executor.runSet = (req, deps) => { seen.push({ req, deps }); return runSet(req, deps) }
  return seen
}

describe('environments through the executor', () => {
  it('run: env is on the request; environments and track are on the deps only when the host has them', async () => {
    const h = await openLifecycle()
    const seen = record(h)
    const round = await h.lifecycle.openRound({ pack: PACK, champion: championProposal(), metric: 'm', nEffFloor: 1 })
    const { id } = await h.lifecycle.propose(challengerProposal(round.champion_id, 'one'), { roundId: round.id })
    await h.lifecycle.open(id)
    await h.lifecycle.run(id, 'holdin', runOptions(out(), { env: 'docker', withChampion: true }))
    expect(seen).toHaveLength(2)
    expect(seen.map((s) => s.req.env)).toEqual(['docker', 'docker'])
    expect(seen.every((s) => s.deps.environments === undefined && s.deps.track === undefined)).toBe(true)
    await h.lifecycle.run(id, 'holdin', runOptions(out()))
    expect(seen[2]!.req.env).toBeUndefined()
  })

  it('run: a mounted registry reaches the deps; the challenger run tracks on the scope context, whose disposal disposes what was tracked', async () => {
    const h = await openLifecycle()
    const seen = record(h)
    const environments = { async open() { throw new Error('never opened here') } }
    h.ctx.provide('environments', environments)
    // A scope with a real child context, as ScopeManager returns one.
    const open = h.scopes.open.bind(h.scopes)
    const fiber = new Context().plugin({ name: 'scope', apply() {} })
    await fiber
    h.scopes.open = async (challenger) => ({ ...(await open(challenger)), ctx: fiber.ctx })
    const round = await h.lifecycle.openRound({ pack: PACK, champion: championProposal(), metric: 'm', nEffFloor: 1 })
    const { id } = await h.lifecycle.propose(challengerProposal(round.champion_id, 'one'), { roundId: round.id })
    await h.lifecycle.open(id)
    await h.lifecycle.run(id, 'holdin', runOptions(out(), { withChampion: true }))
    const [champion, challenger] = seen
    expect(champion!.deps.environments).toBe(environments)
    expect(champion!.deps.track).toBeUndefined()
    expect(challenger!.deps.environments).toBe(environments)
    expect(challenger!.deps.track).toBeTypeOf('function')
    // tracked: disposed with the scope; untracked: not
    let disposed = 0
    const untrack = challenger!.deps.track!(async () => { disposed++ })
    challenger!.deps.track!(async () => { disposed++ })
    untrack()
    expect(disposed).toBe(1)
    await fiber.dispose()
    expect(disposed).toBe(2)
  })

  it('calibrate: env and the registry pass through every rerun', async () => {
    const h = await openLifecycle()
    const seen = record(h)
    const environments = { async open() { throw new Error('never opened here') } }
    h.ctx.provide('environments', environments)
    await h.lifecycle.calibrate({ pack: PACK, champion: championProposal(), metric: 'm', set: 'holdout', reruns: 3, run: { ...runOptions(out(), { env: 'docker' }) } })
    expect(seen).toHaveLength(3)
    expect(seen.every((s) => s.req.env === 'docker' && s.deps.environments === environments && s.deps.track === undefined)).toBe(true)
  })
})
