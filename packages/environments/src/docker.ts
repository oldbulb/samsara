// Provider 'docker': a container per environment through the docker CLI —
// `build` from `dockerfileDir` or resolve `ref` on the daemon (`pull` only
// when it is absent), `run -d` with the resources and the network policy,
// `exec -i` for commands, `cp` both ways, `commit` for snapshots, `rm -f` to
// dispose. The environment's `env` (and an exec's extras) reach the container
// through `--env-file` files written under a private directory, never on the
// argv (E5: an argv is world-readable in `ps`). The binary path and the spawn
// function are injectable so tests run against a fake `docker` on PATH.
//
// Images: a `ref` is resolved once per provider instance — every environment
// of a run starts from the same image id whatever a tag does meanwhile — and
// `facts().image.digest` is its registry digest (`RepoDigests`, the same on
// any host and any image store), falling back to the daemon's image id for
// an image with no registry identity (a `dockerfileDir` build, a local-only
// tag, a snapshot). Exec timeouts and aborts reach the process: the CLI has no
// handle on what `exec` started, so the container is killed and started again
// (its filesystem stays, every process in it dies). `put`/`get` match the
// local provider: parents are created, a directory merges into an existing
// one; symlinks are copied as links, so a link into the host resolves inside
// only when its target is mounted at its own path.
//
// Not covered by the CLI: `allowlist` runs as `none` (recorded in `notes` and
// in `facts().network`); `resources.timeoutS` is the caller's deadline, not a
// container setting.

import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, posix, resolve, sep } from 'node:path'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@oldbulb/samsara-kernel'
import type { SpawnFn } from './local.ts'
import type { Environment, EnvironmentFacts, EnvironmentProvider, EnvironmentSpec, ExecOptions, ExecResult } from './types.ts'

export const DOCKER_PROVIDER_VERSION = '0.1.0'
/** Environments without a `workdir` run in `<DEFAULT_DOCKER_WORKDIR>/<attemptId>`: the pack contract names the workdir after the attempt. */
export const DEFAULT_DOCKER_WORKDIR = '/workspace'
/** Build and pull may take long; every other client call is control traffic. */
export const DEFAULT_IMAGE_TIMEOUT_MS = 1_800_000
const CONTROL_TIMEOUT_MS = 120_000
const DEFAULT_GRACE_MS = 1_000
const COLLECT_MAX_BYTES = 8 * 1024 * 1024
/** What the docker client sees of the host: where its binary and its config live, and which daemon to talk to. */
const CLIENT_ENV = ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY'] as const
/** One inspect for both names of an image: the daemon's id, then the registry digests as a JSON array. */
const INSPECT_FORMAT = '{{.Id}} {{json .RepoDigests}}'

export interface DockerEnvironmentOptions {
  spawn: SpawnFn
  /** The docker binary: a bare name on PATH or an absolute path. */
  docker?: string
  /** Where env files are written (mode 0600, removed on dispose); defaults to `<os tmpdir>/samsara-environments`. */
  baseDir?: string
  /** Deadline for `build` and `pull`. */
  imageTimeoutMs?: number
  /** Grace between SIGTERM and SIGKILL when a timeout, an abort or dispose ends a client process. */
  graceMs?: number
}

interface ClientCall {
  stdin?: string
  timeoutMs: number
  signal?: AbortSignal
}

/** An image as the daemon knows it (`id`, what `run` is given) and as the ledger names it (`digest`). */
export interface ImageIdentity {
  id: string
  digest: string
}

function clientEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const k of CLIENT_ENV) {
    const v = process.env[k]
    if (v !== undefined) env[k] = v
  }
  return env
}

function readCollected(handle: SubprocessHandle, stream: 'stdout' | 'stderr'): string {
  return handle.collected[stream]?.readFrom(0).text ?? ''
}

/** One `KEY=VALUE` per line, the shape `--env-file` reads; a value with a newline cannot be carried that way. */
export function envFileText(env: Record<string, string>): string {
  const lines: string[] = []
  for (const [k, v] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`environments/docker: invalid environment name ${JSON.stringify(k)}`)
    if (v.includes('\n')) throw new Error(`environments/docker: environment value of ${k} contains a newline; an env file cannot carry it`)
    lines.push(`${k}=${v}`)
  }
  return lines.map((l) => l + '\n').join('')
}

