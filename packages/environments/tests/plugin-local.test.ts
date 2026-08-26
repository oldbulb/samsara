// bindSpawn under the tree's teardown (E4): cordis unloads sibling fibers in
// parallel, so a provider plugin can be inactive while the runner is still
// disposing its attempts; the kill an environment's dispose spawns then must
// still run.

import { describe, expect, it } from 'vitest'
import { Context, type SubprocessHandle, type SubprocessOutcome, type SubprocessSpawnSpec } from '@oldbulb/samsara-kernel'
import { bindSpawn } from '../src/plugin-local.ts'

function fakeHandle(): SubprocessHandle {
  const done = Promise.resolve<SubprocessOutcome>({ exitCode: 0, signal: null })
  return { pid: 1, stdin: undefined, stdout: undefined, stderr: undefined, collected: {}, done, terminate() {}, async waitForExit() { return true } }
}

const SPEC: SubprocessSpawnSpec = { argv: ['docker', 'rm', '-f', 'cid'], cwd: '/', stdio: { stdin: 'ignore', stdout: { maxBytes: 1 }, stderr: { maxBytes: 1 } }, graceMs: 100 }

describe('bindSpawn', () => {
  it('spawns inside the plugin\'s effect while the scope lives, and still spawns the teardown\'s own child once the scope is gone', async () => {
    const root = new Context()
    const spawned: SubprocessSpawnSpec[] = []
    root.provide('subprocess', { spawn: (spec: SubprocessSpawnSpec) => { spawned.push(spec); return fakeHandle() } } as unknown as Context['subprocess'])
    let spawn: ReturnType<typeof bindSpawn> | undefined
    let providerCtx: Context | undefined
    let teardown: Promise<unknown> | undefined
    // Two siblings under one group, as the environments-docker and runner rows are: the runner's disposer awaits its in-flight attempts, whose dispose spawns the kill through the provider.
    const group = root.plugin({
      name: 'group',
      apply(ctx: Context) {
        ctx.plugin({ name: 'provider', inject: ['subprocess'], apply(c: Context) { providerCtx = c; spawn = bindSpawn(c, 'test:child') } })
        ctx.plugin({
          name: 'runner',
          apply(c: Context) {
            c.effect(() => async () => {
              await new Promise((r) => setTimeout(r, 20))
              teardown = Promise.resolve().then(() => spawn!(SPEC).done)
              await teardown
            })
          },
        })
      },
    })
    await group
    await spawn!(SPEC).done
    expect(spawned).toHaveLength(1)
    await group.dispose()
    // the provider's scope was inactive when the runner reached for the kill
    expect(() => providerCtx!.effect(() => {})).toThrow(/inactive/)
    await expect(teardown).resolves.toEqual({ exitCode: 0, signal: null })
    expect(spawned).toHaveLength(2)
    expect(spawned[1]).toBe(SPEC)
  })
})
