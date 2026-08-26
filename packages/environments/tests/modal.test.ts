import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@oldbulb/samsara-kernel'
import { createParams, MODAL_SDK_VERSION, pinnedDigest, sandboxLifetimeMs, sdkTimeoutMs, type ModalClientLike, type ModalExecParams, type ModalFileInfo, type ModalImage, type ModalProcess, type ModalSandbox, type ModalSandboxCreateParams, type ModalSecret } from '../src/modal.ts'
import { createClient, createProvider } from '../src/plugin-modal.ts'
import { MODAL_SKIP_REASON, modalOptedIn } from './fixtures/modal-opt-in.ts'
import { Environments, ModalEnvironmentProvider, ModalEnvironment, environmentSha, type EnvironmentSpec } from '../src/index.ts'

const roots: string[] = []
function tempRoot(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'samsara-env-modal-')))
  roots.push(dir)
  return dir
}
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }) })

function spec(over: Partial<EnvironmentSpec> = {}): EnvironmentSpec {
  return { attemptId: 'att-1', image: { ref: 'example/image:1' }, resources: { cpus: 2, memoryMb: 512, timeoutS: 600 }, network: 'none', env: { A: '1', TOKEN_VALUE: 'secret-value' }, mounts: [], ...over }
}
/** The note every environment of `spec()` carries: twice its timeoutS plus the headroom. */
const LIFETIME_NOTE = 'sandbox lifetime 1800s: a backstop past timeoutS 600, which the callers\' deadlines enforce'

// ---------------------------------------------------------------- a fake client

type Call = [method: string, ...args: unknown[]]

interface FakeSecret extends ModalSecret { entries: Record<string, string> }

function stream(text: Promise<string>): ReadableStream<string> {
  return new ReadableStream<string>({
    async start(controller) {
      try {
        const t = await text
        if (t !== '') controller.enqueue(t)
        controller.close()
      } catch (e) {
        controller.error(e)
      }
    },
  })
}

/**
 * A fake `ContainerProcess`: echoes its stdin to stdout once stdin is closed
 * (like `cat`) and the workdir to stderr; `--fail` exits 7, `--hang` runs
 * until the worker's deadline (`params.timeoutMs`: exit 137, the streams end
 * with the SDK's deadline error, as the worker does) or the sandbox is
 * terminated — its stdout has one chunk, early, or late (`--late`: after
 * `LATE_MS`, still before the deadline); `--deadline` fails `wait` with the
 * SDK's deadline error, `--stdin-error` refuses stdin.
 */
const LATE_MS = 400
function fakeProcess(argv: string[], params: ModalExecParams | undefined, terminated: Promise<void>): ModalProcess {
  let closeStdin: () => void = () => {}
  const stdinClosed = new Promise<void>((r) => { closeStdin = r })
  const input: string[] = []
  const hang = argv.includes('--hang')
  const deadline = new Promise<never>((_, reject) => {
    if (params?.timeoutMs !== undefined) setTimeout(() => reject(new Error('Deadline exceeded while streaming stdio for exec e-1')), params.timeoutMs).unref()
  })
  deadline.catch(() => undefined)
  const exit: Promise<number> = argv.includes('--fail')
    ? Promise.resolve(7)
    : argv.includes('--deadline')
      ? Promise.reject(new Error('Deadline exceeded while waiting for exec e-1'))
      : hang
        ? Promise.race([terminated.then(() => 137), deadline.catch(() => 137)])
        : stdinClosed.then(() => 0)
  exit.catch(() => undefined)
  const chunk = argv.includes('--late') ? new Promise<string>((r) => setTimeout(() => r('partial'), LATE_MS)) : Promise.resolve('partial')
  const out = hang ? chunk : exit.then((code) => (code === 7 ? '' : input.join('')), () => '')
  const err = hang ? Promise.race([terminated.then(() => ''), deadline]) : exit.then((code) => (code === 7 ? 'failed\n' : (params?.workdir ?? '')), () => '')
  return {
    stdin: {
      async writeText(text) {
        if (argv.includes('--stdin-error')) throw new Error('stdin refused')
        input.push(text)
      },
      async close() { closeStdin() },
    },
    stdout: stream(out),
    stderr: stream(err),
    wait: () => exit,
  }
}