/** The repository of a ref: no `@digest`, no `:tag` (a `:` before the last `/` is a registry port). */
export function repositoryOf(ref: string): string {
  const named = ref.split('@')[0]!
  const colon = named.lastIndexOf(':')
  return colon > named.lastIndexOf('/') ? named.slice(0, colon) : named
}

/**
 * The identity from an inspect line: the registry digest of the entry that
 * names the ref's repository (else the first, else the id itself) — the same
 * pulled image gives one `digest` on any host, whichever image store it has.
 */
export function imageIdentity(inspected: string, ref?: string): ImageIdentity {
  const space = inspected.indexOf(' ')
  const id = space === -1 ? inspected : inspected.slice(0, space)
  const repoDigests: string[] = space === -1 ? [] : ((JSON.parse(inspected.slice(space + 1)) as string[] | null) ?? [])
  const repository = ref === undefined ? undefined : repositoryOf(ref)
  const entry = repoDigests.find((d) => d.split('@')[0] === repository) ?? repoDigests[0]
  return { id, digest: entry === undefined ? id : entry.slice(entry.indexOf('@') + 1) }
}

/** A container name the catch of `open` can `rm -f` whatever `run` did: the attempt plus the private directory's random suffix. */
export function containerName(attemptId: string, dir: string): string {
  return `samsara-${attemptId.replace(/[^A-Za-z0-9_.-]/g, '-')}-${basename(dir).slice(-6)}`
}

/** The argv of `docker run -d` for a spec: name, resources, network, mounts, env file, workdir, then the image kept alive by `sleep infinity`. */
export function runArgv(spec: EnvironmentSpec, image: string, envFile: string | undefined, workdir: string, name: string): string[] {
  const argv = ['run', '-d', '--name', name, '--label', `samsara.attempt=${spec.attemptId}`]
  if (spec.resources.cpus !== undefined) argv.push('--cpus', String(spec.resources.cpus))
  if (spec.resources.memoryMb !== undefined) argv.push('--memory', `${spec.resources.memoryMb}m`)
  argv.push('--network', spec.network === 'public' ? 'bridge' : 'none')
  if (envFile !== undefined) argv.push('--env-file', envFile)
  for (const mount of spec.mounts) argv.push('-v', `${resolve(mount.from)}:${mount.to}:${mount.readOnly ? 'ro' : 'rw'}`)
  argv.push('-w', workdir, image, 'sleep', 'infinity')
  return argv
}

class DockerClient {
  readonly docker: string
  private readonly clients = new Set<SubprocessHandle>()

  constructor(private readonly options: DockerEnvironmentOptions, private readonly cwd: string) {
    this.docker = options.docker ?? 'docker'
  }

  /** Spawn the client once; resolves with the exit facts, the collected streams and whether the deadline or the abort ended it. */
  async call(args: string[], call: ClientCall): Promise<{ result: ExecResult; terminated: boolean }> {
    const spec: SubprocessSpawnSpec = {
      argv: [this.docker, ...args],
      cwd: this.cwd,
      stdio: { stdin: call.stdin === undefined ? 'ignore' : { data: call.stdin }, stdout: { maxBytes: COLLECT_MAX_BYTES }, stderr: { maxBytes: COLLECT_MAX_BYTES } },
      graceMs: this.options.graceMs ?? DEFAULT_GRACE_MS,
      env: clientEnv(),
    }
    const handle = this.options.spawn(spec)
    this.clients.add(handle)
    let terminated = false
    const end = (): void => {
      terminated = true
      handle.terminate()
    }
    const timer = setTimeout(end, call.timeoutMs)
    call.signal?.addEventListener('abort', end, { once: true })
    let outcome
    try {
      outcome = await handle.done
    } finally {
      clearTimeout(timer)
      call.signal?.removeEventListener('abort', end)
      this.clients.delete(handle)
    }
    const result: ExecResult = { code: outcome.exitCode, stdout: readCollected(handle, 'stdout'), stderr: readCollected(handle, 'stderr') }
    if (outcome.signal !== null) result.signal = outcome.signal
    return { result, terminated }
  }

  async spawn(args: string[], call: ClientCall): Promise<ExecResult> {
    return (await this.call(args, call)).result
  }

