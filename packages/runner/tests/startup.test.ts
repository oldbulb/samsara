import { describe, expect, it } from 'vitest'
import { runProgram, DEFAULTS, type SamsaraRunValues } from '../src/startup.ts'
import { routeOf } from '../src/index.ts'
import { gatePolicyNames, gatePresetOf } from '../src/challenge.ts'

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
    expect(values).toEqual({ command: 'run', pack: 'packs/x', loop: 'dsh', set: 'smoke', repeat: DEFAULTS.repeat, parallel: DEFAULTS.parallel, out: DEFAULTS.out, maxTurns: DEFAULTS.maxTurns, maxMinutes: DEFAULTS.maxMinutes })
  })
  it('parses every option', () => {
    const { values } = parse(['run', '--pack', 'p', '--loop', 'claude-code', '--set', 'holdout', '--limit', '3', '--stratum', 'rust, go', '--repeat', '2', '--parallel', '4', '--out', '/o', '--max-turns', '7', '--max-minutes', '1.5', '--allow', 'read, bash,,edit'])
    expect(values).toEqual({ command: 'run', pack: 'p', loop: 'claude-code', set: 'holdout', limit: 3, stratum: ['rust', 'go'], repeat: 2, parallel: 4, out: '/o', maxTurns: 7, maxMinutes: 1.5, allow: ['read', 'bash', 'edit'] })
  })
  it('parses --env on the running commands; absent, nothing is set (the runner defaults to local)', () => {
    expect(parse(['run', '--pack', 'p', '--loop', 'l', '--set', 'smoke', '--env', 'docker']).values).toMatchObject({ command: 'run', env: 'docker' })
    expect(parse(['calibrate', '--pack', 'p', '--loop', 'l', '--metric', 'm', '--env', 'docker']).values).toMatchObject({ command: 'calibrate', env: 'docker' })
    expect(parse(['control', 'aa', '--pack', 'p', '--loop', 'l', '--metric', 'm', '--env', 'docker']).values).toMatchObject({ command: 'control', env: 'docker' })
    expect(parse(['certify', '--pack', 'p', '--skill-dir', '/s', '--loops', 'a,b', '--set', 'smoke', '--metric', 'm', '--env', 'docker']).values).toMatchObject({ command: 'certify', env: 'docker' })
    expect('env' in parse(['run', '--pack', 'p', '--loop', 'l', '--set', 'smoke']).values).toBe(false)
  })
  it('rejects a bad set, a missing required option, and repeat < 1', () => {
    expect(parse(['run', '--pack', 'p', '--loop', 'l', '--set', 'live']).error).toMatch(/--set must be one of/)
    expect(parse(['run', '--pack', 'p', '--set', 'smoke']).error).toMatch(/--loop/)
    expect(parse(['run', '--pack', 'p', '--loop', 'l', '--set', 'smoke', '--repeat', '0']).error).toMatch(/--repeat/)
    expect(parse(['run', '--pack', 'p', '--loop', 'l', '--set', 'smoke', '--parallel', '0']).error).toMatch(/--parallel/)
    expect(parse(['run', '--pack', 'p', '--loop', 'l', '--set', 'smoke', '--limit', 'x']).error).toMatch(/--limit/)
  })
  it('parses certify with its loop list and defaults', () => {
    const { values } = parse(['certify', '--pack', 'p', '--skill-dir', '/s', '--loops', 'dsh, claude-code', '--set', 'smoke', '--limit', '3', '--metric', 'm'])
    expect(values).toEqual({
      command: 'certify', pack: 'p', set: 'smoke', limit: 3, repeat: DEFAULTS.repeat, parallel: DEFAULTS.parallel, out: DEFAULTS.out, maxTurns: DEFAULTS.maxTurns, maxMinutes: DEFAULTS.maxMinutes,
      skillDir: '/s', loops: ['dsh', 'claude-code'], metric: 'm', nEffFloor: DEFAULTS.nEffFloor, gatePolicy: 'default',
    })
    // The metric is the pack's to name: no command carries a default metric name.
    expect(parse(['certify', '--pack', 'p', '--skill-dir', '/s', '--loops', 'dsh', '--set', 'smoke']).error).toMatch(/--metric/)
    expect(parse(['certify', '--pack', 'p', '--skill-dir', '/s', '--set', 'smoke', '--metric', 'm']).error).toMatch(/--loops/)
    expect(parse(['certify', '--pack', 'p', '--skill-dir', '/s', '--loops', ',', '--set', 'smoke', '--metric', 'm']).error).toMatch(/at least one loop/)
  })
  it('parses --skill-dir on run as the skill to run instead of the pack default', () => {
    expect(parse(['run', '--pack', 'p', '--loop', 'null', '--set', 'holdin', '--skill-dir', '/min']).values).toMatchObject({ command: 'run', skillDir: '/min' })
    expect(parse(['run', '--pack', 'p', '--loop', 'null', '--set', 'holdin']).values).not.toHaveProperty('skillDir')
  })
  it('parses --round on challenge, round and promote, and --wait on demote', () => {
    const base = ['--pack', 'p', '--loop', 'null', '--set', 'holdin', '--metric', 'm']
    const chal = ['challenge', ...base, '--surface', 'skill', '--skill-dir', '/s', '--intent', 'i']
    expect(parse([...chal, '--round', 'r1']).values).toMatchObject({ command: 'challenge', round: 'r1' })
    expect(parse(chal).values).not.toHaveProperty('round')
    expect(parse(chal).values).not.toHaveProperty('noiseFloor')
    expect(parse(['round', ...base, '--proposer', 'human', '--round', 'r2']).values).toMatchObject({ command: 'round', round: 'r2' })
    expect(parse(['promote', 'c1', '--round', 'r3', '--wait', '5']).values).toEqual({ command: 'promote', challengerId: 'c1', round: 'r3', wait: 5 })
    expect(parse(['demote', 'c1', '--reason', 'why', '--wait', '5']).values).toEqual({ command: 'demote', challengerId: 'c1', reason: 'why', wait: 5 })
    expect(parse(['demote', 'c1', '--reason', 'why']).values).toEqual({ command: 'demote', challengerId: 'c1', reason: 'why' })
  })
  it('parses ledger backup with the bundle sqlite path as the default --db', () => {
    expect(parse(['ledger', 'backup', '--out', '/b/ledger.sqlite']).values).toEqual({ command: 'ledger-backup', db: 'data/ledger/samsara_ledger.sqlite', out: '/b/ledger.sqlite' })
    expect(parse(['ledger', 'backup', '--db', '/d.sqlite', '--out', '/b.sqlite']).values).toEqual({ command: 'ledger-backup', db: '/d.sqlite', out: '/b.sqlite' })
    expect(parse(['ledger', 'backup']).error).toMatch(/--out/)
  })

  it('parses calibrate with --reruns and a default set, and rejects fewer than 3 reruns', () => {
    expect(parse(['calibrate', '--pack', 'p', '--loop', 'null', '--metric', 'm']).values).toEqual({
      command: 'calibrate', pack: 'p', loop: 'null', set: 'holdin', parallel: DEFAULTS.parallel, out: DEFAULTS.out, maxTurns: DEFAULTS.maxTurns, maxMinutes: DEFAULTS.maxMinutes, metric: 'm', reruns: DEFAULTS.reruns,
    })
    expect(parse(['calibrate', '--pack', 'p', '--loop', 'null', '--metric', 'm', '--set', 'smoke', '--reruns', '5', '--limit', '2']).values).toMatchObject({ set: 'smoke', reruns: 5, limit: 2 })
    expect(parse(['calibrate', '--pack', 'p', '--loop', 'null', '--metric', 'm', '--reruns', '2']).error).toMatch(/--reruns/)
    expect(parse(['calibrate', '--pack', 'p', '--loop', 'null', '--metric', 'm', '--repeat', '2']).error).toMatch(/unknown option/)
  })
  it('parses experiment new with its prediction and budget', () => {
    expect(parse(['experiment', 'new', '--pack', 'p', '--hypothesis', 'h', '--metric', 'm']).values).toEqual({ command: 'experiment-new', pack: 'p', hypothesis: 'h', metric: 'm', direction: 'up', nEffFloor: DEFAULTS.nEffFloor })
    expect(parse(['experiment', 'new', '--pack', 'p', '--hypothesis', 'h', '--metric', 'm', '--direction', 'down', '--magnitude', '0.05', '--budget-usd', '20', '--budget-rounds', '5', '--budget-attempts', '100', '--budget-holdout-reveals', '2', '--who', 'me']).values)
      .toEqual({ command: 'experiment-new', pack: 'p', hypothesis: 'h', metric: 'm', direction: 'down', magnitude: 0.05, budgetUsd: 20, budgetRounds: 5, budgetAttempts: 100, budgetHoldoutReveals: 2, nEffFloor: DEFAULTS.nEffFloor, who: 'me' })
    expect(parse(['experiment', 'new', '--pack', 'p', '--hypothesis', 'h', '--metric', 'm', '--direction', 'sideways']).error).toMatch(/--direction/)
  })
  it('parses campaign with its stop rules, and refuses the held-out set', () => {
    const base = ['campaign', '--pack', 'p', '--loop', 'null', '--experiment', 'e', '--proposer', 'claude-p', '--metric', 'm']
    expect(parse(base).values).toEqual({
      command: 'campaign', pack: 'p', loop: 'null', set: 'holdin', repeat: DEFAULTS.repeat, parallel: DEFAULTS.parallel, out: DEFAULTS.out, maxTurns: DEFAULTS.maxTurns, maxMinutes: DEFAULTS.maxMinutes,
      experiment: 'e', proposer: 'claude-p', metric: 'm', rounds: DEFAULTS.rounds, autoHoldout: false, stopOnPromote: false, nEffFloor: DEFAULTS.nEffFloor,
    })
    expect(parse([...base, '--rounds', '5', '--auto-holdout', '--stop-on-promote', '--max-consecutive-holds', '2', '--max-repeat', '4', '--holdout-repeat', '2', '--budget-usd', '9.5', '--shadow-gates', 'keep-better@0.1.0,miller@0.1.0', '--wait', '30']).values)
      .toMatchObject({ rounds: 5, autoHoldout: true, stopOnPromote: true, maxConsecutiveHolds: 2, maxRepeat: 4, holdoutRepeat: 2, budgetUsd: 9.5, shadowGates: ['keep-better@0.1.0', 'miller@0.1.0'], wait: 30 })
    expect(parse([...base, '--set', 'holdout']).error).toMatch(/holdout/)
    expect(parse(['campaign', '--pack', 'p', '--loop', 'null', '--proposer', 'claude-p', '--metric', 'm']).error).toMatch(/--experiment/)
  })
  it('parses control aa|inject at holdout and requires --skill-dir for inject', () => {
    expect(parse(['control', 'aa', '--pack', 'p', '--loop', 'null', '--metric', 'm']).values).toEqual({
      command: 'control', kind: 'aa', pack: 'p', loop: 'null', repeat: DEFAULTS.repeat, parallel: DEFAULTS.parallel, out: DEFAULTS.out, maxTurns: DEFAULTS.maxTurns, maxMinutes: DEFAULTS.maxMinutes, metric: 'm', nEffFloor: DEFAULTS.nEffFloor,
    })
    expect(parse(['control', 'inject', '--pack', 'p', '--loop', 'null', '--metric', 'm', '--skill-dir', '/s', '--experiment', 'e', '--shadow-gates', 'miller']).values)
      .toMatchObject({ command: 'control', kind: 'inject', skillDir: '/s', experiment: 'e', shadowGates: ['miller'] })
    expect(parse(['control', 'inject', '--pack', 'p', '--loop', 'null', '--metric', 'm']).error).toMatch(/--skill-dir/)
    expect(parse(['control', 'ab', '--pack', 'p', '--loop', 'null', '--metric', 'm']).error).toMatch(/aa or inject/)
    expect(parse(['control', 'aa', '--pack', 'p', '--loop', 'null', '--metric', 'm', '--set', 'smoke']).error).toMatch(/unknown option/)
  })
  it('parses status', () => {
    expect(parse(['status']).values).toEqual({ command: 'status' })
  })
  it('parses round with a human proposer from the command line and rejects --skill-dir without --intent', () => {
    const { values } = parse(['round', '--pack', 'p', '--loop', 'null', '--set', 'holdin', '--limit', '2', '--proposer', 'human', '--metric', 'm', '--skill-dir', '/s', '--intent', 'i'])
    expect(values).toMatchObject({ command: 'round', proposer: 'human', metric: 'm', humanSkillDir: '/s', intent: 'i', nEffFloor: DEFAULTS.nEffFloor, withChampion: false, gatePolicy: 'default', limit: 2 })
    expect(values).not.toHaveProperty('skillDir')
    expect(parse(['round', '--pack', 'p', '--loop', 'null', '--set', 'holdin', '--proposer', 'claude-p', '--metric', 'm', '--skill-dir', '/s']).error).toMatch(/--skill-dir and --intent/)
    expect(parse(['round', '--pack', 'p', '--loop', 'null', '--set', 'holdin', '--proposer', 'claude-p']).error).toMatch(/--metric/)
  })
  it('accepts a catalog rule as --gate-policy on challenge, round and certify, and rejects an unknown name', () => {
    const chal = ['challenge', '--pack', 'p', '--loop', 'null', '--set', 'smoke', '--metric', 'm', '--surface', 'skill', '--skill-dir', '/s', '--intent', 'i']
    expect(parse([...chal, '--gate-policy', 'keep-better']).values).toMatchObject({ command: 'challenge', gatePolicy: 'keep-better' })
    expect(parse([...chal, '--gate-policy', 'miller@0.1.0']).values).toMatchObject({ gatePolicy: 'miller@0.1.0' })
    expect(parse([...chal, '--gate-policy', 'fast']).values).toMatchObject({ gatePolicy: 'fast' })
    expect(parse(chal).values).toMatchObject({ gatePolicy: 'default' })
    expect(parse(['round', '--pack', 'p', '--loop', 'null', '--set', 'holdin', '--proposer', 'human', '--metric', 'm', '--gate-policy', 'pace']).values).toMatchObject({ command: 'round', gatePolicy: 'pace' })
    expect(parse(['certify', '--pack', 'p', '--skill-dir', '/s', '--loops', 'a', '--set', 'smoke', '--metric', 'm', '--gate-policy', 'mcnemar']).values).toMatchObject({ command: 'certify', gatePolicy: 'mcnemar' })
    expect(parse([...chal, '--gate-policy', 'nope']).error).toMatch(/--gate-policy must be one of default\|fast\|permissive\|keep-better.*, got nope/)
    expect(gatePresetOf('keep-better')).toMatchObject({ name: 'keep-better', version: '0.1.0' })
    expect(gatePresetOf('default')).toBeUndefined()
    expect(gatePolicyNames().slice(0, 4)).toEqual(['default', 'fast', 'permissive', 'keep-better'])
  })
  it('parses gate change with its name@version subject and --wait, and rejects a subject that is not one', () => {
    expect(parse(['gate', 'change', 'keep-better@0.1.0']).values).toEqual({ command: 'gate-change', gate: 'keep-better@0.1.0' })
    expect(parse(['gate', 'change', 'keep-better@0.1.0', '--wait', '30']).values).toEqual({ command: 'gate-change', gate: 'keep-better@0.1.0', wait: 30 })
    expect(parse(['gate', 'change', 'keep-better']).error).toMatch(/name@version/)
    expect(parse(['gate', 'change', 'keep-better@0.1.0', '--wait', '0']).error).toMatch(/--wait/)
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
