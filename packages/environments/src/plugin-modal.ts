// Plugin: registers the modal provider on `ctx.environments` for the lifetime
// of its scope. The client is built here from credentials named by
// environment variable (E5: the config carries names, never values); with no
// name configured the SDK's own resolution applies (`MODAL_TOKEN_ID` /
// `MODAL_TOKEN_SECRET`, else the active profile of `~/.modal.toml`). Neither
// value is logged or put on any argv.

import { ModalClient, type ModalClientParams } from 'modal'
import { Schema, type Context } from '@oldbulb/samsara-kernel'
import { DEFAULT_MODAL_APP, ModalEnvironmentProvider, type ModalClientLike } from './modal.ts'
import type {} from './index.ts'

export const name = 'environments-modal'
export const inject = ['environments']

export interface Config {
  /** The Modal App the sandboxes are created in (created when missing); default `samsara`. */
  app?: string
  /** The environment variable holding the token id; default: the SDK's own resolution. */
  tokenIdEnv?: string
  /** The environment variable holding the token secret; default: the SDK's own resolution. */
  tokenSecretEnv?: string
}
export const Config: Schema<Config> = Schema.object({
  app: Schema.string().default(DEFAULT_MODAL_APP),
  tokenIdEnv: Schema.string(),
  tokenSecretEnv: Schema.string(),
})

type PluginContext = Pick<Context, 'effect' | 'environments'>

/** A client on the credentials the config names; a named variable that is unset is an error, not a fallback. */
export function createClient(config: Config): ModalClientLike {
  const params: ModalClientParams = {}
  for (const [key, variable] of [['tokenId', config.tokenIdEnv], ['tokenSecret', config.tokenSecretEnv]] as const) {
    if (variable === undefined) continue
    const value = process.env[variable]
    if (value === undefined || value === '') throw new Error(`environments-modal: ${variable} (${key === 'tokenId' ? 'tokenIdEnv' : 'tokenSecretEnv'}) is not set`)
    params[key] = value
  }
  return new ModalClient(params)
}

export function createProvider(_ctx: PluginContext, config: Config, client: ModalClientLike = createClient(config)): ModalEnvironmentProvider {
  return new ModalEnvironmentProvider(config.app === undefined ? { client } : { client, app: config.app })
}

export function apply(ctx: Context, config: Config): void {
  const provider = createProvider(ctx, config)
  ctx.effect(() => ctx.environments.register(provider), 'environments-modal:register')
}