/** `dead`: the sandbox has exited (poll gives 137) and every control call fails as the SDK reports it; a path with `unreachable` fails that way once. */
function fakeSandbox(id: string, calls: Call[], dead = false): ModalSandbox {
  let terminate: () => void = () => {}
  const terminated = new Promise<void>((r) => { terminate = r })
  const rec = (method: string, ...args: unknown[]): void => { calls.push([method, ...args]) }
  let unreachable = 1
  return {
    sandboxId: id,
    async exec(command, params) {
      rec('exec', command, params)
      return fakeProcess(command, params, terminated)
    },
    filesystem: {
      async copyFromLocal(localPath, remotePath) {
        rec('copyFromLocal', localPath, remotePath)
        if (localPath.includes('copyfail')) throw new Error('write refused')
      },
      async copyToLocal(remotePath, localPath) {
        rec('copyToLocal', remotePath, localPath)
        mkdirSync(join(localPath, '..'), { recursive: true })
        writeFileSync(localPath, `remote:${remotePath}`)
      },
      async listFiles(remotePath): Promise<ModalFileInfo[]> {
        rec('listFiles', remotePath)
        const entry = (name: string, type: ModalFileInfo['type'], symlinkTarget: string | null = null): ModalFileInfo => ({ name, path: `${remotePath}/${name}`, type, symlinkTarget })
        return remotePath.endsWith('-dir') ? [entry('a.txt', 'file'), entry('link', 'symlink', 'a.txt'), entry('sub', 'directory')] : [entry('b.txt', 'file'), entry('up', 'symlink', '../a.txt')]
      },
      async makeDirectory(remotePath, options) {
        rec('makeDirectory', remotePath, options)
        if (dead || (remotePath.includes('unreachable') && unreachable-- > 0)) throw new Error('The Sandbox is unavailable. This Sandbox may have already shut down.')
      },
      async stat(remotePath): Promise<ModalFileInfo> {
        rec('stat', remotePath)
        return { name: remotePath.split('/').at(-1)!, path: remotePath, type: remotePath.endsWith('-dir') ? 'directory' : 'file', symlinkTarget: null }
      },
    },
    async snapshotFilesystem() {
      rec('snapshotFilesystem')
      return { imageId: `im-snap-${id}` }
    },
    async poll() {
      rec('poll')
      return dead ? 137 : null
    },
    async terminate(params) {
      rec('terminate', params)
      terminate()
      return 0
    },
  }
}

/** Records every call in order; images get an id on the first `create` (the SDK builds lazily); `runfail` in the workdir makes `create` fail. */
function fakeClient(): { client: ModalClientLike; calls: Call[] } {
  const calls: Call[] = []
  let sandboxes = 0
  let images = 0
  const client: ModalClientLike = {
    apps: { async fromName(name, params) { calls.push(['apps.fromName', name, params]); return { appId: `ap-${name}` } } },
    images: {
      fromRegistry(tag) {
        calls.push(['images.fromRegistry', tag])
        const image = { imageId: '' } as { imageId: string }
        return image as ModalImage
      },
    },
    secrets: { async fromObject(entries) { calls.push(['secrets.fromObject', entries]); const s: FakeSecret = { secretId: 'st-0000', entries }; return s } },
    sandboxes: {
      async create(app, image, params) {
        if (image.imageId === '') (image as { imageId: string }).imageId = `im-${String(images++).padStart(4, '0')}`
        calls.push(['sandboxes.create', app, image.imageId, params])
        if (params?.workdir?.includes('runfail')) throw new Error('sandbox create refused')
        return fakeSandbox(`sb-${String(sandboxes++).padStart(4, '0')}`, calls, params?.workdir?.includes('dead') ?? false)
      },
    },
  }
  return { client, calls }
}

function provider(app?: string): { p: ModalEnvironmentProvider; calls: Call[] } {
  const { client, calls } = fakeClient()
  return { p: new ModalEnvironmentProvider(app === undefined ? { client } : { client, app }), calls }
}

function methods(calls: Call[]): string[] {
  return calls.map((c) => c[0])
}

// ---------------------------------------------------------------- unit

