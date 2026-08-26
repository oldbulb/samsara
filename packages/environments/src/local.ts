// Provider 'local': today's behaviour behind the seam — a directory on this
// host, subprocesses through a spawn function the plugin binds to
// `ctx.subprocess.spawn` (E4), wrapped with the sandbox policy where the host
// enforces one (E9), an explicit environment (E5). A directory of the
// provider's own (`<baseDir>/<attemptId>`) goes with dispose; a `spec.workdir`
// is the caller's (the runner's attempt dir) and outlives it.
//
// Mounts: a read-only mount is a symlink to its source (granted read-only in
// the sandbox policy; a host that cannot enforce records it in `notes`), a
// writable mount is a copy so writes never reach the source. `user` is not
// honoured: everything runs as the host process. An image is not used (a pack
// that declares one still runs on this host under `local`, `facts()` carry no
// image), and neither the network policy nor the resources are enforced, so
// `facts()` reports the network that actually ran (`public`) and `notes` say
// what the spec asked for.

import { cpSync, existsSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { scrubbedParentEnv, type SubprocessHandle, type SubprocessSpawnSpec } from '@oldbulb/samsara-kernel'
import { apply as applySandbox, DEFAULT_SYSTEM_ROOTS, type SandboxHost, type SandboxPolicy } from '@oldbulb/samsara-sandbox'
import type { Environment, EnvironmentFacts, EnvironmentProvider, EnvironmentSpec, ExecOptions, ExecResult } from './types.ts'

export const LOCAL_PROVIDER_VERSION = '0.1.0'
const DEFAULT_GRACE_MS = 1_000
const COLLECT_MAX_BYTES = 8 * 1024 * 1024
const PASSTHROUGH_ENV = ['PATH', 'LANG', 'LC_ALL'] as const

export type SpawnFn = (spec: SubprocessSpawnSpec) => SubprocessHandle

export interface LocalEnvironmentOptions {
  spawn: SpawnFn
  /** Where environments without a `workdir` are created; defaults to `<os tmpdir>/samsara-environments`. */
  baseDir?: string
  /** Grace between SIGTERM and SIGKILL when a timeout, an abort or dispose ends a child. */
  graceMs?: number
  /** The sandbox host the spawns are wrapped for; defaults to the detected one. */
  host?: SandboxHost
}

/** The host variables a child may see (E5): a locale and a way to find its interpreter, nothing else. */
function passthroughEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const k of PASSTHROUGH_ENV) {
    const v = process.env[k]
    if (v !== undefined) env[k] = v
  }
  return env
}

function readCollected(handle: SubprocessHandle, stream: 'stdout' | 'stderr'): string {
  return handle.collected[stream]?.readFrom(0).text ?? ''
}

/** Resolve a path the caller wrote relative to the environment's workdir; an absolute one is taken as is. */
function inside(workdir: string, path: string): string {
  return isAbsolute(path) ? path : resolve(workdir, path)
}

export class LocalEnvironment implements Environment {
  readonly provider = 'local'
  readonly notes: string[] = []
  private readonly children = new Set<SubprocessHandle>()
  private readonly policy: SandboxPolicy
  private disposed: Promise<void> | undefined

  constructor(
    readonly id: string,
    readonly workdir: string,
    private readonly spec: EnvironmentSpec,
    private readonly options: LocalEnvironmentOptions,
    /** Whether the directory is the provider's own (removed on dispose) or the caller's (left as it is). */
    private readonly owned: boolean,
    /** Called once the environment is gone: the provider stops counting the id as open. */
    private readonly released?: () => void,
  ) {
    const readOnlySources: string[] = []
    for (const mount of spec.mounts) {
      const to = inside(workdir, mount.to)
      mkdirSync(dirname(to), { recursive: true })
      if (mount.readOnly) {
        // A source mounted at its own path (the pack dir, so `in_environment` commands resolve as on the host) is already there.
        if (resolve(mount.from) === to) {
          this.notes.push(`mount ${mount.to}: read-only by sandbox policy only (its own path on this host)`)
        } else {
          symlinkSync(resolve(mount.from), to)
          this.notes.push(`mount ${mount.to}: read-only by sandbox policy only (a symlink to ${mount.from})`)
        }
        readOnlySources.push(resolve(mount.from))
      } else {
        cpSync(mount.from, to, { recursive: true })
      }
    }
    this.policy = { readOnly: [...DEFAULT_SYSTEM_ROOTS, ...readOnlySources], readWrite: [workdir, '/dev/null'], denied: [] }
    if (spec.image !== undefined) this.notes.push(`image ${spec.image.ref ?? spec.image.dockerfileDir} is not used locally; ran on this host`)
    if (spec.network !== 'public') this.notes.push(`network ${spec.network} is not enforced locally; ran with public`)
    if (spec.resources.cpus !== undefined || spec.resources.memoryMb !== undefined) this.notes.push('cpus/memoryMb are not enforced locally')
  }