  /** A control call: must exit 0; returns trimmed stdout. */
  async run(args: string[], timeoutMs: number = CONTROL_TIMEOUT_MS): Promise<string> {
    const r = await this.spawn(args, { timeoutMs })
    if (r.code !== 0) {
      throw new Error(`environments/docker: ${this.docker} ${args[0]} exited with code ${r.code ?? 'null'} signal ${r.signal ?? 'none'}: ${r.stderr.trim()}`)
    }
    return r.stdout.trim()
  }

  async inspectImage(image: string, ref?: string): Promise<ImageIdentity> {
    return imageIdentity(await this.run(['image', 'inspect', '--format', INSPECT_FORMAT, image]), ref)
  }

  async terminateAll(): Promise<void> {
    const live = [...this.clients]
    for (const c of live) c.terminate()
    await Promise.allSettled(live.map((c) => c.done))
  }
}

export class DockerEnvironment implements Environment {
  readonly provider = 'docker'
  readonly notes: string[] = []
  private execs = 0
  private disposed: Promise<void> | undefined

  constructor(
    readonly id: string,
    readonly workdir: string,
    private readonly spec: EnvironmentSpec,
    private readonly image: { ref?: string; digest: string },
    private readonly client: DockerClient,
    private readonly dir: string,
  ) {
    if (spec.network === 'allowlist') this.notes.push('network allowlist is not supported by the docker provider; ran with none')
  }

  async exec(argv: string[], opts: ExecOptions): Promise<ExecResult> {
    if (this.disposed) throw new Error(`environments/docker: ${this.id} is disposed`)
    if (opts.signal?.aborted) return { code: null, signal: 'SIGKILL', stdout: '', stderr: '' }
    const args = ['exec', '-i']
    if (opts.cwd !== undefined) args.push('-w', opts.cwd)
    if (opts.user !== undefined) args.push('-u', opts.user)
    if (opts.env !== undefined && Object.keys(opts.env).length > 0) {
      const file = join(this.dir, `exec-${++this.execs}.env`)
      writeFileSync(file, envFileText(opts.env), { mode: 0o600 })
      args.push('--env-file', file)
    }
    args.push(this.id, ...argv)
    const call: ClientCall = { timeoutMs: opts.timeoutMs }
    if (opts.stdin !== undefined) call.stdin = opts.stdin
    if (opts.signal !== undefined) call.signal = opts.signal
    const { result, terminated } = await this.client.call(args, call)
    if (terminated && !this.disposed) await this.restart(opts.signal?.aborted ? 'aborted' : `timed out after ${opts.timeoutMs}ms`)
    return result
  }

  /** The client is gone but what it exec'd is not: `kill` ends every process in the container, `start` brings it back with its filesystem. */
  private async restart(reason: string): Promise<void> {
    await this.client.spawn(['kill', this.id], { timeoutMs: CONTROL_TIMEOUT_MS })
    await this.client.run(['start', this.id])
    this.notes.push(`exec ${reason}; the container was killed and started again so nothing of it lives on`)
  }

  /** A remote path the caller wrote relative to the workdir; the container is Linux whatever the host. */
  private inside(remotePath: string): string {
    return posix.isAbsolute(remotePath) ? remotePath : posix.join(this.workdir, remotePath)
  }

  /** A directory copies its contents (`/.`) into the destination created first, so an existing one is merged, not nested into. */
  async put(localPath: string, remotePath: string): Promise<void> {
    const from = resolve(localPath)
    const to = this.inside(remotePath)
    const directory = statSync(from).isDirectory()
    await this.client.run(['exec', this.id, 'mkdir', '-p', directory ? to : posix.dirname(to)])
    await this.client.run(['cp', directory ? `${from}${sep}.` : from, `${this.id}:${to}`])
  }

  async get(remotePath: string, localPath: string): Promise<void> {
    const from = this.inside(remotePath)
    const to = resolve(localPath)
    mkdirSync(dirname(to), { recursive: true })
    const directory = (await this.client.spawn(['exec', this.id, 'test', '-d', from], { timeoutMs: CONTROL_TIMEOUT_MS })).code === 0
    await this.client.run(['cp', `${this.id}:${directory ? `${from}/.` : from}`, to])
  }