describe('createParams / sdkTimeoutMs / pinnedDigest / version', () => {
  it('builds the create params: lifetime in ms, workdir, resources as reservation and hard limit both, the secret, the network policy', () => {
    const secret: ModalSecret = { secretId: 'st-1' }
    expect(createParams(spec(), '/workspace/att-1', secret)).toEqual({ timeoutMs: 1_800_000, workdir: '/workspace/att-1', cpu: 2, cpuLimit: 2, memoryMiB: 512, memoryLimitMiB: 512, secrets: [secret], blockNetwork: true })
    expect(createParams(spec({ resources: { timeoutS: 1 }, network: 'public' }), '/w', undefined)).toEqual({ timeoutMs: 602_000, workdir: '/w' })
    expect(createParams(spec({ network: 'allowlist', allowedHosts: ['example.org', '*.example.net'] }), '/w', undefined)).toEqual({ timeoutMs: 1_800_000, workdir: '/w', cpu: 2, cpuLimit: 2, memoryMiB: 512, memoryLimitMiB: 512, outboundDomainAllowlist: ['example.org', '*.example.net'] })
    expect(createParams(spec({ network: 'allowlist' }), '/w', undefined).outboundDomainAllowlist).toEqual([])
  })

  it('the sandbox lifetime is a backstop past timeoutS: twice it (the loop and a command inside can each run to it) plus a fixed headroom, never timeoutS itself', () => {
    expect(sandboxLifetimeMs(600)).toBe(1_800_000)
    expect(sandboxLifetimeMs(1200)).toBe(3_000_000)
    // the runner's default attempt limit: a loop at its limit, then truth at its own, still ends before the sandbox
    expect(sandboxLifetimeMs(1200)).toBeGreaterThan(2 * 1200 * 1000 + 60_000)
    expect(createParams(spec({ resources: { timeoutS: 1200 } }), '/w', undefined).timeoutMs).toBe(sandboxLifetimeMs(1200))
  })

  it('rounds a deadline up to the whole seconds the SDK takes, never to zero', () => {
    expect(sdkTimeoutMs(200)).toBe(1000)
    expect(sdkTimeoutMs(1000)).toBe(1000)
    expect(sdkTimeoutMs(1001)).toBe(2000)
    expect(sdkTimeoutMs(0)).toBe(1000)
  })

  it('reads the digest a ref pins', () => {
    expect(pinnedDigest('alpine:3.20')).toBeUndefined()
    expect(pinnedDigest('alpine@sha256:aa')).toBe('sha256:aa')
    expect(pinnedDigest('localhost:5000/team/img@sha256:bb')).toBe('sha256:bb')
  })

  it('the provider version is the installed SDK version', () => {
    const pkg = JSON.parse(readFileSync(join(fileURLToPath(import.meta.resolve('modal')), '..', '..', 'package.json'), 'utf8')) as { name: string; version: string }
    expect(pkg.name).toBe('modal')
    expect(MODAL_SDK_VERSION).toBe(pkg.version)
  })
})

// ---------------------------------------------------------------- against the fake

