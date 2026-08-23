// policyFor / assertPolicy / apply with an injected host: no launcher is
// spawned, no kernel is consulted, nothing on disk is read.
import { describe, expect, it } from 'vitest'
import type { SubprocessSpawnSpec } from '@samsara/kernel'
import {
  DEFAULT_SYSTEM_ROOTS,
  HOME_DENIED,
  PACK_DENIED,
  PACK_READ_ONLY,
  SandboxError,
  apply,
  assertPolicy,
  policyFor,
  sandboxModeOf,
  type SandboxHost,
  type SandboxPolicy,
} from '../src/index.ts'

const PACK = '/srv/packs/demo'
const WORK = '/srv/runs/r1/att-1'
const input = {
  workdir: WORK,
  packDir: PACK,
  runtimeDirs: [`${PACK}/runtime/py`, `${PACK}/runtime/js`],
  ledgerDir: '/srv/samsara/data/ledger',
  homeDir: '/home/op',
  denied: ['/srv/samsara/data/signoff'],
}

function isUnder(p: string, root: string): boolean {
  return p === root || p.startsWith(root + '/')
}

function spec(): SubprocessSpawnSpec {
  return { argv: ['claude', '-p', 'x'], cwd: WORK, stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'inherit' }, graceMs: 100, env: { HOME: WORK } }
}

function host(over: Partial<SandboxHost> = {}): SandboxHost {
  return { platform: 'linux', enforcement: 'full', launcher: '/opt/landlock-run', exists: () => true, ...over }
}

