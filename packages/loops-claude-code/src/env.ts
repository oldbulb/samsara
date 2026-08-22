// Child environment for one attempt. Pure: the credential value comes in as an
// argument and goes out only inside the returned record, never anywhere else.

import { join } from 'node:path'
import type { AttemptSpec } from './seam.ts'

export const CONFIG_DIR_NAME = 'claude-config'

export function configDir(spec: Pick<AttemptSpec, 'tmpdir'>): string {
  return join(spec.tmpdir, CONFIG_DIR_NAME)
}

/**
 * Explicit per-attempt environment (E5/E6). Order: fixed framework values,
 * then route, then `spec.env` overrides. `credentialValue` is the resolved
 * secret for `spec.route.credentialRef`.
 */
export function buildEnv(spec: Pick<AttemptSpec, 'route' | 'tmpdir' | 'env'>, credentialValue: string): Record<string, string> {
  const env: Record<string, string> = {
    ANTHROPIC_AUTH_TOKEN: credentialValue,
    ANTHROPIC_MODEL: spec.route.model,
    ANTHROPIC_SMALL_FAST_MODEL: spec.route.model,
    CLAUDE_CONFIG_DIR: configDir(spec),
    HOME: spec.tmpdir,
    TMPDIR: spec.tmpdir,
    DISABLE_TELEMETRY: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  }
  if (spec.route.baseUrl !== undefined) env['ANTHROPIC_BASE_URL'] = spec.route.baseUrl
  const headers = spec.env?.['ANTHROPIC_CUSTOM_HEADERS']
  if (headers !== undefined) env['ANTHROPIC_CUSTOM_HEADERS'] = headers
  for (const [k, v] of Object.entries(spec.env ?? {})) env[k] = v
  return env
}
