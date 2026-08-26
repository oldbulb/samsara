import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scrubbedParentEnv, type SubprocessSpawnSpec } from '@oldbulb/samsara-kernel'
import type { SandboxHost } from '@oldbulb/samsara-sandbox'
import { LocalEnvironmentProvider, LocalEnvironment, environmentSha, type EnvironmentSpec } from '../src/index.ts'
import { realSpawn } from './fixtures/real-spawn.ts'

/** The subprocess seam's contract: the spec's env is merged onto the scrubbed parent env, an undefined value removes the entry. */
function mergeSpawn(spec: SubprocessSpawnSpec) {
  return realSpawn({ ...spec, env: { ...scrubbedParentEnv(), ...spec.env } })
}

/** A host that cannot enforce, so the spawn spec is not wrapped whatever the runner's platform. */
const unconfined: SandboxHost = { platform: 'darwin', enforcement: 'unusable', launcher: '', exists: existsSync }

const roots: string[] = []
function tempRoot(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'samsara-env-local-')))
  roots.push(dir)
  return dir
}
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }) })

function spec(over: Partial<EnvironmentSpec> = {}): EnvironmentSpec {
  return { attemptId: 'att-1', resources: { timeoutS: 60 }, network: 'none', env: {}, mounts: [], ...over }
}

function provider(baseDir: string, graceMs = 200): LocalEnvironmentProvider {
  return new LocalEnvironmentProvider({ spawn: realSpawn, baseDir, graceMs, host: unconfined })
}