describe('policyFor', () => {
  it('grants the workdir rw, system roots + pack skill/loader + runtimes ro, and lists the denied set', () => {
    const p = policyFor(input)
    expect(p.readWrite).toEqual([WORK, '/dev/null'])
    expect(p.readOnly).toEqual([...DEFAULT_SYSTEM_ROOTS, ...PACK_READ_ONLY.map((r) => `${PACK}/${r}`), ...input.runtimeDirs])
    expect(p.denied).toEqual([
      ...PACK_DENIED.map((r) => `${PACK}/${r}`),
      input.ledgerDir,
      ...HOME_DENIED.map((r) => `/home/op/${r}`),
      '/srv/samsara/data/signoff',
    ])
  })

  it('never places a denied path under an allowed root, nor an allowed root under a denied path', () => {
    const p = policyFor({ ...input, fixturePath: '/srv/cache/fixtures/t1', readOnly: ['/srv/runs/r1/view'] })
    const allowed = [...p.readOnly, ...p.readWrite]
    for (const d of p.denied) {
      for (const a of allowed) {
        expect(isUnder(d, a), `${d} under ${a}`).toBe(false)
        expect(isUnder(a, d), `${a} under ${d}`).toBe(false)
      }
    }
    expect(p.readOnly).toContain('/srv/cache/fixtures/t1')
    expect(p.readOnly).toContain('/srv/runs/r1/view')
  })

  it('refuses a fixture entry inside the pack fixtures/, a home passed as a runtime root, and a workdir inside the pack data', () => {
    expect(() => policyFor({ ...input, fixturePath: `${PACK}/fixtures/python/t1` })).toThrow(SandboxError)
    expect(() => policyFor({ ...input, fixturePath: `${PACK}/fixtures/python/t1` })).toThrow(/inside denied path/)
    expect(() => policyFor({ ...input, runtimeDirs: ['/home/op'] })).toThrow(/reachable through the grant on \/home\/op/)
    expect(() => policyFor({ ...input, workdir: `${PACK}/data/w` })).toThrow(SandboxError)
    expect(() => policyFor({ ...input, systemRoots: ['/'] })).toThrow(/reachable through the grant on \//)
  })

  it('requires absolute paths, normalizes and dedupes', () => {
    expect(() => policyFor({ ...input, workdir: 'relative/dir' })).toThrow(/workdir must be absolute/)
    expect(() => policyFor({ ...input, runtimeDirs: ['venv'] })).toThrow(/runtimeDirs\[\] must be absolute/)
    const p = policyFor({ ...input, runtimeDirs: [`${PACK}/runtime/py/`, `${PACK}/runtime/../runtime/py`] })
    expect(p.readOnly.filter((r) => r === `${PACK}/runtime/py`)).toHaveLength(1)
  })

  it('is pure: the same input yields an equal policy and touches no state', () => {
    expect(policyFor(input)).toEqual(policyFor(input))
  })
})

describe('assertPolicy', () => {
  it('accepts a disjoint policy and rejects overlap in either direction', () => {
    const ok: SandboxPolicy = { readOnly: ['/usr'], readWrite: ['/w'], denied: ['/secret'] }
    expect(() => assertPolicy(ok)).not.toThrow()
    expect(() => assertPolicy({ ...ok, denied: ['/w/.task/token.json'] })).toThrow(/reachable/)
    expect(() => assertPolicy({ ...ok, denied: ['/'] })).toThrow(/inside denied path/)
  })
})

describe('apply', () => {
  it('is a no-op on macOS and reports mode none', () => {
    const mac = host({ platform: 'darwin', enforcement: 'unusable', launcher: '' })
    const s = spec()
    expect(sandboxModeOf(mac)).toBe('none')
    expect(apply(s, policyFor(input), mac)).toBe(s)
    expect(apply(s, undefined, mac)).toBe(s)
  })

  it('is a no-op on a Linux host whose launcher probes unusable', () => {
    const s = spec()
    const h = host({ enforcement: 'unusable' })
    expect(sandboxModeOf(h)).toBe('none')
    expect(apply(s, policyFor(input), h)).toBe(s)
  })

  it('wraps argv with the launcher grants on Linux, leaving cwd/env/stdio/grace untouched', () => {
    const s = spec()
    const p = policyFor({ ...input, runtimeDirs: [`${PACK}/runtime/py`] })
    const h = host({ exists: (path) => !['/lib32', '/opt', '/lib64'].includes(path) })
    expect(sandboxModeOf(h)).toBe('landlock')
    const out = apply(s, p, h)
    expect(out).not.toBe(s)
    expect(out.argv[0]).toBe('/opt/landlock-run')
    const sep = out.argv.indexOf('--')
    expect(out.argv.slice(sep + 1)).toEqual(s.argv)
    const grants = out.argv.slice(1, sep)
    const ro: string[] = []
    const rw: string[] = []
    for (let i = 0; i < grants.length; i += 2) {
      expect(['--ro', '--rw']).toContain(grants[i])
      ;(grants[i] === '--ro' ? ro : rw).push(grants[i + 1]!)
    }
    expect(ro).toEqual(['/usr', '/lib', '/bin', '/sbin', '/etc', '/proc', '/dev', `${PACK}/skill`, `${PACK}/loader`, `${PACK}/runtime/py`])
    expect(rw).toEqual([WORK, '/dev/null'])
    for (const d of p.denied) expect(grants).not.toContain(d)
    expect(out.cwd).toBe(s.cwd)
    expect(out.env).toEqual(s.env)
    expect(out.stdio).toEqual(s.stdio)
    expect(out.graceMs).toBe(s.graceMs)
    expect(sandboxModeOf(host({ enforcement: 'partial' }))).toBe('landlock')
  })

  it('fails closed: an enforcing host without a policy, or whose workdir is missing, throws', () => {
    expect(() => apply(spec(), undefined, host())).toThrow(/no sandbox policy/)
    expect(() => apply(spec(), policyFor(input), host({ exists: (p) => p !== WORK }))).toThrow(/does not exist/)
    const broken: SandboxPolicy = { readOnly: ['/'], readWrite: [WORK], denied: [`${PACK}/tasks`] }
    expect(() => apply(spec(), broken, host())).toThrow(SandboxError)
  })
})
