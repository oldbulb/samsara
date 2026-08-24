// Pure coordinates recorded beside every challenger (E3): the composed harness
// and the environment it ran in. Never a secret: env names only, never values.

import { createHash } from 'node:crypto'
import { DSH_PIN, composeEntries } from '@oldbulb/samsara-kernel'
import type { EntryOptions, PatchOptions } from '@oldbulb/samsara-kernel'

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

/** JSON with object keys sorted recursively; arrays keep their order; undefined dropped. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[k]
      if (v !== undefined) out[k] = sortKeys(v)
    }
    return out
  }
  return value
}

/** sha256 of the canonical JSON of a composed entry list. */
export function harnessSha(composed: readonly EntryOptions[]): string {
  return sha256(canonicalJson(composed))
}

/** Compose patch layers exactly as boot does (kernel `composeEntries`) and hash the result. */
export function harnessShaOfLayers(layers: readonly PatchOptions[][]): string {
  return harnessSha(composeEntries(layers))
}

/** Env var names (never values) whose presence changes how a run behaves. */
export const ENV_ALLOWLIST: readonly string[] = ['PATH', 'TMPDIR', 'LANG']
export const ENV_PREFIXES: readonly string[] = ['DSH_']

export interface EnvFacts {
  node: string
  platform: string
  arch: string
  dshPin: string
  envNames: string[]
}

export function envFacts(env: NodeJS.ProcessEnv = process.env): EnvFacts {
  const names = Object.keys(env)
    .filter(n => ENV_ALLOWLIST.includes(n) || ENV_PREFIXES.some(p => n.startsWith(p)))
    .sort()
  return { node: process.version, platform: process.platform, arch: process.arch, dshPin: DSH_PIN, envNames: names }
}

/** Legacy coordinates (names + node + dsh pin only). The runner records `envLock(...).sha` instead. */
export function envSha(env: NodeJS.ProcessEnv = process.env): string {
  return sha256(canonicalJson(envFacts(env)))
}
