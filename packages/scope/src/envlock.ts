// Environment fingerprint from lock files (E3; adoptions item 3).
//
// `envLock()` folds everything that pins the runtime into one sha: the repo's
// pnpm-lock.yaml, every file the pack's `runtime.locks` globs name (the pack
// knows what pins its own runtimes — a requirements file, a venv's installed
// distributions, a go.sum, a Cargo.lock; the framework knows none of them),
// the Claude Code binary version when that loop is enabled, the node version,
// the dsh pin, the container image digest when present, and the allowlisted
// env var *names*. Never a value.

import { spawnSync } from 'node:child_process'
import { existsSync, globSync, readFileSync, statSync } from 'node:fs'
import { delimiter, dirname, join, resolve, sep } from 'node:path'
import { DSH_PIN } from '@oldbulb/samsara-kernel'
import { canonicalJson, envFacts, sha256 } from './sha.ts'

export interface EnvLockOptions {
  /** Directory holding `pnpm-lock.yaml`; see `findRepoRoot`. */
  repoRoot: string
  packDir: string
  /** Pack-relative globs of the files that pin the pack's runtimes (`runtime.locks` in pack.yaml); every match is hashed. */
  packLocks?: readonly string[]
  /** Loop names in play; `claude --version` is read only when 'claude-code' is among them. */
  loops: readonly string[]
  /** Defaults to `$SAMSARA_IMAGE_DIGEST`. */
  imageDigest?: string
  env?: NodeJS.ProcessEnv
  /** Injected for tests; otherwise read (once per process) from the `claude` binary on PATH. */
  claudeVersion?: string
}

export interface EnvLockInputs {
  /** sha256 of `<repoRoot>/pnpm-lock.yaml`, or null when absent. */
  pnpmLock: string | null
  /** pack-relative posix path → sha256 of every file the pack's lock globs match. */
  packRuntimeLocks: Record<string, string>
  node: string
  dshPin: string
  claudeVersion?: string
  imageDigest?: string
  envNames: string[]
}

export interface EnvLock {
  inputs: EnvLockInputs
  sha: string
}

export function envLock(opts: EnvLockOptions): EnvLock {
  const env = opts.env ?? process.env
  const facts = envFacts(env)
  const pnpmLockPath = join(opts.repoRoot, 'pnpm-lock.yaml')
  const pnpmLock = existsSync(pnpmLockPath) ? sha256(readFileSync(pnpmLockPath, 'utf8')) : null
  const imageDigest = opts.imageDigest ?? env['SAMSARA_IMAGE_DIGEST']
  const claudeVersion = opts.loops.includes('claude-code') ? (opts.claudeVersion ?? claudeVersionOnPath(env)) : undefined
  const inputs: EnvLockInputs = {
    pnpmLock,
    packRuntimeLocks: packRuntimeLocks(opts.packDir, opts.packLocks ?? []),
    node: facts.node,
    dshPin: DSH_PIN,
    ...(claudeVersion !== undefined ? { claudeVersion } : {}),
    ...(imageDigest ? { imageDigest } : {}),
    envNames: facts.envNames,
  }
  return { inputs, sha: sha256(canonicalJson(inputs)) }
}

/** Walk up from `start` to the nearest directory holding `pnpm-lock.yaml`; `start` itself when none. */
export function findRepoRoot(start: string): string {
  let dir = resolve(start)
  for (;;) {
    if (existsSync(join(dir, 'pnpm-lock.yaml'))) return dir
    const up = dirname(dir)
    if (up === dir) return resolve(start)
    dir = up
  }
}

/** Every file under `packDir` the pack-relative `locks` globs match, keyed by pack-relative posix path, sorted. */
export function packRuntimeLocks(packDir: string, locks: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {}
  if (locks.length === 0 || !existsSync(packDir)) return out
  for (const rel of globSync([...locks], { cwd: packDir })) {
    const path = join(packDir, rel)
    if (!statSync(path).isFile()) continue
    out[rel.split(sep).join('/')] = sha256(readFileSync(path, 'utf8'))
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

let claudeVersionCache: string | undefined | null = null

/** `claude --version` from the binary on PATH, read once per process; undefined when no binary. */
export function claudeVersionOnPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (claudeVersionCache !== null) return claudeVersionCache
  const bin = (env['PATH'] ?? '').split(delimiter).map(d => join(d, 'claude')).find(p => p && existsSync(p))
  if (!bin) return (claudeVersionCache = undefined)
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 10_000 })
  const line = r.status === 0 ? r.stdout.trim().split('\n')[0]?.trim() : undefined
  return (claudeVersionCache = line || undefined)
}
