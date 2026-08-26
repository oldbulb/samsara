// `propose --dry-run` with a node fixture proposer on the null loop and the
// minipack: the view (with its manifest and environment) is rendered, the
// proposer runs under the command adapter, the proposal is validated and
// diff-scanned, and nothing else happens — no ledger write, no scope, no
// attempt. Offline: the fixture never touches the network.

import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@oldbulb/samsara-kernel'
import type { Ledger } from '@oldbulb/samsara-ledger'
import { NullLoopProvider, factsSha } from '@oldbulb/samsara-loops'
import { CommandAdapter } from '@oldbulb/samsara-proposers'
import type { SandboxHost } from '@oldbulb/samsara-sandbox'
import { realSpawn } from '../../proposers/tests/fixtures/real-spawn.ts'
import { propose, formatPropose, isCommandProposer, type ProposeDeps, type ProposeRequest } from '../src/propose.ts'
import { runProgram, type SamsaraRunValues } from '../src/startup.ts'
import { inject as runnerInject } from '../src/index.ts'

const BUNDLE = resolve(import.meta.dirname, '..', '..', 'bundle', 'cordis.patch.yml')
const MINI = resolve(import.meta.dirname, '..', '..', 'pack', 'tests', 'fixtures', 'minipack')
const FIXTURE = resolve(import.meta.dirname, 'fixtures', 'proposer.mjs')
const UNENFORCED: SandboxHost = { platform: 'darwin', enforcement: 'unusable', launcher: '', exists: () => true }
const nullLoop = new NullLoopProvider()

/** A ledger that only reads (empty views); any write is a missing method, so a dry run that wrote would throw. */
const ledger = { read: (() => []) as Ledger['read'] }

function deps(over: Partial<ProposeDeps> = {}): ProposeDeps {
  return {
    loops: { get: (n) => (n === 'null' ? nullLoop : undefined), start: () => Promise.reject(new Error('no attempt may run in a dry run')) },
    route: { provider: 'p', model: 'm', credentialRef: '' },
    ledger,
    proposers: { get: () => undefined },
    // The request names `./proposer-<mode>`; the factory runs the one node fixture with that mode.
    commandAdapter: (config) => new CommandAdapter({ name: config.name, command: process.execPath, args: [FIXTURE, '--mode', config.name.replace('proposer-', '')] }, { spawn: realSpawn, host: UNENFORCED }),
    ...over,
  }
}

function req(out: string, over: Partial<ProposeRequest> = {}): ProposeRequest {
  return { pack: MINI, loop: 'null', set: 'smoke', repeat: 1, out, maxTurns: 5, maxMinutes: 1, allow: ['read'], proposer: proposerPath('ok'), metric: 'm', dryRun: true, ...over }
}

function proposerPath(m: string): string {
  return `./proposer-${m}`
}

describe('propose --dry-run', () => {
  it('renders the view with its manifest and environment, runs the proposer, validates, scans, and opens nothing', async () => {
    const out = mkdtempSync(join(tmpdir(), 'samsara-propose-'))
    const log: string[] = []
    const r = await propose(req(out, { proposer: proposerPath('ok') }), deps({ log: (l) => log.push(l) }))
    expect(r.scan).toEqual({ ok: true, violations: [] })
    expect(r.proposal.proposer.name).toBe('proposer-ok')
    expect(r.proposal.patch).toEqual({ surface: 'skill', skill_dir: join(out, 'proposer', 'skill') })
    expect(r.proposal.parent).toBe(r.championId)
    expect(r.patchSha).toMatch(/^[0-9a-f]{64}$/)
    expect(r.championId).toMatch(/^[0-9a-f]+$/)
    // the view: manifest, environment, and what the proposer saw of them
    const manifest = JSON.parse(readFileSync(join(r.viewDir, 'view.json'), 'utf8'))
    expect(manifest).toEqual({
      view_version: 1, champion_id: r.championId, metric: 'm',
      files: ['champion.json', 'champion-skill', 'tasks.jsonl', 'champion-attempts.jsonl', 'champion-scores.jsonl', 'compares.jsonl', 'proposal.schema.json', 'environment.md'],
    })
    for (const f of manifest.files) expect(existsSync(join(r.viewDir, f))).toBe(true)
    const env = readFileSync(join(r.viewDir, 'environment.md'), 'utf8')
    expect(env).toContain('- pack: minipack')
    expect(env).toContain('- loop: null (adapter null@0)')
    expect(env).toContain('- envelope fidelity: config absent, system absent, tools absent')
    expect(env).toContain('skill delivery prompt-inline')
    expect(env).toContain('- limits: max turns 5; max minutes 1')
    expect(env).toContain('- tools allowed: `read`')
    expect(env).toContain('- tools denied: (none)')
    expect(env).not.toContain(factsSha(nullLoop.harnessFacts))
    const seen = JSON.parse(readFileSync(join(out, 'proposer', 'seen.json'), 'utf8'))
    expect(seen.manifest).toEqual(manifest)
    expect(seen.tasks.map((t: { task_id: string }) => t.task_id)).toEqual(['s1'])
    expect(seen.environment).toBe(env)
    // nothing but the view, the proposer's work directory and the proposal landed
    expect(readdirSync(out).sort()).toEqual(['proposal.json', 'proposer', 'view'])
    expect(JSON.parse(readFileSync(join(out, 'proposal.json'), 'utf8'))).toEqual(r.proposal)
    expect(log.some((l) => l.startsWith('view rendered at'))).toBe(true)
    // the one-screen summary
    const text = formatPropose(r)
    expect(text).toContain('dry run    no scope opened, no attempt run')
    expect(text).toContain('proposer   proposer-ok@unknown config ')
    expect(text).toContain('surface    skill')
    expect(text).toContain(`patch      ${r.patchSha.slice(0, 12)} ${join(out, 'proposer', 'skill')}`)
    expect(text).toContain('intent     ok proposal')
    expect(text).toContain('prediction m up by 0.1 fixes s1')
    expect(text).toContain('scan       ok')
  })

  it('reports a diff-scan rejection without throwing', async () => {
    const out = mkdtempSync(join(tmpdir(), 'samsara-propose-'))
    const r = await propose(req(out, { proposer: proposerPath('literal') }), deps())
    expect(r.scan.ok).toBe(false)
    expect(r.scan.violations.map((v) => v.code)).toEqual(['TASK_LITERAL'])
    const text = formatPropose(r)
    expect(text).toContain('scan       REJECTED (1 violation(s))')
    expect(text).toContain('TASK_LITERAL skill/SKILL.md')
  })

  it('refuses a proposal naming a held-out task id, a non-skill surface, and the held-out set', async () => {
    await expect(propose(req(mkdtempSync(join(tmpdir(), 'samsara-propose-')), { proposer: proposerPath('holdout') }), deps())).rejects.toThrow(/outside the held-in set: o1/)
    await expect(propose(req(mkdtempSync(join(tmpdir(), 'samsara-propose-')), { proposer: proposerPath('rows') }), deps())).rejects.toThrow(/not a v1 challenger surface/)
    await expect(propose(req(mkdtempSync(join(tmpdir(), 'samsara-propose-')), { set: 'holdout' }), deps())).rejects.toThrow(/held-out set/)
  })

  it('takes a registered adapter by name and refuses an unknown one', async () => {
    expect(isCommandProposer('claude-p')).toBe(false)
    expect(isCommandProposer('./examples/proposers/noop.py')).toBe(true)
    await expect(propose(req(mkdtempSync(join(tmpdir(), 'samsara-propose-')), { proposer: 'nope' }), deps())).rejects.toThrow(/no proposer named "nope"/)
  })
})

