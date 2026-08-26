// @oldbulb/samsara-environments — `ctx.environments`: the registry of
// environment providers.
//
// A provider plugin registers itself with `ctx.effect(() =>
// ctx.environments.register(p))`, so the host's provider set equals its
// enabled plugins. `open` resolves the provider by name; the environment it
// returns is the caller's to dispose (E4: the scope's effect does).

import { Context, Service } from '@oldbulb/samsara-kernel'
import type { Environment, EnvironmentProvider, EnvironmentSpec } from './types.ts'

export * from './types.ts'
export { LocalEnvironmentProvider, LocalEnvironment, type LocalEnvironmentOptions, type SpawnFn } from './local.ts'
export { DockerEnvironmentProvider, DockerEnvironment, envFileText, runArgv, type DockerEnvironmentOptions } from './docker.ts'
export { ModalEnvironmentProvider, ModalEnvironment, createParams as modalCreateParams, pinnedDigest, type ModalClientLike, type ModalEnvironmentOptions } from './modal.ts'

declare module '@oldbulb/samsara-kernel' {
  interface Context {
    environments: Environments
  }
}

export class EnvironmentsError extends Error {
  constructor(message: string, readonly code: 'DUPLICATE_PROVIDER' | 'UNKNOWN_PROVIDER') {
    super(message)
    this.name = 'EnvironmentsError'
  }
}

export class Environments extends Service {
  private readonly providers = new Map<string, EnvironmentProvider>()

  constructor(ctx: Context) {
    super(ctx, 'environments')
  }

  /** Register a provider; the returned disposer removes it. Throws on a duplicate name. */
  register(provider: EnvironmentProvider): () => void {
    const name = provider.name
    return this.ctx.effect(() => {
      if (this.providers.has(name)) {
        throw new EnvironmentsError(`an environment provider named "${name}" is already registered`, 'DUPLICATE_PROVIDER')
      }
      this.providers.set(name, provider)
      return () => { this.providers.delete(name) }
    }, 'environments.register()')
  }

  get(name: string): EnvironmentProvider | undefined {
    return this.providers.get(name)
  }

  list(): EnvironmentProvider[] {
    return [...this.providers.values()]
  }

  /** Open an environment on the named provider. */
  open(name: string, spec: EnvironmentSpec): Promise<Environment> {
    const provider = this.providers.get(name)
    if (!provider) throw new EnvironmentsError(`no environment provider named "${name}"`, 'UNKNOWN_PROVIDER')
    return provider.open(spec)
  }
}

// The loader mounts this module as the `environments` row: a Service class is a plugin.
export default Environments
