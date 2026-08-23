// @samsara/workdir — seal one attempt's working directory.
//
// materialize() builds <baseDir>/<attemptId>/ from the pack's `materialize`
// command, a content-addressed skill snapshot, a read-only attempt token and a
// private TMPDIR (E6). Nothing here knows what the pack or the skill contain.

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from 'node:fs'
import { chmod, cp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { runCommand, type PackDefinition } from '@samsara/pack'

// ---------------------------------------------------------------- types

export interface MaterializeOptions {
  attemptId: string
  taskId: string
  challengerId: string
  pack: PackDefinition
  skill: { name: string; dir: string }
  baseDir: string
  /** Extra relative dirs (inside the workdir) that also receive the skill. */
  extraSkillDirs?: string[]
}

export interface AttemptToken {
  attemptId: string
  taskId: string
  challengerId: string
  issuedAt: string
}

/** relative posix path → sha256 hex of file bytes */
export type Baseline = Map<string, string>

export interface Workdir {
  path: string
  tmpdir: string
  skillSha: string
  tokenPath: string
  /** Snapshot of every file in the workdir right after sealing. */
  baseline: Baseline
  /** Input for @samsara/sandbox's policyFor: this workdir, its pack and the pack's runtime roots. */
  policyPaths: PolicyPaths
  dispose(): Promise<void>
}

export interface PolicyPaths {
  workdir: string
  packDir: string
  /** Existing directories under `<packDir>/runtime/` (venvs, node_modules). */
  runtimeDirs: string[]
}

export interface WorkdirDiff {
  added: string[]
  modified: string[]
  removed: string[]
}

export class WorkdirError extends Error {
  override readonly name = 'WorkdirError'
  constructor(message: string) {
    super(message)
  }
}

export const SKILLS_DIR = '.agents/skills'
export const TOKEN_PATH = '.task/token.json'
export const TMP_DIR = '.tmp'
export const RUNTIME_DIR = 'runtime'

// ---------------------------------------------------------------- hashing

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/')
}

/** Walk `root`, returning sorted relative posix paths of regular files. Symlinks are not followed. */
function listFiles(root: string, skip?: (rel: string) => boolean): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const abs = join(dir, e.name)
      const rel = toPosix(relative(root, abs))
      if (skip?.(rel)) continue
      if (e.isDirectory()) walk(abs)
      else if (e.isFile()) out.push(rel)
    }
  }
  walk(root)
  return out.sort()
}

/** Content hash of a directory: sha256 over sorted (relative path, bytes) pairs. */
export function hashDir(dir: string): string {
  const h = createHash('sha256')
  for (const rel of listFiles(dir)) {
    const bytes = readFileSync(join(dir, rel))
    h.update(rel).update('\0').update(String(bytes.length)).update('\0').update(bytes)
  }
  return h.digest('hex')
}

/** Snapshot every regular file under `path` (the attempt's private TMPDIR excluded). */
export function snapshot(path: string): Baseline {
  const base: Baseline = new Map()
  for (const rel of listFiles(path, (rel) => rel === TMP_DIR)) {
    base.set(rel, sha256(readFileSync(join(path, rel))))
  }
  return base
}

// ---------------------------------------------------------------- policy paths

/** The sandbox policy input for a workdir sealed from `pack`. */
export function policyPaths(path: string, pack: Pick<PackDefinition, 'dir'>): PolicyPaths {
  const packDir = resolve(pack.dir)
  const runtime = join(packDir, RUNTIME_DIR)
  let runtimeDirs: string[] = []
  try {
    runtimeDirs = readdirSync(runtime, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(runtime, e.name))
      .sort()
  } catch {
    // no runtime/ in this pack
  }
  return { workdir: resolve(path), packDir, runtimeDirs }
}

// ---------------------------------------------------------------- materialize

function assertSafeSegment(name: string, what: string): void {
  if (name === '' || name === '.' || name === '..' || /[\\/\0]/.test(name)) {
    throw new WorkdirError(`${what} is not a single safe path segment: ${JSON.stringify(name)}`)
  }
}

