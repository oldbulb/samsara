// @samsara/sandbox — the filesystem policy an attempt's or a proposer's
// subprocess runs under, and the wrapper that enforces it.
//
// Landlock rulesets are allow-lists: everything not granted is denied and a
// grant cannot be carved. `policyFor` therefore composes the grants from the
// parts the framework knows (workdir, pack skill/ and loader/, runtimes, the
// system roots) and keeps a `denied` list as the invariant the composition
// must satisfy — no denied path may lie under (or above) an allowed root.
// `apply` wraps a SubprocessSpawnSpec with the launcher on Linux and leaves it
// unchanged where nothing can enforce; the mode it chose is what the loop
// records in HarnessFacts.sandbox so it lands in facts_sha.
//
// Pure: policyFor and apply read nothing from the filesystem or the
// environment; `detectHost` is the one impure entry and is injectable.

import { existsSync } from 'node:fs'
import { isAbsolute, join, normalize, sep } from 'node:path'
import {
  landlockGrantArgs,
  landlockLauncherPath,
  landlockProbe,
  type LandlockEnforcement,
  type SubprocessSpawnSpec,
} from '@samsara/kernel'

// ---------------------------------------------------------------- types

export interface PolicyInput {
  /** The sealed attempt (or proposer work) directory: the only writable root. */
  workdir: string
  /** The pack's root; only its `skill/` and `loader/` are granted, read-only. */
  packDir: string
  /** Runtime roots the subprocess executes from (pack venvs, node_modules, a CLI install); read-only. */
  runtimeDirs?: readonly string[]
  /** The host-side fixture cache entry for this task; read-only. Must not live under the pack's `fixtures/`. */
  fixturePath?: string
  /** Further read-only roots (the proposer's rendered view). */
  readOnly?: readonly string[]
  /** Roots the OS runtime needs (interpreters, shared libraries, /proc); defaults to {@link DEFAULT_SYSTEM_ROOTS}. */
  systemRoots?: readonly string[]
  /** The ledger directory; recorded as denied (it is outside every grant by construction). */
  ledgerDir?: string
  /** The invoking user's home; its `.config`, `.ssh`, `.claude` and dsh credential file are recorded as denied. */
  homeDir?: string
  /** Further paths that must stay unreachable (key files, credential stores). */
  denied?: readonly string[]
}

export interface SandboxPolicy {
  /** Roots granted read + execute beneath. */
  readOnly: string[]
  /** Roots granted full access beneath. */
  readWrite: string[]
  /** Paths that must be unreachable; verified against the grants, never passed to the launcher. */
  denied: string[]
}

export type SandboxMode = 'landlock' | 'none'

export interface SandboxHost {
  platform: NodeJS.Platform
  /** The launcher's verdict on this host; `unusable` off Linux. */
  enforcement: LandlockEnforcement
  /** Absolute launcher path (meaningful only when enforcement is not `unusable`). */
  launcher: string
  /** A grant on a missing root makes the launcher exit 125, so grants are pruned to existing roots. */
  exists: (path: string) => boolean
}

export class SandboxError extends Error {
  override readonly name = 'SandboxError'
  constructor(message: string) {
    super(message)
  }
}

/** What an interpreter and its shared libraries need; read-only. `/dev` is read-only with `/dev/null` writable. */
export const DEFAULT_SYSTEM_ROOTS: readonly string[] = ['/usr', '/lib', '/lib32', '/lib64', '/bin', '/sbin', '/etc', '/opt', '/proc', '/dev']

/** Pack subpaths the subprocess may read. */
export const PACK_READ_ONLY: readonly string[] = ['skill', 'loader']
/** Pack subpaths that must stay unreachable: the task sets, the truth, the fixtures' answers, the judge. */
export const PACK_DENIED: readonly string[] = ['tasks', 'data', 'fixtures', join('bin', 'truth'), join('bin', 'score')]
/** Home subpaths that must stay unreachable. */
export const HOME_DENIED: readonly string[] = ['.config', '.ssh', '.claude', '.credentials.yaml']

// ---------------------------------------------------------------- paths

function absolute(path: string, what: string): string {
  if (!isAbsolute(path)) throw new SandboxError(`${what} must be absolute: ${JSON.stringify(path)}`)
  const n = normalize(path)
  return n.length > 1 && n.endsWith(sep) ? n.slice(0, -1) : n
}

function under(path: string, root: string): boolean {
  return path === root || (root === sep ? true : path.startsWith(root + sep))
}

function unique(paths: readonly string[]): string[] {
  return [...new Set(paths)]
}

