import { describe, expect, it } from 'vitest'
import { runProgram, DEFAULTS, type SamsaraRunValues } from '../src/startup.ts'
import { routeOf } from '../src/index.ts'

function parse(argv: string[]): { values?: SamsaraRunValues; error?: string } {
  let values: SamsaraRunValues | undefined
  const program = runProgram((v) => { values = v })
  // parseCmdline does this walk in production; commander copies overrides into subcommands only at registration.
  const quiet = (c: typeof program) => { c.exitOverride().configureOutput({ writeErr: () => {}, writeOut: () => {} }); c.commands.forEach(quiet) }
  quiet(program)
  try {
    program.parse(argv, { from: 'user' })
  } catch (e) {
    return { error: (e as Error).message }
  }
  return values ? { values } : {}
}

describe('samsara-run-startup', () => {
  it('parses the run command with defaults', () => {
    const { values } = parse(['run', '--pack', 'packs/x', '--loop', 'dsh', '--set', 'smoke'])
    expect(values).toEqual({ pack: 'packs/x', loop: 'dsh', set: 'smoke', repeat: DEFAULTS.repeat, out: DEFAULTS.out, maxTurns: DEFAULTS.maxTurns, maxMinutes: DEFAULTS.maxMinutes })
  })
  it('parses every option', () => {
    const { values } = parse(['run', '--pack', 'p', '--loop', 'claude-code', '--set', 'holdout', '--limit', '3', '--repeat', '2', '--out', '/o', '--max-turns', '7', '--max-minutes', '1.5', '--allow', 'read, bash,,edit'])
    expect(values).toEqual({ pack: 'p', loop: 'claude-code', set: 'holdout', limit: 3, repeat: 2, out: '/o', maxTurns: 7, maxMinutes: 1.5, allow: ['read', 'bash', 'edit'] })
  })
  it('rejects a bad set, a missing required option, and repeat < 1', () => {
    expect(parse(['run', '--pack', 'p', '--loop', 'l', '--set', 'live']).error).toMatch(/--set must be one of/)
    expect(parse(['run', '--pack', 'p', '--set', 'smoke']).error).toMatch(/--loop/)
    expect(parse(['run', '--pack', 'p', '--loop', 'l', '--set', 'smoke', '--repeat', '0']).error).toMatch(/--repeat/)
    expect(parse(['run', '--pack', 'p', '--loop', 'l', '--set', 'smoke', '--limit', 'x']).error).toMatch(/--limit/)
  })
  it('provides nothing on --help', () => {
    const r = parse(['--help'])
    expect(r.values).toBeUndefined()
  })
})

describe('routeOf', () => {
  it('merges the default model selection with the plugin config', () => {
    expect(routeOf({ provider: 'p', model: 'm' }, {})).toEqual({ provider: 'p', model: 'm', credentialRef: '' })
    expect(routeOf({ provider: 'p', model: 'm', reasoningEffort: 'high' }, { baseUrl: 'http://x', credentialRef: 'k', lane: 'a' }))
      .toEqual({ provider: 'p', model: 'm', credentialRef: 'k', baseUrl: 'http://x', reasoning: { effort: 'high', lane: 'a' } })
  })
})