  async exec(argv: string[], opts: ExecOptions): Promise<ExecResult> {
    if (this.disposed) throw new Error(`environments/local: ${this.id} is disposed`)
    if (opts.signal?.aborted) return { code: null, signal: 'SIGKILL', stdout: '', stderr: '' }
    const cwd = opts.cwd === undefined ? this.workdir : inside(this.workdir, opts.cwd)
    // E5: explicit environment — PATH/locale from the host, the spec's entries, the environment as HOME/TMPDIR, the call's
    // extras. The spawn seam merges this onto the scrubbed parent env, so every other ambient name is tombstoned out of the child.
    const env: NodeJS.ProcessEnv = { ...passthroughEnv(), ...this.spec.env, HOME: this.workdir, TMPDIR: this.workdir, ...opts.env }
    for (const name of Object.keys(scrubbedParentEnv())) if (!(name in env)) env[name] = undefined
    const spec: SubprocessSpawnSpec = {
      argv,
      cwd,
      stdio: { stdin: opts.stdin === undefined ? 'ignore' : { data: opts.stdin }, stdout: { maxBytes: COLLECT_MAX_BYTES }, stderr: { maxBytes: COLLECT_MAX_BYTES } },
      graceMs: this.options.graceMs ?? DEFAULT_GRACE_MS,
      env,
    }
    const handle = this.options.spawn(this.options.host === undefined ? applySandbox(spec, this.policy) : applySandbox(spec, this.policy, this.options.host))
    this.children.add(handle)
    const timer = setTimeout(() => handle.terminate(), opts.timeoutMs)
    const onAbort = (): void => handle.terminate()
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    let outcome
    try {
      outcome = await handle.done
    } finally {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      this.children.delete(handle)
    }
    const result: ExecResult = { code: outcome.exitCode, stdout: readCollected(handle, 'stdout'), stderr: readCollected(handle, 'stderr') }
    if (outcome.signal !== null) result.signal = outcome.signal
    return result
  }

  async put(localPath: string, remotePath: string): Promise<void> {
    const to = inside(this.workdir, remotePath)
    mkdirSync(dirname(to), { recursive: true })
    cpSync(localPath, to, { recursive: true })
  }

  async get(remotePath: string, localPath: string): Promise<void> {
    mkdirSync(dirname(resolve(localPath)), { recursive: true })
    cpSync(inside(this.workdir, remotePath), localPath, { recursive: true })
  }

  facts(): EnvironmentFacts {
    return { provider: this.provider, version: LOCAL_PROVIDER_VERSION, resources: { ...this.spec.resources }, network: 'public' }
  }

  dispose(): Promise<void> {
    this.disposed ??= (async () => {
      const live = [...this.children]
      for (const child of live) child.terminate()
      await Promise.allSettled(live.map((child) => child.done))
      if (this.owned) rmSync(this.workdir, { recursive: true, force: true })
      this.released?.()
    })()
    return this.disposed
  }
}

export class LocalEnvironmentProvider implements EnvironmentProvider {
  readonly name = 'local'
  readonly version = LOCAL_PROVIDER_VERSION
  readonly baseDir: string
  /** The attempt ids open on this provider: a second open on one is a collision; a directory with no open id is what a host killed before dispose left behind. */
  private readonly live = new Set<string>()

  constructor(private readonly options: LocalEnvironmentOptions) {
    this.baseDir = resolve(options.baseDir ?? join(tmpdir(), 'samsara-environments'))
  }

  async open(spec: EnvironmentSpec): Promise<Environment> {
    if (spec.attemptId === '' || spec.attemptId.includes(sep) || spec.attemptId.includes('/')) {
      throw new Error(`environments/local: attemptId must be a single path segment: ${JSON.stringify(spec.attemptId)}`)
    }
    const workdir = spec.workdir === undefined ? join(this.baseDir, spec.attemptId) : resolve(spec.workdir)
    if (spec.workdir === undefined) {
      if (this.live.has(spec.attemptId)) throw new Error(`environments/local: ${spec.attemptId} is already open`)
      // A stale directory holds nothing of value (an attempt starts with materialize) and a resume reuses the id: replace it.
      if (existsSync(workdir)) rmSync(workdir, { recursive: true, force: true })
    }
    mkdirSync(workdir, { recursive: true })
    this.live.add(spec.attemptId)
    // The real path: what a child's `pwd` prints and what a sandbox grant must name.
    return new LocalEnvironment(spec.attemptId, realpathSync(workdir), spec, this.options, spec.workdir === undefined, () => { this.live.delete(spec.attemptId) })
  }
}