// ---------------------------------------------------------------- policyFor

/**
 * Compose the grants for one subprocess and verify the denied set against them.
 * Throws {@link SandboxError} when a denied path lies under an allowed root
 * (it would be readable) or an allowed root lies under a denied path (a hole
 * an allow-list cannot express) — e.g. a `fixturePath` inside the pack's
 * `fixtures/`, or a home directory passed as a runtime root.
 */
export function policyFor(input: PolicyInput): SandboxPolicy {
  const workdir = absolute(input.workdir, 'workdir')
  const packDir = absolute(input.packDir, 'packDir')
  const readOnly = unique([
    ...(input.systemRoots ?? DEFAULT_SYSTEM_ROOTS).map((p) => absolute(p, 'systemRoots[]')),
    ...PACK_READ_ONLY.map((rel) => join(packDir, rel)),
    ...(input.runtimeDirs ?? []).map((p) => absolute(p, 'runtimeDirs[]')),
    ...(input.fixturePath !== undefined ? [absolute(input.fixturePath, 'fixturePath')] : []),
    ...(input.readOnly ?? []).map((p) => absolute(p, 'readOnly[]')),
  ])
  const readWrite = unique([workdir, '/dev/null'])
  const denied = unique([
    ...PACK_DENIED.map((rel) => join(packDir, rel)),
    ...(input.ledgerDir !== undefined ? [absolute(input.ledgerDir, 'ledgerDir')] : []),
    ...(input.homeDir !== undefined ? HOME_DENIED.map((rel) => join(absolute(input.homeDir!, 'homeDir'), rel)) : []),
    ...(input.denied ?? []).map((p) => absolute(p, 'denied[]')),
  ])
  const policy: SandboxPolicy = { readOnly, readWrite, denied }
  assertPolicy(policy)
  return policy
}

/** The composition invariant: no denied path under an allowed root, no allowed root under a denied path. */
export function assertPolicy(policy: SandboxPolicy): void {
  const allowed = [...policy.readOnly, ...policy.readWrite]
  for (const d of policy.denied) {
    for (const a of allowed) {
      if (under(d, a)) throw new SandboxError(`denied path ${d} is reachable through the grant on ${a}`)
      if (under(a, d)) throw new SandboxError(`grant ${a} lies inside denied path ${d}; an allow-list cannot carve it out`)
    }
  }
}

// ---------------------------------------------------------------- host

let detected: SandboxHost | undefined

/**
 * Probe this host once: on Linux the launcher's functional probe decides, on
 * every other platform nothing can enforce. Cached for the process lifetime.
 */
export function detectHost(): SandboxHost {
  detected ??= (() => {
    if (process.platform !== 'linux') {
      return { platform: process.platform, enforcement: 'unusable', launcher: '', exists: existsSync }
    }
    const launcher = landlockLauncherPath()
    return { platform: 'linux', enforcement: landlockProbe(launcher), launcher, exists: existsSync }
  })()
  return detected
}

/** The enforcement mode a host yields; the value a loop records in HarnessFacts.sandbox. */
export function sandboxModeOf(host: SandboxHost): SandboxMode {
  return host.platform === 'linux' && host.enforcement !== 'unusable' ? 'landlock' : 'none'
}

// ---------------------------------------------------------------- apply

/**
 * Wrap a spawn spec so the child (and everything it spawns) runs under
 * `policy`. On a host that can enforce, argv becomes
 * `[launcher, --ro …, --rw …, --, …argv]` with cwd, env, stdio, grace and
 * signal untouched; grants on roots the host says do not exist are dropped
 * (the launcher refuses to start on an unopenable root). On a host that
 * cannot enforce the spec is returned as is. Fail-closed: a host that can
 * enforce but receives no policy throws rather than running unconfined.
 */
export function apply(spec: SubprocessSpawnSpec, policy: SandboxPolicy | undefined, host: SandboxHost = detectHost()): SubprocessSpawnSpec {
  if (sandboxModeOf(host) === 'none') return spec
  if (policy === undefined) throw new SandboxError('this host enforces landlock but the spawn carries no sandbox policy; refusing to run unconfined')
  assertPolicy(policy)
  const workdir = policy.readWrite[0]
  if (workdir === undefined || !host.exists(workdir)) throw new SandboxError(`the writable root ${workdir} does not exist`)
  const readOnly = policy.readOnly.filter(host.exists)
  const readWrite = policy.readWrite.filter(host.exists)
  return {
    ...spec,
    argv: [host.launcher, ...landlockGrantArgs({ readOnly, readWrite }), '--', ...spec.argv],
  }
}
