// Environment fingerprint from lock files (E3; adoptions item 3).
//
// `envLock()` folds everything that pins the runtime into one sha: the repo's
// pnpm-lock.yaml, every pack runtime lock file, the installed distributions of
// each pack venv (names + versions only), the Claude Code binary version when
// that loop is enabled, the node version, the dsh pin, the container image
// digest when present, and the allowlisted env var *names*. Never a value.

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { delimiter, dirname, join, relative, resolve, sep } from 'node:path'
import { DSH_PIN } from '@samsara/kernel'
import { canonicalJson, envFacts, sha256 } from './sha.ts'

export interface EnvLockOptions {
  /** Directory holding `pnpm-lock.yaml`; see `findRepoRoot`. */
  repoRoot: string
  packDir: string
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
  /** pack-relative path → sha256 of the lock file, or of the venv's sorted `name==version` listing. */
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

export const RUNTIME_LOCK_FILES: readonly RegExp[] = [
  /^requirements[^/]*\.txt$/,
  /^uv\.lock$/,
  /^package-lock\.json$/,
  /^pnpm-lock\.yaml$/,
  /^\.python-version$/,
]

const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.cache', 'site-packages'])

export function envLock(opts: EnvLockOptions): EnvLock {
  const env = opts.env ?? process.env
  const facts = envFacts(env)
  const pnpmLockPath = join(opts.repoRoot, 'pnpm-lock.yaml')
  const pnpmLock = existsSync(pnpmLockPath) ? sha256(readFileSync(pnpmLockPath, 'utf8')) : null
  const imageDigest = opts.imageDigest ?? env['SAMSARA_IMAGE_DIGEST']
  const claudeVersion = opts.loops.includes('claude-code') ? (opts.claudeVersion ?? claudeVersionOnPath(env)) : undefined
  const inputs: EnvLockInputs = {
    pnpmLock,
    packRuntimeLocks: packRuntimeLocks(opts.packDir),
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

/** Lock files and venv listings under `<packDir>/runtime/**`, keyed by pack-relative posix path, sorted. */
export function packRuntimeLocks(packDir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const runtime = join(packDir, 'runtime')
  if (!existsSync(runtime)) return out
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const path = join(dir, entry.name)
      const key = relative(packDir, path).split(sep).join('/')
      if (entry.isDirectory()) {
        if (existsSync(join(path, 'pyvenv.cfg'))) {
          out[key] = sha256(venvListing(path).join('\n'))
        } else if (!SKIP_DIRS.has(entry.name)) {
          walk(path)
        }
      } else if (entry.isFile() && RUNTIME_LOCK_FILES.some(re => re.test(entry.name))) {
        out[key] = sha256(readFileSync(path, 'utf8'))
      }
    }
  }
  walk(runtime)
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

// `name==version` for every `<venv>/lib/pythonX.Y/site-packages/<dist>.dist-info/METADATA`, sorted.
export function venvListing(venv: string): string[] {
  const lib = join(venv, 'lib')
  if (!existsSync(lib)) return []
  const rows: string[] = []
  for (const py of readdirSync(lib).filter(n => n.startsWith('python'))) {
    const site = join(lib, py, 'site-packages')
    if (!existsSync(site) || !statSync(site).isDirectory()) continue
    for (const d of readdirSync(site)) {
      if (!d.endsWith('.dist-info')) continue
      const meta = join(site, d, 'METADATA')
      if (!existsSync(meta)) continue
      const text = readFileSync(meta, 'utf8')
      const name = /^Name:\s*(.+)$/m.exec(text)?.[1]?.trim()
      const version = /^Version:\s*(.+)$/m.exec(text)?.[1]?.trim()
      if (name && version) rows.push(`${name}==${version}`)
    }
  }
  return rows.sort()
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
