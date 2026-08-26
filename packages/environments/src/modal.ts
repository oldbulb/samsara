// Provider 'modal': a Modal sandbox per environment through the `modal` SDK
// (pinned; the V2 `experimentalCreate` API is not used) — `images.fromRegistry`
// for the image, `sandboxes.create` with the resources, the network policy,
// the workdir and the environment as an in-memory `Secret` (never on a
// command line), `sandbox.exec` for commands, the sandbox filesystem for
// copies, `snapshotFilesystem` for snapshots, `terminate` to dispose. The
// client and the app are injectable so tests run against a fake that records
// every call.
//
// Images: only `ref` — the SDK builds from Dockerfile commands but takes no
// build context (`COPY` from a directory is refused by it), so a
// `dockerfileDir` is refused here with that reason. The digest the ledger
// names is the registry digest when the ref pins one (`repo@sha256:…`, the
// same identity the docker provider reports, so the two providers are one
// design under rule 0), else the Modal image id, stable per workspace and
// builder version but no registry identity. A ref is resolved once per
// provider instance: every environment of a run starts from the image the
// first one built.
//
// Exec: the SDK takes the timeout in whole seconds and the worker ends the
// process at it, within the second of the caller's deadline; the call then
// answers `code: null` + `SIGKILL` with what the process wrote before the kill
// (the streams the worker closed are drained, within a grace — output still in
// flight at the deadline is not dropped, as the docker and local providers
// keep it too). An abort ends the call only — the SDK has no kill for an exec,
// so the process inside runs until the sandbox's own lifetime or dispose
// (recorded in `notes`). `put`/`get` copy files one by one (the filesystem API
// moves files, not trees): parents are created, a directory merges into an
// existing one, the executable bit is restored with `chmod` since the API
// does not carry modes. `put` follows symlinks (the API cannot make one in
// the sandbox); `get` carries them back as links, as docker's `cp` and the
// local provider do. Mounts are copies made before `open` returns; read-only
// is not enforced (the sandbox runs as root) and `notes` say so. `user` is
// not honoured: everything runs as the sandbox's user.
//
// Resources: `cpus`/`memoryMb` are set as the reservation and the hard limit
// both, so the declared numbers bound the sandbox as `--cpus`/`--memory`
// bound a docker container (rule 0: one environment_sha, one design).
// `timeoutS` is the callers' deadline (the docker provider enforces nothing
// for it either); the sandbox's lifetime is a backstop for a host that never
// disposes (E4 is the kill), sized so the callers' deadlines end an attempt
// before Modal does: twice `timeoutS` — a command inside is bounded by it,
// and so is what runs before it — plus a fixed headroom for open, the copies
// and what follows. The lifetime is recorded in `notes`.
//
// First contact: a fresh sandbox's command router can stay unreachable for
// longer than the SDK's own retry budget (about ten seconds; a proxy in front
// of the host stretches the first connection), and the SDK then reports the
// sandbox as unavailable while it is running. The first call into it is
// retried while `poll` says it still runs; a sandbox that has exited fails at
// once.

import { mkdirSync, readdirSync, realpathSync, statSync, symlinkSync, unlinkSync } from 'node:fs'
import { join, posix, resolve } from 'node:path'
import type { Environment, EnvironmentFacts, EnvironmentProvider, EnvironmentSpec, ExecOptions, ExecResult } from './types.ts'

/** The SDK version this provider was built against (`modal` in package.json). */
export const MODAL_SDK_VERSION = '0.9.0'
export const MODAL_PROVIDER_VERSION = MODAL_SDK_VERSION
/** Environments without a `workdir` run in `<DEFAULT_MODAL_WORKDIR>/<attemptId>`: the pack contract names the workdir after the attempt. */
export const DEFAULT_MODAL_WORKDIR = '/workspace'
export const DEFAULT_MODAL_APP = 'samsara'
/** Files copied concurrently by `put` and `get`; every file is one exec inside the sandbox. */
const COPY_CONCURRENCY = 8
/** The SDK caps an exec's argv at 64 KiB; a `chmod` batch stays well under it. */
const CHMOD_BATCH_BYTES = 32 * 1024
const CONTROL_TIMEOUT_MS = 60_000
/** What the sandbox's lifetime allows beyond twice `timeoutS`: open (first contact included), the copies in and out, and what runs after the commands. */
const LIFETIME_HEADROOM_S = 600
/** How long a timed-out exec waits for the worker's kill (within the second of rounding) to end the streams before answering with what arrived. */
const KILL_GRACE_MS = 5_000
/** How long the first call into a fresh sandbox is retried, and the pause between tries. */
const FIRST_CONTACT_MS = 60_000
const FIRST_CONTACT_DELAY_MS = 1_000
/** The SDK's message for a control-plane error on a sandbox, whatever its cause. */
const SANDBOX_UNAVAILABLE = /Sandbox is unavailable/