describe('ModalEnvironmentProvider against a fake client', () => {
  it('open: resolves the app once, the image from the registry, the env as a secret (values never in the create params), creates the sandbox with resources/network/workdir, exposes facts; dispose terminates and waits', async () => {
    const { p, calls } = provider()
    const env = (await p.open(spec())) as ModalEnvironment
    expect(env.provider).toBe('modal')
    expect(env.id).toBe('sb-0000')
    // the pack contract names the workdir after the attempt
    expect(env.workdir).toBe('/workspace/att-1')
    expect(methods(calls)).toEqual(['apps.fromName', 'images.fromRegistry', 'secrets.fromObject', 'sandboxes.create', 'makeDirectory'])
    expect(calls[0]).toEqual(['apps.fromName', 'samsara', { createIfMissing: true }])
    expect(calls[1]).toEqual(['images.fromRegistry', 'example/image:1'])
    expect(calls[2]).toEqual(['secrets.fromObject', { A: '1', TOKEN_VALUE: 'secret-value' }])
    const [, app, imageId, params] = calls[3] as [string, { appId: string }, string, ModalSandboxCreateParams]
    expect(app).toEqual({ appId: 'ap-samsara' })
    expect(imageId).toBe('im-0000')
    expect(params.secrets).toHaveLength(1)
    expect(params.secrets![0]!.secretId).toBe('st-0000')
    expect(JSON.stringify({ ...params, secrets: params.secrets!.map((s) => s.secretId) })).not.toContain('secret-value')
    expect({ ...params, secrets: undefined }).toEqual({ timeoutMs: 1_800_000, workdir: '/workspace/att-1', cpu: 2, cpuLimit: 2, memoryMiB: 512, memoryLimitMiB: 512, blockNetwork: true, secrets: undefined })
    expect(calls[4]).toEqual(['makeDirectory', '/workspace/att-1', undefined])
    // facts carry the spec's resources (rule 0), not the sandbox's lifetime — that is a note
    expect(env.facts()).toEqual({ provider: 'modal', version: MODAL_SDK_VERSION, image: { ref: 'example/image:1', digest: 'im-0000' }, resources: { cpus: 2, memoryMb: 512, timeoutS: 600 }, network: 'none' })
    expect(env.notes).toEqual([LIFETIME_NOTE])
    expect(env.usage().wall_s).toBeGreaterThanOrEqual(0)
    await env.dispose()
    await env.dispose()
    expect(calls.at(-1)).toEqual(['terminate', { wait: true }])
    expect(calls.filter((c) => c[0] === 'terminate')).toHaveLength(1)
    await expect(env.exec(['true'], { timeoutMs: 100 })).rejects.toThrow(/disposed/)
  })

  it('rule 0: the coordinate of a modal environment equals the docker one for the same image digest, resources and network', async () => {
    const { p } = provider()
    const env = await p.open(spec({ image: { ref: 'example/image@sha256:aa' } }))
    const facts = env.facts()
    expect(facts.image).toEqual({ ref: 'example/image@sha256:aa', digest: 'sha256:aa' })
    const docker = { provider: 'docker', version: '0.1.0', image: { ref: 'example/image:1', digest: 'sha256:aa' }, resources: { cpus: 2, memoryMb: 512, timeoutS: 600 }, network: 'none' as const }
    expect(environmentSha(facts)).toBe(environmentSha(docker))
    expect(environmentSha(facts)).not.toBe(environmentSha({ ...docker, image: { digest: 'sha256:bb' } }))
    expect((env as ModalEnvironment).notes).toEqual([LIFETIME_NOTE, 'image example/image@sha256:aa is Modal image im-0000'])
    await env.dispose()
  })

  it('open: a second environment reuses the app and the image (no registry call), the app name is configurable, an empty env makes no secret', async () => {
    const { p, calls } = provider('my-app')
    const first = await p.open(spec({ env: {} }))
    const second = await p.open(spec({ attemptId: 'att-2', env: {} }))
    expect(methods(calls)).toEqual(['apps.fromName', 'images.fromRegistry', 'sandboxes.create', 'makeDirectory', 'sandboxes.create', 'makeDirectory'])
    expect(calls[0]![1]).toBe('my-app')
    expect((calls[2] as [string, unknown, string, ModalSandboxCreateParams])[3].secrets).toBeUndefined()
    expect((calls[4] as [string, unknown, string])[2]).toBe('im-0000')
    expect(second.facts().image).toEqual(first.facts().image)
    expect(second.workdir).toBe('/workspace/att-2')
    await first.dispose()
    await second.dispose()
  })

  it('open: network public opens the sandbox, allowlist maps to the domain allowlist and shows in facts; spec.workdir is honoured', async () => {
    const { p, calls } = provider()
    const open = await p.open(spec({ network: 'public', workdir: '/srv/w' }))
    let params = (calls.at(-2) as [string, unknown, string, ModalSandboxCreateParams])[3]
    expect(params.blockNetwork).toBeUndefined()
    expect(params.outboundDomainAllowlist).toBeUndefined()
    expect(params.workdir).toBe('/srv/w')
    expect(open.workdir).toBe('/srv/w')
    expect(open.facts().network).toBe('public')
    const allow = await p.open(spec({ attemptId: 'att-2', network: 'allowlist', allowedHosts: ['example.org'] }))
    params = (calls.at(-2) as [string, unknown, string, ModalSandboxCreateParams])[3]
    expect(params.outboundDomainAllowlist).toEqual(['example.org'])
    expect(allow.facts()).toMatchObject({ network: 'allowlist', allowedHosts: ['example.org'] })
    await open.dispose()
    await allow.dispose()
  })

  it('open: a dockerfileDir, a missing image and a bad attemptId are refused before any call; a failed create surfaces', async () => {
    const root = tempRoot()
    const { p, calls } = provider()
    const ctxDir = join(root, 'ctx')
    mkdirSync(ctxDir)
    await expect(p.open(spec({ image: { dockerfileDir: ctxDir } }))).rejects.toThrow(/dockerfileDir is not supported.*image\.ref/)
    await expect(p.open(spec({ image: undefined }))).rejects.toThrow(/names no image/)
    await expect(p.open(spec({ attemptId: 'a/b' }))).rejects.toThrow(/single path segment/)
    expect(calls).toEqual([])
    await expect(p.open(spec({ workdir: '/runfail' }))).rejects.toThrow(/sandbox create refused/)
    expect(methods(calls)).not.toContain('terminate')
  })

  it('open: the first call into a fresh sandbox is retried while the sandbox runs (its router is not reachable yet), and fails at once when it has exited', async () => {
    const { p, calls } = provider()
    const env = (await p.open(spec({ workdir: '/unreachable' }))) as ModalEnvironment
    expect(methods(calls).slice(methods(calls).indexOf('sandboxes.create') + 1)).toEqual(['makeDirectory', 'poll', 'makeDirectory'])
    expect(env.notes).toContain('first contact took 2 tries')
    await env.dispose()
    await expect(p.open(spec({ attemptId: 'att-2', workdir: '/dead' }))).rejects.toThrow(/Sandbox is unavailable/)
    expect(methods(calls).slice(-3)).toEqual(['makeDirectory', 'poll', 'terminate'])
  })

  it('open: mounts are copied in before it returns (directories made, files copied, the executable bit restored), read-only is noted; a failed copy terminates the sandbox', async () => {
    const root = tempRoot()
    const { p, calls } = provider()
    const mount = join(root, 'skill')
    mkdirSync(join(mount, 'bin'), { recursive: true })
    writeFileSync(join(mount, 'SKILL.md'), 'x')
    writeFileSync(join(mount, 'bin', 'tool'), '#!/bin/sh\n')
    chmodSync(join(mount, 'bin', 'tool'), 0o755)
    mkdirSync(join(root, 'rw'))
    writeFileSync(join(root, 'rw', 'f'), 'y')
    const env = (await p.open(spec({ mounts: [{ from: mount, to: '/opt/skill', readOnly: true }, { from: join(root, 'rw'), to: 'data', readOnly: false }] }))) as ModalEnvironment
    const after = calls.slice(methods(calls).indexOf('makeDirectory') + 1)
    expect(after.filter((c) => c[0] === 'makeDirectory').map((c) => c[1])).toEqual(['/opt/skill', '/opt/skill/bin', '/workspace/att-1/data'])
    expect(after.filter((c) => c[0] === 'copyFromLocal').map((c) => [c[1], c[2]]).sort()).toEqual([
      [join(mount, 'SKILL.md'), '/opt/skill/SKILL.md'],
      [join(mount, 'bin', 'tool'), '/opt/skill/bin/tool'],
      [join(root, 'rw', 'f'), '/workspace/att-1/data/f'],
    ].sort())
    expect(after.filter((c) => c[0] === 'exec').map((c) => c[1])).toEqual([['chmod', '+x', '/opt/skill/bin/tool']])
    expect(env.notes).toEqual([LIFETIME_NOTE, 'mount /opt/skill: a copy; read-only is not enforced by the modal provider'])
    await env.dispose()

    mkdirSync(join(root, 'copyfail'))
    writeFileSync(join(root, 'copyfail', 'f'), 'z')
    await expect(p.open(spec({ attemptId: 'att-2', mounts: [{ from: join(root, 'copyfail'), to: '/m', readOnly: false }] }))).rejects.toThrow(/write refused/)
    expect(calls.at(-1)).toEqual(['terminate', { wait: true }])
  })

  it('exec: argv, workdir (a relative cwd under the workdir), the timeout in whole seconds, extras in env, stdin delivered and closed, exit code', async () => {
    const { p, calls } = provider()
    const env = await p.open(spec())
    const r = await env.exec(['sh', '-c', 'cat'], { stdin: 'in-data', cwd: 'sub', user: 'nobody', env: { X: 'y' }, timeoutMs: 1500 })
    expect(r).toEqual({ code: 0, stdout: 'in-data', stderr: '/workspace/att-1/sub' })
    expect(calls.at(-1)).toEqual(['exec', ['sh', '-c', 'cat'], { workdir: '/workspace/att-1/sub', timeoutMs: 2000, env: { X: 'y' }, stdout: 'pipe', stderr: 'pipe' }])

    const plain = await env.exec(['true'], { cwd: '/elsewhere', timeoutMs: 5000 })
    expect(plain).toEqual({ code: 0, stdout: '', stderr: '/elsewhere' })
    expect(calls.at(-1)).toEqual(['exec', ['true'], { workdir: '/elsewhere', timeoutMs: 5000, stdout: 'pipe', stderr: 'pipe' }])

    const failed = await env.exec(['--fail'], { timeoutMs: 5000 })
    expect(failed).toEqual({ code: 7, stdout: '', stderr: 'failed\n' })

    // a process gone before stdin is written is not an error
    const early = await env.exec(['--fail', '--stdin-error'], { stdin: 'x', timeoutMs: 5000 })
    expect(early.code).toBe(7)
    await env.dispose()
  })

  it('exec: the deadline ends the call with code null and SIGKILL and what the process wrote before the worker\'s kill (a chunk in flight at the deadline included); the SDK\'s own deadline error is the same; an abort is noted; an aborted signal execs nothing', async () => {
    const { p, calls } = provider()
    const env = (await p.open(spec())) as ModalEnvironment
    let started = Date.now()
    const hung = await env.exec(['--hang'], { timeoutMs: 200 })
    expect(Date.now() - started).toBeLessThan(2000)
    expect(hung).toEqual({ code: null, signal: 'SIGKILL', stdout: 'partial', stderr: '' })
    expect((calls.at(-1) as [string, string[], ModalExecParams])[2].timeoutMs).toBe(1000)
    expect(env.notes).toEqual([LIFETIME_NOTE])

    // the worker kills at the rounded second: a chunk that arrives after the caller's deadline but before the kill is in the result
    started = Date.now()
    const late = await env.exec(['--hang', '--late'], { timeoutMs: 200 })
    expect(Date.now() - started).toBeGreaterThanOrEqual(LATE_MS)
    expect(Date.now() - started).toBeLessThan(2000)
    expect(late).toEqual({ code: null, signal: 'SIGKILL', stdout: 'partial', stderr: '' })

    const deadline = await env.exec(['--deadline'], { timeoutMs: 5000 })
    expect(deadline).toEqual({ code: null, signal: 'SIGKILL', stdout: '', stderr: '' })

    const controller = new AbortController()
    setTimeout(() => controller.abort(), 50)
    const aborted = await env.exec(['--hang'], { timeoutMs: 10_000, signal: controller.signal })
    expect(aborted.code).toBeNull()
    expect(aborted.signal).toBe('SIGKILL')
    expect(env.notes).toEqual([LIFETIME_NOTE, 'exec aborted; the process inside runs until dispose (the SDK has no kill for an exec)'])

    const before = calls.length
    const already = new AbortController()
    already.abort()
    expect(await env.exec(['--hang'], { timeoutMs: 10_000, signal: already.signal })).toEqual({ code: null, signal: 'SIGKILL', stdout: '', stderr: '' })
    expect(calls).toHaveLength(before)

    // dispose ends what hangs: terminate resolves the worker's wait
    const pending = env.exec(['--hang'], { timeoutMs: 10_000 })
    await new Promise((r) => setTimeout(r, 20))
    await env.dispose()
    expect((await pending).code).toBe(137)
  })

  it('put/get: a file copies with parents made by the API, a directory is walked (directories made, files copied, merged into the destination), a relative remote path is under the workdir; get walks a remote directory and makes its symlinks again (over what the path held); snapshot is the filesystem snapshot', async () => {
    const root = tempRoot()
    const { p, calls } = provider()
    const env = await p.open(spec({ workdir: '/workspace' }))
    mkdirSync(join(root, 'local-dir', 'nested'), { recursive: true })
    writeFileSync(join(root, 'local-dir', 'a'), 'a')
    writeFileSync(join(root, 'local-dir', 'nested', 'b'), 'b')
    writeFileSync(join(root, 'local-file'), 'x')
    // what `get` merges into: a file where the remote tree has a link
    mkdirSync(join(root, 'deep', 'local-out'), { recursive: true })
    writeFileSync(join(root, 'deep', 'local-out', 'link'), 'stale')
    const start = calls.length
    await env.put(join(root, 'local-dir'), '/workspace/in')
    await env.put(join(root, 'local-file'), 'sub/.task/f')
    await env.get('/workspace/out-dir', join(root, 'deep', 'local-out'))
    await env.get('sub/out', join(root, 'deeper', 'still', 'local-rel-out'))
    expect(await env.snapshot!()).toEqual({ ref: 'im-snap-sb-0000', digest: 'im-snap-sb-0000' })
    const c = calls.slice(start)
    expect(c[0]).toEqual(['makeDirectory', '/workspace/in', undefined])
    expect(c[1]).toEqual(['makeDirectory', '/workspace/in/nested', undefined])
    expect(c.slice(2, 4).map((x) => [x[1], x[2]]).sort()).toEqual([[join(root, 'local-dir', 'a'), '/workspace/in/a'], [join(root, 'local-dir', 'nested', 'b'), '/workspace/in/nested/b']].sort())
    expect(c[4]).toEqual(['copyFromLocal', join(root, 'local-file'), '/workspace/sub/.task/f'])
    expect(c[5]).toEqual(['stat', '/workspace/out-dir'])
    expect(c[6]).toEqual(['listFiles', '/workspace/out-dir'])
    expect(c[7]).toEqual(['listFiles', '/workspace/out-dir/sub'])
    expect(c.slice(8, 10).map((x) => [x[1], x[2]]).sort()).toEqual([['/workspace/out-dir/a.txt', join(root, 'deep', 'local-out', 'a.txt')], ['/workspace/out-dir/sub/b.txt', join(root, 'deep', 'local-out', 'sub', 'b.txt')]].sort())
    expect(readFileSync(join(root, 'deep', 'local-out', 'sub', 'b.txt'), 'utf8')).toBe('remote:/workspace/out-dir/sub/b.txt')
    // the links are made locally with the target they have inside, no copy call for them
    expect(lstatSync(join(root, 'deep', 'local-out', 'link')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(root, 'deep', 'local-out', 'link'))).toBe('a.txt')
    expect(readFileSync(join(root, 'deep', 'local-out', 'link'), 'utf8')).toBe('remote:/workspace/out-dir/a.txt')
    expect(readlinkSync(join(root, 'deep', 'local-out', 'sub', 'up'))).toBe('../a.txt')
    expect(c[10]).toEqual(['stat', '/workspace/sub/out'])
    expect(c[11]).toEqual(['copyToLocal', '/workspace/sub/out', join(root, 'deeper', 'still', 'local-rel-out')])
    expect(existsSync(join(root, 'deeper', 'still', 'local-rel-out'))).toBe(true)
    expect(c[12]).toEqual(['snapshotFilesystem'])
    expect(c).toHaveLength(13)
    await env.dispose()
  })
})

