// Plugin: registers the local provider on `ctx.environments` for the lifetime
// of its scope. Children are spawned through `ctx.subprocess` inside this
// plugin's own effect (E4).

import { Schema, type Context, type SubprocessHandle, type SubprocessSpawnSpec } from '@oldbulb/samsara-kernel'
import { LocalEnvironmentProvider } from './local.ts'
import type {} from './index.ts'

export const name = 'environments-local'
export const inject = ['environments', 'subprocess']

export interface Config {
  /** Where environments without a `workdir` are created; default: `<os tmpdir>/samsara-environments`. */
  baseDir?: string
}
export const Config: Schema<Config> = Schema.object({
  baseDir: Schema.string(),
})

type PluginContext = Pick<Context, 'effect' | 'subprocess' | 'environments'>

/**
 * A SpawnFn over `ctx.subprocess` whose child is terminated with the plugin's
 * scope. Once the scope is gone — cordis unloads sibling fibers in parallel,
 * so this plugin can be inactive while the runner is still disposing its
 * attempts — a spawn is the teardown's own (an environment's dispose reaching
 * for its kill, `docker rm -f`) and runs without an effect: there is no scope
 * left to end it, and the dispose that asked for it awaits it.
 */
export function bindSpawn(ctx: Pick<Context, 'effect' | 'subprocess'>, label: string): (spec: SubprocessSpawnSpec) => SubprocessHandle {
  // Taken while the scope is active: an inactive context refuses the service lookup, and the teardown spawn needs it.
  const subprocess = ctx.subprocess
  return (spec) => {
    let child: SubprocessHandle | undefined
    let dispose: (() => void) | undefined
    try {
      dispose = ctx.effect(() => {
        child = subprocess.spawn(spec)
        return () => { child?.terminate() }
      }, label)
    } catch (e) {
      if ((e as { code?: unknown }).code !== 'INACTIVE_EFFECT') throw e
      child = subprocess.spawn(spec)
    }
    if (dispose) child!.done.then(dispose, dispose)
    return child!
  }
}

export function createProvider(ctx: PluginContext, config: Config): LocalEnvironmentProvider {
  const spawn = bindSpawn(ctx, 'environments-local:child')
  return new LocalEnvironmentProvider(config.baseDir === undefined ? { spawn } : { spawn, baseDir: config.baseDir })
}

export function apply(ctx: Context, config: Config): void {
  const provider = createProvider(ctx, config)
  ctx.effect(() => ctx.environments.register(provider), 'environments-local:register')
}