// ---------------------------------------------------------------- the SDK surface used

/** The part of the SDK's `ContainerProcess` this provider reads. */
export interface ModalProcess {
  stdin: { writeText(text: string): Promise<void>; close(): Promise<void> }
  stdout: ReadableStream<string>
  stderr: ReadableStream<string>
  wait(): Promise<number>
}

export interface ModalFileInfo {
  readonly name: string
  readonly path: string
  readonly type: 'file' | 'directory' | 'symlink'
  readonly symlinkTarget: string | null
}

export type ModalExecParams = { workdir?: string; timeoutMs?: number; env?: Record<string, string>; stdout?: 'pipe' | 'ignore'; stderr?: 'pipe' | 'ignore' }

/** The part of the SDK's `Sandbox` this provider uses. */
export interface ModalSandbox {
  readonly sandboxId: string
  exec(command: string[], params?: ModalExecParams): Promise<ModalProcess>
  filesystem: {
    copyFromLocal(localPath: string, remotePath: string): Promise<void>
    copyToLocal(remotePath: string, localPath: string): Promise<void>
    listFiles(remotePath: string): Promise<ModalFileInfo[]>
    makeDirectory(remotePath: string, options?: { createParents?: boolean }): Promise<void>
    stat(remotePath: string): Promise<ModalFileInfo>
  }
  snapshotFilesystem(): Promise<{ imageId: string }>
  /** `null` while the sandbox runs, else its exit code. */
  poll(): Promise<number | null>
  terminate(params: { wait: true }): Promise<number>
}

export interface ModalApp { readonly appId: string }
export interface ModalImage { readonly imageId: string }
export interface ModalSecret { readonly secretId: string }

export type ModalSandboxCreateParams = {
  cpu?: number
  cpuLimit?: number
  memoryMiB?: number
  memoryLimitMiB?: number
  timeoutMs?: number
  workdir?: string
  secrets?: ModalSecret[]
  blockNetwork?: boolean
  outboundDomainAllowlist?: string[]
}

/** The part of the SDK's `ModalClient` this provider uses; a `ModalClient` satisfies it. */
export interface ModalClientLike {
  apps: { fromName(name: string, params?: { createIfMissing?: boolean }): Promise<ModalApp> }
  images: { fromRegistry(tag: string): ModalImage }
  secrets: { fromObject(entries: Record<string, string>): Promise<ModalSecret> }
  sandboxes: { create(app: ModalApp, image: ModalImage, params?: ModalSandboxCreateParams): Promise<ModalSandbox> }
}

export interface ModalEnvironmentOptions {
  client: ModalClientLike
  /** The Modal App the sandboxes are created in (created when missing); default `samsara`. */
  app?: string
}

// ---------------------------------------------------------------- helpers

/** The registry digest a ref pins (`repo@sha256:…`), if any. */
export function pinnedDigest(ref: string): string | undefined {
  const at = ref.indexOf('@')
  return at === -1 ? undefined : ref.slice(at + 1)
}

/** The sandbox's lifetime for a `timeoutS`: the callers' deadlines end an attempt before Modal does. */
export function sandboxLifetimeMs(timeoutS: number): number {
  return (2 * timeoutS + LIFETIME_HEADROOM_S) * 1000
}

/** The sandbox create params for a spec: lifetime, workdir, resources (reservation and hard limit both), the environment as a secret, the network policy. */
export function createParams(spec: EnvironmentSpec, workdir: string, secret: ModalSecret | undefined): ModalSandboxCreateParams {
  const params: ModalSandboxCreateParams = { timeoutMs: sandboxLifetimeMs(spec.resources.timeoutS), workdir }
  if (spec.resources.cpus !== undefined) params.cpu = params.cpuLimit = spec.resources.cpus
  if (spec.resources.memoryMb !== undefined) params.memoryMiB = params.memoryLimitMiB = spec.resources.memoryMb
  if (secret !== undefined) params.secrets = [secret]
  if (spec.network === 'none') params.blockNetwork = true
  else if (spec.network === 'allowlist') params.outboundDomainAllowlist = [...(spec.allowedHosts ?? [])]
  return params
}