// ---------------------------------------------------------------- plugin

describe('environments-modal plugin', () => {
  it('registers the provider on ctx.environments with the configured app; the client is injectable', async () => {
    const ctx = new Context()
    await ctx.plugin(Environments)
    const { client } = fakeClient()
    const p = createProvider(ctx, { app: 'my-app' }, client)
    expect(p.name).toBe('modal')
    expect(p.appName).toBe('my-app')
    expect(createProvider(ctx, {}, client).appName).toBe('samsara')
    const dispose = ctx.environments.register(p)
    expect(ctx.environments.get('modal')).toBe(p)
    dispose()
  })

  it('createClient reads credentials from the variables the config names (E5: names in config, values from the environment); a named variable that is unset is an error', () => {
    const saved = { id: process.env['SAMSARA_TEST_MODAL_ID'], secret: process.env['SAMSARA_TEST_MODAL_SECRET'] }
    process.env['SAMSARA_TEST_MODAL_ID'] = 'ak-test-id'
    process.env['SAMSARA_TEST_MODAL_SECRET'] = 'as-test-secret'
    try {
      const client = createClient({ tokenIdEnv: 'SAMSARA_TEST_MODAL_ID', tokenSecretEnv: 'SAMSARA_TEST_MODAL_SECRET' }) as unknown as { profile: { tokenId?: string; tokenSecret?: string } }
      expect(client.profile.tokenId).toBe('ak-test-id')
      expect(client.profile.tokenSecret).toBe('as-test-secret')
      expect(() => createClient({ tokenIdEnv: 'SAMSARA_TEST_MODAL_UNSET' })).toThrow(/SAMSARA_TEST_MODAL_UNSET \(tokenIdEnv\) is not set/)
    } finally {
      if (saved.id === undefined) delete process.env['SAMSARA_TEST_MODAL_ID']
      else process.env['SAMSARA_TEST_MODAL_ID'] = saved.id
      if (saved.secret === undefined) delete process.env['SAMSARA_TEST_MODAL_SECRET']
      else process.env['SAMSARA_TEST_MODAL_SECRET'] = saved.secret
    }
  })
})

