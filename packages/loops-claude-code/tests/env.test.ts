import { describe, expect, it } from 'vitest'
import { buildEnv } from '../src/env.ts'
import { harnessFacts, capabilities } from '../src/index.ts'

const SECRET = 'sk-never-logged-0123456789'
const spec = {
  route: { provider: 'anthropic', model: 'model-x', baseUrl: 'http://proxy.local/attempt-1', credentialRef: 'ROUTE_TOKEN' },
  tmpdir: '/tmp/attempt-1',
  env: { ANTHROPIC_CUSTOM_HEADERS: 'x-attempt: 1', EXTRA: 'yes' },
}

describe('buildEnv', () => {
  it('builds the explicit per-attempt environment', () => {
    const env = buildEnv(spec, SECRET)
    expect(env).toMatchObject({
      ANTHROPIC_BASE_URL: 'http://proxy.local/attempt-1',
      ANTHROPIC_AUTH_TOKEN: SECRET,
      ANTHROPIC_MODEL: 'model-x',
      ANTHROPIC_SMALL_FAST_MODEL: 'model-x',
      ANTHROPIC_CUSTOM_HEADERS: 'x-attempt: 1',
      CLAUDE_CONFIG_DIR: '/tmp/attempt-1/claude-config',
      HOME: '/tmp/attempt-1',
      TMPDIR: '/tmp/attempt-1',
      DISABLE_TELEMETRY: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      EXTRA: 'yes',
    })
  })
  it('spec.env overrides framework values; no baseUrl → no ANTHROPIC_BASE_URL', () => {
    const env = buildEnv({ ...spec, route: { ...spec.route, baseUrl: undefined }, env: { HOME: '/elsewhere' } }, SECRET)
    expect(env['HOME']).toBe('/elsewhere')
    expect('ANTHROPIC_BASE_URL' in env).toBe(false)
  })
  it('the credential never appears in the static facts or capabilities', () => {
    buildEnv(spec, SECRET)
    expect(JSON.stringify(harnessFacts)).not.toContain(SECRET)
    expect(JSON.stringify(capabilities)).not.toContain(SECRET)
  })
})