/** The SDK takes whole seconds and refuses zero: the caller's deadline rounded up. */
export function sdkTimeoutMs(timeoutMs: number): number {
  return Math.max(1, Math.ceil(timeoutMs / 1000)) * 1000
}

/** Read a stream to its end into `into`; a stream the deadline or the kill ended keeps what it had. */
async function collect(stream: ReadableStream<string>, into: string[]): Promise<void> {
  try {
    for await (const chunk of stream) into.push(chunk)
  } catch {
    // the worker closed the stream on the deadline, or the sandbox is gone
  }
}

/**
 * The first call into a fresh sandbox, retried on the SDK's "unavailable"
 * while the sandbox still runs (its command router is not reachable yet);
 * any other error, a sandbox that has exited, or the deadline surfaces it.
 */
async function firstContact(sandbox: ModalSandbox, call: () => Promise<void>, notes: string[]): Promise<void> {
  const until = Date.now() + FIRST_CONTACT_MS
  for (let tries = 1; ; tries++) {
    try {
      await call()
      if (tries > 1) notes.push(`first contact took ${tries} tries`)
      return
    } catch (error) {
      if (!(error instanceof Error && SANDBOX_UNAVAILABLE.test(error.message)) || Date.now() >= until) throw error
      if ((await sandbox.poll().catch(() => null)) !== null) throw error
      await new Promise((r) => setTimeout(r, FIRST_CONTACT_DELAY_MS))
    }
  }
}

async function parallel<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) await fn(items[next++]!)
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

interface LocalTree {
  dirs: string[]
  files: { from: string; to: string; executable: boolean }[]
}

/** A local directory as remote paths under `to`: symlinks are followed (a dangling one is skipped), a directory seen twice is not walked again. */
function walkLocal(from: string, to: string, seen: Set<string>): LocalTree {
  const tree: LocalTree = { dirs: [], files: [] }
  const real = realpathSync(from)
  if (seen.has(real)) return tree
  seen.add(real)
  tree.dirs.push(to)
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const path = join(from, entry.name)
    let stat
    try {
      stat = statSync(path)
    } catch {
      continue
    }
    if (stat.isDirectory()) {
      const sub = walkLocal(path, posix.join(to, entry.name), seen)
      tree.dirs.push(...sub.dirs)
      tree.files.push(...sub.files)
    } else if (stat.isFile()) {
      tree.files.push({ from: path, to: posix.join(to, entry.name), executable: (stat.mode & 0o111) !== 0 })
    }
  }
  return tree
}

// ---------------------------------------------------------------- the environment

export class ModalEnvironment implements Environment {
  readonly provider = 'modal'
  readonly notes: string[] = []
  private readonly openedAt = Date.now()
  private disposed: Promise<void> | undefined

  constructor(
    readonly id: string,
    readonly workdir: string,
    private readonly spec: EnvironmentSpec,
    private readonly image: { ref: string; digest: string },
    private readonly sandbox: ModalSandbox,
  ) {
    this.notes.push(`sandbox lifetime ${sandboxLifetimeMs(spec.resources.timeoutS) / 1000}s: a backstop past timeoutS ${spec.resources.timeoutS}, which the callers' deadlines enforce`)
    for (const mount of spec.mounts) if (mount.readOnly) this.notes.push(`mount ${mount.to}: a copy; read-only is not enforced by the modal provider`)
  }

  /** A remote path the caller wrote relative to the workdir; the sandbox is Linux whatever the host. */
  private inside(remotePath: string): string {
    return posix.isAbsolute(remotePath) ? remotePath : posix.join(this.workdir, remotePath)
  }