// ---------------------------------------------------------------- real Modal

describe('the real-Modal gate', () => {
  it('is opt-in: SAMSARA_TEST_MODAL=1 and credentials the SDK resolves; a config file or a token alone does not open the describe', () => {
    const home = tempRoot()
    const empty = join(home, 'no-such-file')
    // credentials without the opt-in: a laptop with ~/.modal.toml running `pnpm test`
    writeFileSync(join(home, '.modal.toml'), '[default]\ntoken_id = "ak-x"\ntoken_secret = "as-x"\nactive = true\n')
    expect(modalOptedIn({}, home)).toBe(false)
    expect(modalOptedIn({ MODAL_TOKEN_ID: 'ak-x', MODAL_TOKEN_SECRET: 'as-x' }, home)).toBe(false)
    expect(modalOptedIn({ SAMSARA_TEST_MODAL: '' }, home)).toBe(false)
    expect(modalOptedIn({ SAMSARA_TEST_MODAL: 'true' }, home)).toBe(false)
    // the opt-in without credentials
    expect(modalOptedIn({ SAMSARA_TEST_MODAL: '1' }, join(home, 'nowhere'))).toBe(false)
    expect(modalOptedIn({ SAMSARA_TEST_MODAL: '1', MODAL_TOKEN_ID: '' }, join(home, 'nowhere'))).toBe(false)
    expect(modalOptedIn({ SAMSARA_TEST_MODAL: '1', MODAL_CONFIG_PATH: empty }, home)).toBe(false)
    // both
    expect(modalOptedIn({ SAMSARA_TEST_MODAL: '1' }, home)).toBe(true)
    expect(modalOptedIn({ SAMSARA_TEST_MODAL: '1', MODAL_TOKEN_ID: 'ak-x' }, join(home, 'nowhere'))).toBe(true)
    expect(modalOptedIn({ SAMSARA_TEST_MODAL: '1', MODAL_CONFIG_PATH: join(home, '.modal.toml') }, join(home, 'nowhere'))).toBe(true)
  })
})