  async snapshot(): Promise<{ ref: string; digest: string }> {
    const ref = await this.client.run(['commit', this.id])
    return { ref, digest: (await this.client.inspectImage(ref)).digest }
  }

  facts(): EnvironmentFacts {
    const facts: EnvironmentFacts = {
      provider: this.provider,
      version: DOCKER_PROVIDER_VERSION,
      image: this.image.ref === undefined ? { digest: this.image.digest } : { ref: this.image.ref, digest: this.image.digest },
      resources: { ...this.spec.resources },
      network: this.spec.network === 'public' ? 'public' : 'none',
    }
    return facts
  }

  dispose(): Promise<void> {
    this.disposed ??= (async () => {
      await this.client.terminateAll()
      try {
        await this.client.run(['rm', '-f', this.id])
      } finally {
        rmSync(this.dir, { recursive: true, force: true })
      }
    })()
    return this.disposed
  }
}

export class DockerEnvironmentProvider implements EnvironmentProvider {
  readonly name = 'docker'
  readonly version = DOCKER_PROVIDER_VERSION
  readonly baseDir: string
  /** A ref resolved once per provider: the image on the daemon, pulled only when absent, so the environments of a run share one image id. */
  private readonly images = new Map<string, Promise<ImageIdentity>>()

  constructor(private readonly options: DockerEnvironmentOptions) {
    this.baseDir = resolve(options.baseDir ?? join(tmpdir(), 'samsara-environments'))
  }

  private resolveRef(client: DockerClient, ref: string, timeoutMs: number): Promise<ImageIdentity> {
    let pending = this.images.get(ref)
    if (pending === undefined) {
      pending = (async () => {
        try {
          return await client.inspectImage(ref, ref)
        } catch {
          await client.run(['pull', '-q', ref], timeoutMs)
          return client.inspectImage(ref, ref)
        }
      })()
      this.images.set(ref, pending)
      pending.catch(() => this.images.delete(ref))
    }
    return pending
  }

  async open(spec: EnvironmentSpec): Promise<Environment> {
    if (spec.attemptId === '' || spec.attemptId.includes(sep) || spec.attemptId.includes('/')) {
      throw new Error(`environments/docker: attemptId must be a single path segment: ${JSON.stringify(spec.attemptId)}`)
    }
    mkdirSync(this.baseDir, { recursive: true })
    const dir = mkdtempSync(join(this.baseDir, `docker-${spec.attemptId}-`))
    const client = new DockerClient(this.options, dir)
    const name = containerName(spec.attemptId, dir)
    let started = false
    try {
      const imageTimeoutMs = this.options.imageTimeoutMs ?? DEFAULT_IMAGE_TIMEOUT_MS
      let image: ImageIdentity
      let ref: string | undefined
      if (spec.image?.dockerfileDir !== undefined) {
        image = await client.inspectImage(await client.run(['build', '-q', resolve(spec.image.dockerfileDir)], imageTimeoutMs))
      } else if (spec.image?.ref !== undefined) {
        ref = spec.image.ref
        image = await this.resolveRef(client, ref, imageTimeoutMs)
      } else {
        throw new Error('environments/docker: the spec names no image (image.ref or image.dockerfileDir)')
      }
      let envFile: string | undefined
      if (Object.keys(spec.env).length > 0) {
        envFile = join(dir, 'environment.env')
        writeFileSync(envFile, envFileText(spec.env), { mode: 0o600 })
      }
      const workdir = spec.workdir ?? posix.join(DEFAULT_DOCKER_WORKDIR, spec.attemptId)
      started = true
      const id = await client.run(runArgv(spec, image.id, envFile, workdir, name))
      if (id === '') throw new Error('environments/docker: docker run printed no container id')
      return new DockerEnvironment(id, workdir, spec, ref === undefined ? { digest: image.digest } : { ref, digest: image.digest }, client, dir)
    } catch (error) {
      // whatever `run` left (created, or running past the client's deadline) goes with its name; nothing else names it
      if (started) await client.spawn(['rm', '-f', name], { timeoutMs: CONTROL_TIMEOUT_MS }).catch(() => undefined)
      rmSync(dir, { recursive: true, force: true })
      throw error
    }
  }
}