  async exec(argv: string[], opts: ExecOptions): Promise<ExecResult> {
    if (this.disposed) throw new Error(`environments/modal: ${this.id} is disposed`)
    if (opts.signal?.aborted) return { code: null, signal: 'SIGKILL', stdout: '', stderr: '' }
    const params: ModalExecParams = { workdir: opts.cwd === undefined ? this.workdir : this.inside(opts.cwd), timeoutMs: sdkTimeoutMs(opts.timeoutMs), stdout: 'pipe', stderr: 'pipe' }
    if (opts.env !== undefined && Object.keys(opts.env).length > 0) params.env = { ...opts.env }
    const process = await this.sandbox.exec(argv, params)
    const stdout: string[] = []
    const stderr: string[] = []
    const output = Promise.all([collect(process.stdout, stdout), collect(process.stderr, stderr)])
    // stdin is closed either way: a command reading it must see EOF; a process gone before the write is not an error
    const stdin = (opts.stdin === undefined ? Promise.resolve() : process.stdin.writeText(opts.stdin)).then(() => process.stdin.close()).catch(() => undefined)
    let timer: NodeJS.Timeout | undefined
    let onAbort: (() => void) | undefined
    const ended = new Promise<'timeout' | 'abort'>((res) => {
      timer = setTimeout(() => res('timeout'), opts.timeoutMs)
      onAbort = (): void => res('abort')
      opts.signal?.addEventListener('abort', onAbort, { once: true })
    })
    // The worker's deadline (the rounded timeout) ends `wait` with an error: a timeout too.
    const exit = process.wait().then((code) => ({ code }), (error: unknown) => ({ error }))
    const settled = exit.then(async (e) => { await output; return e })
    let outcome: { code: number } | { error: unknown } | 'timeout' | 'abort'
    try {
      outcome = await Promise.race([settled, ended])
      // the worker's kill closes the streams: what the process wrote before it is drained, within the grace
      if (outcome === 'timeout') await Promise.race([settled, new Promise<void>((res) => { timer = setTimeout(res, KILL_GRACE_MS) })])
    } finally {
      clearTimeout(timer)
      if (onAbort) opts.signal?.removeEventListener('abort', onAbort)
    }
    await stdin
    const killed: ExecResult = { code: null, signal: 'SIGKILL', stdout: stdout.join(''), stderr: stderr.join('') }
    if (outcome === 'timeout') return killed
    if (outcome === 'abort') {
      this.notes.push('exec aborted; the process inside runs until dispose (the SDK has no kill for an exec)')
      return killed
    }
    if ('error' in outcome) {
      if (outcome.error instanceof Error && /deadline/i.test(outcome.error.message)) return killed
      throw outcome.error
    }
    return { code: outcome.code, stdout: stdout.join(''), stderr: stderr.join('') }
  }

  /** One control exec that must exit 0. */
  private async control(argv: string[]): Promise<void> {
    const r = await this.exec(argv, { timeoutMs: CONTROL_TIMEOUT_MS })
    if (r.code !== 0) throw new Error(`environments/modal: ${argv[0]} exited with code ${r.code ?? 'null'}: ${r.stderr.trim()}`)
  }

  /** A directory copies its files into the destination created first, so an existing one is merged, not nested into. */
  async put(localPath: string, remotePath: string): Promise<void> {
    const from = resolve(localPath)
    const to = this.inside(remotePath)
    if (!statSync(from).isDirectory()) {
      await this.sandbox.filesystem.copyFromLocal(from, to)
      return
    }
    const tree = walkLocal(from, to, new Set())
    for (const dir of tree.dirs) await this.sandbox.filesystem.makeDirectory(dir)
    await parallel(tree.files, COPY_CONCURRENCY, (f) => this.sandbox.filesystem.copyFromLocal(f.from, f.to))
    // the filesystem API carries no modes: the executable bit comes back with chmod, batched under the SDK's argv cap
    let batch: string[] = []
    let bytes = 0
    for (const f of tree.files) {
      if (!f.executable) continue
      if (batch.length > 0 && bytes + f.to.length > CHMOD_BATCH_BYTES) {
        await this.control(['chmod', '+x', ...batch])
        batch = []
        bytes = 0
      }
      batch.push(f.to)
      bytes += f.to.length
    }
    if (batch.length > 0) await this.control(['chmod', '+x', ...batch])
  }