const REAL_IMAGE = 'alpine:3.20'

describe.skipIf(!modalOptedIn(process.env, homedir()))(`ModalEnvironmentProvider against Modal (${MODAL_SKIP_REASON})`, () => {
  it('opens a sandbox, execs with stdin, puts and gets, keeps the executable bit, times an exec out to null, snapshots, disposes', async () => {
    const root = tempRoot()
    const { ModalClient } = await import('modal')
    const p = new ModalEnvironmentProvider({ client: new ModalClient(), app: 'samsara-test' })
    const started = Date.now()
    const mount = join(root, 'skill', 'bin')
    mkdirSync(mount, { recursive: true })
    writeFileSync(join(mount, 'tool'), '#!/bin/sh\necho tool-ran\n')
    chmodSync(join(mount, 'tool'), 0o755)
    const env = (await p.open(spec({ image: { ref: REAL_IMAGE }, env: { GREETING: 'hi' }, resources: { timeoutS: 300 }, mounts: [{ from: join(root, 'skill'), to: '/opt/skill', readOnly: true }] }))) as ModalEnvironment
    const opened = Date.now()
    try {
      expect(env.workdir).toBe('/workspace/att-1')
      const r = await env.exec(['sh', '-c', 'cat; echo "$GREETING"; pwd'], { stdin: 'in\n', timeoutMs: 30_000 })
      expect(r.code).toBe(0)
      expect(r.stdout).toBe('in\nhi\n/workspace/att-1\n')
      const extra = await env.exec(['sh', '-c', 'echo "$X"; cat'], { env: { X: 'y' }, timeoutMs: 30_000 })
      expect(extra.stdout).toBe('y\n')
      expect((await env.exec(['/opt/skill/bin/tool'], { timeoutMs: 30_000 })).stdout).toBe('tool-ran\n')
      writeFileSync(join(root, 'f.txt'), 'payload')
      await env.put(join(root, 'f.txt'), 'f.txt')
      expect((await env.exec(['cat', '/workspace/att-1/f.txt'], { timeoutMs: 30_000 })).stdout).toBe('payload')
      await env.exec(['sh', '-c', 'echo out > o.txt; mkdir -p t/u; echo a > t/a; echo b > t/u/b; ln -s ../a t/u/l'], { timeoutMs: 30_000 })
      await env.get('o.txt', join(root, 'o.txt'))
      expect(readFileSync(join(root, 'o.txt'), 'utf8')).toBe('out\n')
      await env.get('t', join(root, 'tree-out'))
      expect(readFileSync(join(root, 'tree-out', 'u', 'b'), 'utf8')).toBe('b\n')
      expect(readlinkSync(join(root, 'tree-out', 'u', 'l'))).toBe('../a')
      expect(readFileSync(join(root, 'tree-out', 'u', 'l'), 'utf8')).toBe('a\n')
      mkdirSync(join(root, 'tree'))
      writeFileSync(join(root, 'tree', 'a.txt'), 'a')
      await env.put(join(root, 'tree'), 'tree')
      await env.put(join(root, 'tree'), 'tree')
      expect((await env.exec(['ls', '/workspace/att-1/tree'], { timeoutMs: 30_000 })).stdout).toBe('a.txt\n')
      expect(env.facts().image?.digest).toMatch(/^im-/)
      const failed = await env.exec(['sh', '-c', 'echo bad >&2; exit 7'], { timeoutMs: 30_000 })
      expect(failed).toEqual({ code: 7, stdout: '', stderr: 'bad\n' })
      const hung = await env.exec(['sh', '-c', 'echo begun; sleep 30'], { timeoutMs: 1500 })
      expect(hung.code).toBeNull()
      expect(hung.signal).toBe('SIGKILL')
      expect(hung.stdout).toBe('begun\n')
      await new Promise((r) => setTimeout(r, 2000))
      // the worker ends the process at the rounded deadline: nothing of it lives on (`pgrep -f` would match its own shell)
      const left = await env.exec(['sh', '-c', 'ps -o args | grep "^sleep 30" || echo none'], { timeoutMs: 30_000 })
      expect(left.stdout).toBe('none\n')
      const offline = await env.exec(['sh', '-c', 'wget -q -T 3 -O /dev/null http://example.com/ 2>/dev/null; echo $?'], { timeoutMs: 30_000 })
      expect(offline.stdout.trim()).not.toBe('0')
      const snap = await env.snapshot!()
      expect(snap.digest).toMatch(/^im-/)
      expect(env.usage().wall_s).toBeGreaterThan(0)
    } finally {
      await env.dispose()
    }
    const disposed = Date.now()
    console.log(`modal: open ${opened - started}ms, work ${disposed - opened}ms, total ${disposed - started}ms, wall_s ${env.usage().wall_s.toFixed(1)}`)
    await expect(env.exec(['true'], { timeoutMs: 1000 })).rejects.toThrow(/disposed/)
  }, 300_000)
})