describe('propose command line', () => {
  function parse(argv: string[]): { values?: SamsaraRunValues; error?: string } {
    let values: SamsaraRunValues | undefined
    const program = runProgram((v) => { values = v })
    const quiet = (c: typeof program) => { c.exitOverride().configureOutput({ writeErr: () => {}, writeOut: () => {} }); c.commands.forEach(quiet) }
    quiet(program)
    try {
      program.parse(argv, { from: 'user' })
    } catch (e) {
      return { error: (e as Error).message }
    }
    return values ? { values } : {}
  }

  it('parses propose --dry-run with the null loop as default and refuses without --dry-run', () => {
    const { values } = parse(['propose', '--pack', 'p', '--proposer', './x.py', '--set', 'smoke', '--limit', '2', '--metric', 'm', '--out', '/o', '--dry-run'])
    expect(values).toMatchObject({ command: 'propose', pack: 'p', loop: 'null', set: 'smoke', limit: 2, out: '/o', proposer: './x.py', metric: 'm', dryRun: true })
    expect(parse(['propose', '--pack', 'p', '--proposer', './x.py', '--set', 'smoke', '--metric', 'm']).error).toMatch(/--dry-run.*`round`/)
    expect(parse(['propose', '--pack', 'p', '--proposer', 'human', '--set', 'smoke', '--metric', 'm', '--skill-dir', '/s', '--dry-run']).error).toMatch(/--skill-dir and --intent/)
    expect(parse(['propose', '--pack', 'p', '--proposer', './x.py', '--set', 'smoke', '--dry-run']).error).toMatch(/--metric/)
  })
})

describe('the context `propose --proposer ./command` spawns from', () => {
  it('injects subprocess in the plugin and in the bundle row: cordis refuses ctx.subprocess to a plugin that did not', async () => {
    expect(runnerInject).toContain('subprocess')
    const row = /- id: samsara-runner\n\s+name: '@oldbulb\/samsara-runner'\n\s+inject: \[([^\]]*)\]/.exec(readFileSync(BUNDLE, 'utf8'))
    expect(row?.[1]?.split(',').map((s) => s.trim())).toContain('subprocess')

    const probe = async (inject: string[]): Promise<unknown> => {
      const ctx = new Context()
      // provided from a plugin, as the host's rows provide them: a root-level provide is visible to every fiber and guards nothing
      await ctx.plugin({ name: 'host', apply: (c: Context) => { for (const name of runnerInject) c.provide(name, { spawn: () => name }) } })
      let seen: unknown
      await ctx.plugin({ name: 'probe', inject, apply: (c: Context) => { seen = (c as unknown as Record<string, { spawn(): unknown }>)['subprocess']!.spawn() } })
      return seen
    }
    await expect(probe(runnerInject)).resolves.toBe('subprocess')
    await expect(probe(runnerInject.filter((n) => n !== 'subprocess'))).rejects.toThrow(/cannot get property "subprocess" without inject/)
  })
})