  /** A directory is walked: files copied, subdirectories walked, a symlink made again locally with the target it has inside (over whatever the path held). */
  async get(remotePath: string, localPath: string): Promise<void> {
    const from = this.inside(remotePath)
    const to = resolve(localPath)
    if ((await this.sandbox.filesystem.stat(from)).type !== 'directory') {
      await this.sandbox.filesystem.copyToLocal(from, to)
      return
    }
    const files: { from: string; to: string }[] = []
    const walk = async (dir: string, local: string): Promise<void> => {
      mkdirSync(local, { recursive: true })
      for (const entry of await this.sandbox.filesystem.listFiles(dir)) {
        if (entry.type === 'directory') await walk(posix.join(dir, entry.name), join(local, entry.name))
        else if (entry.type === 'file') files.push({ from: posix.join(dir, entry.name), to: join(local, entry.name) })
        else if (entry.symlinkTarget !== null) {
          const link = join(local, entry.name)
          try {
            unlinkSync(link)
          } catch {
            // nothing there, or a directory: the link replaces the former and fails on the latter as a copy would
          }
          symlinkSync(entry.symlinkTarget, link)
        }
      }
    }
    await walk(from, to)
    await parallel(files, COPY_CONCURRENCY, (f) => this.sandbox.filesystem.copyToLocal(f.from, f.to))
  }

  async snapshot(): Promise<{ ref: string; digest: string }> {
    const image = await this.sandbox.snapshotFilesystem()
    return { ref: image.imageId, digest: image.imageId }
  }

  facts(): EnvironmentFacts {
    const facts: EnvironmentFacts = {
      provider: this.provider,
      version: MODAL_PROVIDER_VERSION,
      image: { ref: this.image.ref, digest: this.image.digest },
      resources: { ...this.spec.resources },
      network: this.spec.network,
    }
    if (this.spec.network === 'allowlist') facts.allowedHosts = [...(this.spec.allowedHosts ?? [])]
    return facts
  }

  /** Wall seconds since the sandbox was created — what Modal bills, with the resources (the ledger's `cost.wall_s`). */
  usage(): { wall_s: number } {
    return { wall_s: (Date.now() - this.openedAt) / 1000 }
  }

  dispose(): Promise<void> {
    this.disposed ??= (async () => {
      await this.sandbox.terminate({ wait: true })
    })()
    return this.disposed
  }
}

// ---------------------------------------------------------------- the provider

export class ModalEnvironmentProvider implements EnvironmentProvider {
  readonly name = 'modal'
  readonly version = MODAL_PROVIDER_VERSION
  readonly appName: string
  private app: Promise<ModalApp> | undefined
  /** A ref resolved once per provider: the image the first environment built, so the environments of a run share one image id. */
  private readonly images = new Map<string, ModalImage>()

  constructor(private readonly options: ModalEnvironmentOptions) {
    this.appName = options.app ?? DEFAULT_MODAL_APP
  }

  private resolveApp(): Promise<ModalApp> {
    if (this.app === undefined) {
      const pending = this.options.client.apps.fromName(this.appName, { createIfMissing: true })
      this.app = pending
      pending.catch(() => { if (this.app === pending) this.app = undefined })
    }
    return this.app
  }

  async open(spec: EnvironmentSpec): Promise<Environment> {
    if (spec.attemptId === '' || spec.attemptId.includes('/')) {
      throw new Error(`environments/modal: attemptId must be a single path segment: ${JSON.stringify(spec.attemptId)}`)
    }
    if (spec.image?.dockerfileDir !== undefined) {
      throw new Error(`environments/modal: image.dockerfileDir is not supported: the modal SDK ${MODAL_SDK_VERSION} builds from Dockerfile commands without a build context; publish the image and name it with image.ref`)
    }
    const ref = spec.image?.ref
    if (ref === undefined) throw new Error('environments/modal: the spec names no image (image.ref)')
    const client = this.options.client
    const app = await this.resolveApp()
    let image = this.images.get(ref)
    if (image === undefined) {
      image = client.images.fromRegistry(ref)
      this.images.set(ref, image)
    }
    const secret = Object.keys(spec.env).length > 0 ? await client.secrets.fromObject({ ...spec.env }) : undefined
    const workdir = spec.workdir ?? posix.join(DEFAULT_MODAL_WORKDIR, spec.attemptId)
    const sandbox = await client.sandboxes.create(app, image, createParams(spec, workdir, secret))
    const digest = pinnedDigest(ref)
    const env = new ModalEnvironment(sandbox.sandboxId, workdir, spec, { ref, digest: digest ?? image.imageId }, sandbox)
    if (digest !== undefined) env.notes.push(`image ${ref} is Modal image ${image.imageId}`)
    try {
      await firstContact(sandbox, () => sandbox.filesystem.makeDirectory(workdir), env.notes)
      for (const mount of spec.mounts) await env.put(mount.from, mount.to)
    } catch (error) {
      await env.dispose().catch(() => undefined)
      throw error
    }
    return env
  }
}