describe('LocalEnvironmentProvider', () => {
  it('opens a directory under baseDir named by the attempt and removes it on dispose; the id is open once per provider', async () => {
    const root = tempRoot()
    const p = provider(root)
    const env = await p.open(spec())
    expect(env.provider).toBe('local')
    expect(env.id).toBe('att-1')
    expect(env.workdir).toBe(join(root, 'att-1'))
    expect(existsSync(env.workdir)).toBe(true)
    await expect(p.open(spec())).rejects.toThrow(/already open/)
    await env.dispose()
    expect(existsSync(env.workdir)).toBe(false)
    await expect(env.exec(['true'], { timeoutMs: 1000 })).rejects.toThrow(/disposed/)
    // disposed: the same provider opens the id again
    await (await p.open(spec())).dispose()
  })

  it('a stale directory (a host killed before dispose) is replaced on open, so a resume reusing the id goes through', async () => {
    const root = tempRoot()
    const killed = await provider(root).open(spec())
    writeFileSync(join(killed.workdir, 'left-behind'), 'x')
    // a new host process: a new provider, the same id
    const env = await provider(root).open(spec())
    expect(env.workdir).toBe(join(root, 'att-1'))
    expect(existsSync(join(env.workdir, 'left-behind'))).toBe(false)
    await env.dispose()
  })

  it('uses spec.workdir when given, which is the caller\'s and outlives dispose; ignores an image (noted, not in the facts); refuses a path-shaped attemptId', async () => {
    const root = tempRoot()
    const env = await provider(root).open(spec({ workdir: join(root, 'given') }))
    expect(env.workdir).toBe(join(root, 'given'))
    writeFileSync(join(env.workdir, 'edited'), 'by the agent')
    await env.dispose()
    // the directory and what ran in it stay (the runner's attempt dir: resume and post-mortem read it); the id is released
    expect(readFileSync(join(root, 'given', 'edited'), 'utf8')).toBe('by the agent')
    await expect(env.exec(['true'], { timeoutMs: 1000 })).rejects.toThrow(/disposed/)
    await (await provider(root).open(spec({ workdir: join(root, 'given') }))).dispose()
    const imaged = (await provider(root).open(spec({ image: { ref: 'x' } }))) as LocalEnvironment
    expect(imaged.notes).toContain('image x is not used locally; ran on this host')
    expect(imaged.facts().image).toBeUndefined()
    await imaged.dispose()
    await expect(provider(root).open(spec({ attemptId: 'a/b' }))).rejects.toThrow(/single path segment/)
  })

  it('exec: stdin reaches the child, stdout/stderr and the exit code come back, cwd is the workdir', async () => {
    const root = tempRoot()
    const env = await provider(root).open(spec())
    const r = await env.exec(['sh', '-c', 'cat; pwd; echo err >&2; exit 3'], { stdin: 'hello\n', timeoutMs: 5000 })
    expect(r.code).toBe(3)
    expect(r.signal).toBeUndefined()
    expect(r.stdout).toBe(`hello\n${env.workdir}\n`)
    expect(r.stderr).toBe('err\n')
    mkdirSync(join(env.workdir, 'sub'))
    const inSub = await env.exec(['pwd'], { cwd: 'sub', timeoutMs: 5000 })
    expect(inSub.stdout.trim()).toBe(join(env.workdir, 'sub'))
    await env.dispose()
  })

  it('exec: the timeout kills the child and reports the signal with a null code', async () => {
    const root = tempRoot()
    const env = await provider(root).open(spec())
    const t0 = Date.now()
    const r = await env.exec(['sleep', '30'], { timeoutMs: 200 })
    expect(Date.now() - t0).toBeLessThan(10_000)
    expect(r.code).toBeNull()
    expect(['SIGTERM', 'SIGKILL']).toContain(r.signal)
    await env.dispose()
  })

  it('exec: an abort signal ends the child', async () => {
    const root = tempRoot()
    const env = await provider(root).open(spec())
    const ac = new AbortController()
    const pending = env.exec(['sleep', '30'], { timeoutMs: 30_000, signal: ac.signal })
    setTimeout(() => ac.abort(), 50)
    const r = await pending
    expect(r.code).toBeNull()
    expect(r.signal).toBeDefined()
    await env.dispose()
  })

  it('env allowlist (E5): the child sees the spec env, the call env and HOME/TMPDIR in the workdir, never the host env', async () => {
    const root = tempRoot()
    process.env['SAMSARA_TEST_LEAK'] = 'leaked'
    try {
      const env = await provider(root).open(spec({ env: { FROM_SPEC: 'a', OVERRIDDEN: 'spec' } }))
      const r = await env.exec(['sh', '-c', 'echo "$FROM_SPEC|$OVERRIDDEN|$FROM_CALL|$SAMSARA_TEST_LEAK|$HOME|$TMPDIR"'], { env: { FROM_CALL: 'c', OVERRIDDEN: 'call' }, timeoutMs: 5000 })
      expect(r.stdout.trim()).toBe(`a|call|c||${env.workdir}|${env.workdir}`)
      const names = await env.exec(['sh', '-c', 'env | cut -d= -f1 | sort'], { timeoutMs: 5000 })
      const allowed = new Set(['PATH', 'LANG', 'LC_ALL', 'HOME', 'TMPDIR', 'FROM_SPEC', 'OVERRIDDEN', 'PWD', 'SHLVL', '_', 'OLDPWD'])
      for (const n of names.stdout.trim().split('\n')) expect(allowed.has(n), `unexpected variable ${n}`).toBe(true)
      await env.dispose()
    } finally {
      delete process.env['SAMSARA_TEST_LEAK']
    }
  })

  it('env allowlist (E5) holds through a spawn with the seam\'s merge semantics: every other ambient name is tombstoned out', async () => {
    const root = tempRoot()
    process.env['SAMSARA_TEST_LEAK'] = 'leaked'
    try {
      expect(scrubbedParentEnv()['SAMSARA_TEST_LEAK']).toBe('leaked')
      const env = await new LocalEnvironmentProvider({ spawn: mergeSpawn, baseDir: root, graceMs: 200, host: unconfined }).open(spec({ env: { FROM_SPEC: 'a' } }))
      const r = await env.exec(['sh', '-c', 'echo "$FROM_SPEC|$SAMSARA_TEST_LEAK|$HOME"'], { timeoutMs: 5000 })
      expect(r.stdout.trim()).toBe(`a||${env.workdir}`)
      const names = await env.exec(['sh', '-c', 'env | cut -d= -f1 | sort'], { timeoutMs: 5000 })
      const allowed = new Set(['PATH', 'LANG', 'LC_ALL', 'HOME', 'TMPDIR', 'FROM_SPEC', 'PWD', 'SHLVL', '_', 'OLDPWD'])
      for (const n of names.stdout.trim().split('\n')) expect(allowed.has(n), `unexpected variable ${n}`).toBe(true)
      await env.dispose()
    } finally {
      delete process.env['SAMSARA_TEST_LEAK']
    }
  })

  it('put/get copy files and directories relative to the workdir', async () => {
    const root = tempRoot()
    const env = await provider(root).open(spec())
    const src = join(root, 'src')
    mkdirSync(join(src, 'd'), { recursive: true })
    writeFileSync(join(src, 'd', 'f.txt'), 'content')
    await env.put(src, 'in/tree')
    expect(readFileSync(join(env.workdir, 'in', 'tree', 'd', 'f.txt'), 'utf8')).toBe('content')
    await env.put(join(src, 'd', 'f.txt'), 'one.txt')
    await env.exec(['sh', '-c', 'echo made > out.txt'], { timeoutMs: 5000 })
    await env.get('out.txt', join(root, 'back', 'out.txt'))
    expect(readFileSync(join(root, 'back', 'out.txt'), 'utf8')).toBe('made\n')
    await env.get('in', join(root, 'back', 'in'))
    expect(readFileSync(join(root, 'back', 'in', 'tree', 'd', 'f.txt'), 'utf8')).toBe('content')
    await env.dispose()
  })

  it('mounts: read-only is a symlink (recorded), writable is a copy so writes never reach the source', async () => {
    const root = tempRoot()
    const ro = join(root, 'ro')
    const rw = join(root, 'rw')
    mkdirSync(ro)
    mkdirSync(rw)
    writeFileSync(join(ro, 'a'), 'ro')
    writeFileSync(join(rw, 'b'), 'rw')
    const env = (await provider(root).open(spec({ mounts: [{ from: ro, to: 'mnt/ro', readOnly: true }, { from: rw, to: 'mnt/rw', readOnly: false }] }))) as LocalEnvironment
    expect(lstatSync(join(env.workdir, 'mnt', 'ro')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(env.workdir, 'mnt', 'ro'))).toBe(ro)
    expect(lstatSync(join(env.workdir, 'mnt', 'rw')).isDirectory()).toBe(true)
    await env.exec(['sh', '-c', 'echo changed > mnt/rw/b'], { timeoutMs: 5000 })
    expect(readFileSync(join(rw, 'b'), 'utf8')).toBe('rw')
    expect(env.notes.some((n) => n.startsWith('mount mnt/ro: read-only by sandbox policy only'))).toBe(true)
    await env.dispose()
    expect(readFileSync(join(ro, 'a'), 'utf8')).toBe('ro')
  })

  it('mounts: a read-only source at its own path (the pack dir) is left as it is and reachable from that cwd', async () => {
    const root = tempRoot()
    const own = join(root, 'own')
    mkdirSync(own)
    writeFileSync(join(own, 'a'), 'own')
    const env = (await provider(root).open(spec({ mounts: [{ from: own, to: own, readOnly: true }] }))) as LocalEnvironment
    expect(lstatSync(own).isSymbolicLink()).toBe(false)
    expect(env.notes).toContain(`mount ${own}: read-only by sandbox policy only (its own path on this host)`)
    const r = await env.exec(['sh', '-c', 'cat ./a'], { cwd: own, timeoutMs: 5000 })
    expect(r).toEqual({ code: 0, stdout: 'own', stderr: '' })
    await env.dispose()
    expect(readFileSync(join(own, 'a'), 'utf8')).toBe('own')
  })

  it('dispose kills a sleeping child before removing the directory', async () => {
    const root = tempRoot()
    const env = await provider(root).open(spec())
    const pending = env.exec(['sleep', '30'], { timeoutMs: 30_000 })
    await new Promise((r) => setTimeout(r, 50))
    const t0 = Date.now()
    await env.dispose()
    const r = await pending
    expect(Date.now() - t0).toBeLessThan(10_000)
    expect(r.code).toBeNull()
    expect(r.signal).toBeDefined()
    expect(existsSync(env.workdir)).toBe(false)
  })

  it('facts: provider local, no image, the network that actually ran (public) and notes for what was asked', async () => {
    const root = tempRoot()
    const env = (await provider(root).open(spec({ resources: { cpus: 2, timeoutS: 30 }, network: 'none' }))) as LocalEnvironment
    const facts = env.facts()
    expect(facts).toEqual({ provider: 'local', version: env.facts().version, resources: { cpus: 2, timeoutS: 30 }, network: 'public' })
    expect(facts.image).toBeUndefined()
    expect(env.notes).toContain('network none is not enforced locally; ran with public')
    expect(env.notes).toContain('cpus/memoryMb are not enforced locally')
    expect(environmentSha(facts)).toBe(environmentSha({ ...facts, provider: 'other', version: 'x' }))
    await env.dispose()
  })

  it('wraps the spawn with the sandbox policy on a host that enforces: system roots and read-only mount sources read-only, the workdir writable', async () => {
    const root = tempRoot()
    const ro = join(root, 'ro')
    mkdirSync(ro)
    const specs: Parameters<typeof realSpawn>[0][] = []
    const spawn = (s: Parameters<typeof realSpawn>[0]) => { specs.push(s); return realSpawn({ ...s, argv: s.argv.slice(s.argv.indexOf('--') + 1) }) }
    const host: SandboxHost = { platform: 'linux', enforcement: 'full', launcher: '/launcher', exists: (p) => p === root || p.startsWith(root + '/') || p === '/dev/null' || p === '/usr' }
    const env = await new LocalEnvironmentProvider({ spawn, baseDir: root, host }).open(spec({ mounts: [{ from: ro, to: 'ro', readOnly: true }] }))
    await env.exec(['true'], { timeoutMs: 5000 })
    const argv = specs[0]!.argv
    expect(argv[0]).toBe('/launcher')
    expect(argv).toContain('--')
    const grants = argv.slice(1, argv.indexOf('--')).join(' ')
    expect(grants).toContain('/usr')
    expect(grants).toContain(ro)
    expect(grants).toContain(env.workdir)
    expect(argv.slice(argv.indexOf('--') + 1)).toEqual(['true'])
    await env.dispose()
  })
})
