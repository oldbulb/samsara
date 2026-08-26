// Plugin: registers the docker provider on `ctx.environments` for the
// lifetime of its scope. The docker client is spawned through
// `ctx.subprocess` inside this plugin's own effect (E4).

import { Schema, type Context } from '@oldbulb/samsara-kernel'
import { DockerEnvironmentProvider, DEFAULT_IMAGE_TIMEOUT_MS, type DockerEnvironmentOptions } from './docker.ts'
import { bindSpawn } from './plugin-local.ts'
import type {} from './index.ts'

export const name = 'environments-docker'
export const inject = ['environments', 'subprocess']

export interface Config {
  /** The docker binary: a bare name on PATH or an absolute path. */
  docker?: string
  /** Where env files are written; default: `<os tmpdir>/samsara-environments`. */
  baseDir?: string
  /** Deadline for `docker build` / `docker pull`. */
  imageTimeoutMs?: number
}
export const Config: Schema<Config> = Schema.object({
  docker: Schema.string().default('docker'),
  baseDir: Schema.string(),
  imageTimeoutMs: Schema.number().default(DEFAULT_IMAGE_TIMEOUT_MS),
})

type PluginContext = Pick<Context, 'effect' | 'subprocess' | 'environments'>

export function createProvider(ctx: PluginContext, config: Config): DockerEnvironmentProvider {
  const options: DockerEnvironmentOptions = { spawn: bindSpawn(ctx, 'environments-docker:client') }
  if (config.docker !== undefined) options.docker = config.docker
  if (config.baseDir !== undefined) options.baseDir = config.baseDir
  if (config.imageTimeoutMs !== undefined) options.imageTimeoutMs = config.imageTimeoutMs
  return new DockerEnvironmentProvider(options)
}

export function apply(ctx: Context, config: Config): void {
  const provider = createProvider(ctx, config)
  ctx.effect(() => ctx.environments.register(provider), 'environments-docker:register')
}