function assertInside(root: string, rel: string, what: string): string {
  const abs = resolve(root, rel)
  if (abs !== root && !abs.startsWith(root + sep)) throw new WorkdirError(`${what} escapes the workdir: ${rel}`)
  return abs
}

export async function materialize(opts: MaterializeOptions): Promise<Workdir> {
  assertSafeSegment(opts.attemptId, 'attemptId')
  assertSafeSegment(opts.skill.name, 'skill.name')
  if (!existsSync(opts.skill.dir) || !statSync(opts.skill.dir).isDirectory()) {
    throw new WorkdirError(`skill dir not found: ${opts.skill.dir}`)
  }

  const base = resolve(opts.baseDir)
  const path = join(base, opts.attemptId)
  if (existsSync(path)) throw new WorkdirError(`attempt dir already exists: ${path}`)
  await mkdir(base, { recursive: true })
  await mkdir(path)

  const dispose = async () => {
    await rm(path, { recursive: true, force: true })
  }

  try {
    // 1. pack files, via the pack's own command (always a subprocess)
    const rows = await runCommand(opts.pack, 'materialize', [{ task_id: opts.taskId, workdir: path }])
    const row = rows.find((r) => r['task_id'] === opts.taskId)
    if (!row) throw new WorkdirError(`materialize returned no line for task ${opts.taskId}`)
    if (row['ok'] !== true) {
      throw new WorkdirError(`materialize failed for task ${opts.taskId}${row['error'] ? `: ${String(row['error'])}` : ''}`)
    }

    // 2. skill snapshot(s)
    const targets = [SKILLS_DIR, ...(opts.extraSkillDirs ?? [])].map((d) =>
      assertInside(path, join(d, opts.skill.name), 'skill dir'),
    )
    for (const t of targets) {
      await mkdir(t, { recursive: true })
      await cp(opts.skill.dir, t, { recursive: true, dereference: true, errorOnExist: true, force: false })
    }
    const skillSha = hashDir(targets[0]!)

    // 3. attempt token, read-only
    const tokenPath = join(path, TOKEN_PATH)
    const token: AttemptToken = {
      attemptId: opts.attemptId,
      taskId: opts.taskId,
      challengerId: opts.challengerId,
      issuedAt: new Date().toISOString(),
    }
    await mkdir(join(path, '.task'), { recursive: true })
    await writeFile(tokenPath, JSON.stringify(token, null, 2) + '\n', { mode: 0o400, flag: 'wx' })
    await chmod(tokenPath, 0o400)

    // 4. private TMPDIR (E6)
    const tmpdir = join(path, TMP_DIR)
    await mkdir(tmpdir)

    return { path, tmpdir, skillSha, tokenPath, baseline: snapshot(path), policyPaths: policyPaths(path, opts.pack), dispose }
  } catch (e) {
    await dispose()
    throw e
  }
}

// ---------------------------------------------------------------- diff

/** Files changed under `path` relative to a `baseline` produced by materialize/snapshot. */
export function workdirDiff(path: string, baseline: Baseline): WorkdirDiff {
  const now = snapshot(resolve(path))
  const added: string[] = []
  const modified: string[] = []
  const removed: string[] = []
  for (const [rel, sha] of now) {
    const was = baseline.get(rel)
    if (was === undefined) added.push(rel)
    else if (was !== sha) modified.push(rel)
  }
  for (const rel of baseline.keys()) if (!now.has(rel)) removed.push(rel)
  return { added, modified, removed }
}

// ---------------------------------------------------------------- denyGuard

/**
 * Build a predicate over serialized tool arguments. Each pattern is tried as a
 * regex (case-sensitive); a pattern that is not a valid regex is matched as a
 * plain substring. Returns the reason to deny, or undefined to allow.
 */
export function denyGuard(patterns: string[]): (argsText: string) => string | undefined {
  const compiled = patterns.map((p) => {
    try {
      return { p, re: new RegExp(p) }
    } catch {
      return { p, re: undefined }
    }
  })
  return (argsText) => {
    for (const { p, re } of compiled) {
      if (re ? re.test(argsText) : argsText.includes(p)) return `denied by pattern ${JSON.stringify(p)}`
    }
    return undefined
  }
}
