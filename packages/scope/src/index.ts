// @samsara/scope — `ctx.scopes`: open a challenger as a disposable child scope.
//
// open() runs the diff scan first (E8/S5) and creates nothing on rejection.
// Config rows are created through the loader's in-memory tree (E1): one
// `cordis:group` entry under the root group per scope, holding the patched
// rows; never through the file-backed include, so no profile file changes.
// dispose() removes that entry (EntryTree.remove) and waits for quiescence.

import { Context, Group, Service } from '@samsara/kernel'
import type { EntryOptions, Fiber, Loader } from '@samsara/kernel'
import { hashDir } from '@samsara/workdir'
import { scan } from './diffscan.ts'
import { envSha, harnessSha } from './sha.ts'
import type { Challenger, PatchOptions, Violation } from './types.ts'

export * from './types.ts'
export { scan, DEFAULT_FORBIDDEN_PATHS, FORBIDDEN_ROW_PATTERNS, leafPaths } from './diffscan.ts'
export { harnessSha, harnessShaOfLayers, envSha, envFacts, canonicalJson, sha256, ENV_ALLOWLIST, ENV_PREFIXES } from './sha.ts'
export { envLock, findRepoRoot, packRuntimeLocks, venvListing, claudeVersionOnPath, RUNTIME_LOCK_FILES } from './envlock.ts'
export type { EnvLock, EnvLockInputs, EnvLockOptions } from './envlock.ts'

declare module '@samsara/kernel' {
  interface Context {
    scopes: ScopeManager
  }
}

export type ScopeErrorCode = 'PATCH_REJECTED' | 'ROW_NOT_FOUND' | 'DUPLICATE_SCOPE' | 'NO_FIBER'

export class ScopeError extends Error {
  constructor(readonly code: ScopeErrorCode, message: string, readonly violations: Violation[] = []) {
    super(message)
    this.name = 'ScopeError'
  }
}

export interface Scope {
  scopeId: string
  challengerId: string
  /** The child context the loop runs in (the scope group's fiber context). */
  ctx: Context
  fiber: Fiber
  /** Skill snapshot dir for a skill patch, else undefined. */
  skillDir: string | undefined
  skillSha: string | undefined
  harnessSha: string
  envSha: string
  /** Loader entry ids this scope created (the group id, then its rows, flat in the root store); empty without a loader. */
  entryIds: string[]
  /** Patch rows not applied because no loader is mounted (fallback mode); empty otherwise. */
  unappliedRows: PatchOptions[]
  dispose(): Promise<void>
}

export const SCOPE_GROUP_PREFIX = 'samsara-scope-'

export class ScopeManager extends Service {
  private readonly open_ = new Map<string, Scope>()
  private seq = 0

  constructor(ctx: Context) {
    super(ctx, 'scopes')
    ctx.effect(() => async () => {
      await Promise.allSettled([...this.open_.values()].map(s => s.dispose()))
    }, 'scopes.disposeAll')
  }

  size(): number {
    return this.open_.size
  }

  get(scopeId: string): Scope | undefined {
    return this.open_.get(scopeId)
  }

  list(): Scope[] {
    return [...this.open_.values()]
  }

  /** The loader, when one is mounted on this context. */
  private loader(): Loader | undefined {
    return this.ctx.get('loader') as Loader | undefined
  }

  /** The champion's composed rows: every loader entry that is not a scope of ours. */
  championRows(): EntryOptions[] {
    const loader = this.loader()
    if (!loader) return []
    return [...loader.entries()]
      .filter(e => !e.id.includes(SCOPE_GROUP_PREFIX))
      .map(e => e.options)
  }

  async open(challenger: Challenger): Promise<Scope> {
    const { patch } = challenger
    const result = scan(patch, challenger.boundaries, challenger.taskIds, undefined, challenger.literals ?? [])
    if (!result.ok) {
      throw new ScopeError('PATCH_REJECTED', `patch rejected by the diff scan (${result.violations.length} violation(s))`, result.violations)
    }

    const scopeId = `${challenger.id}-${++this.seq}`
    const groupId = SCOPE_GROUP_PREFIX + scopeId
    const skillDir = patch.surface === 'skill' ? patch.skill_dir : undefined
    const skillSha = skillDir === undefined ? undefined : hashDir(skillDir)
    const rows = patch.surface === 'skill' ? [] : patch.rows
    const harness = harnessSha(this.championRows())
    const env = envSha()

    const loader = this.loader()
    let fiber: Fiber
    let entryIds: string[] = []
    let unappliedRows: PatchOptions[] = []
    let remove: () => Promise<void>

    if (loader) {
      const entries = rows.map(row => this.realize(loader, groupId, row)).flat()
      loader.builtins.group ??= Group
      const groupOptions = {
        id: groupId,
        name: 'cordis:group',
        group: true,
        config: entries,
        ...challenger.isolate ? { isolate: challenger.isolate } : {},
      } as Omit<EntryOptions, 'id'>
      await loader.create(groupOptions, null)
      const entry = loader.resolve(groupId)
      if (!entry.fiber) {
        await loader.remove(groupId).catch(() => {})
        throw new ScopeError('NO_FIBER', `scope group ${groupId} has no fiber after create`)
      }
      fiber = entry.fiber
      // A `cordis:group` shares its parent's tree store, so child ids are flat.
      entryIds = [groupId, ...entries.map(e => e.id)]
      remove = () => loader.remove(groupId)
    } else {
      // Fallback (no loader on this context, e.g. a bare test Context): mount a
      // bare child fiber so the scope still has a disposable context. Rows
      // cannot be applied — importing plugins by name is the loader's job.
      fiber = this.ctx.plugin({ name: groupId, apply() {} })
      await fiber.await()
      unappliedRows = rows
      remove = () => fiber.dispose()
    }

    let disposed: Promise<void> | undefined
    const scope: Scope = {
      scopeId,
      challengerId: challenger.id,
      ctx: fiber.ctx,
      fiber,
      skillDir,
      skillSha,
      harnessSha: harness,
      envSha: env,
      entryIds,
      unappliedRows,
      dispose: () => {
        disposed ??= (async () => {
          try {
            await remove()
          } finally {
            this.open_.delete(scopeId)
          }
        })()
        return disposed
      },
    }
    this.open_.set(scopeId, scope)
    return scope
  }

  /**
   * Turn one patch row into entries for the scope group. An `{id, config}` row
   * becomes a copy of the champion row with the config deep-merged (the scan has
   * already limited it to declared keys); its entry id is prefixed so it never
   * collides with the champion's entry in the shared store. Insert rows are
   * taken as they are.
   */
  private realize(loader: Loader, groupId: string, row: PatchOptions): EntryOptions[] {
    if (row.insert) return row.insert.map(e => ({ ...e }))
    const id = row.id!
    const target = [...loader.entries()].find(e => e.options.id === id && !e.id.includes(SCOPE_GROUP_PREFIX))
    if (!target) throw new ScopeError('ROW_NOT_FOUND', `champion row "${id}" not found in the loader tree`)
    const base = target.options
    const out: EntryOptions = { id: `${groupId}.${id}`, name: base.name }
    if (base.inject != null) out.inject = base.inject
    out.config = deepMerge(base.config, row.config)
    return [out]
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

export function deepMerge(base: unknown, over: unknown): unknown {
  if (over === undefined) return structuredClone(base)
  if (!isPlainObject(base) || !isPlainObject(over)) return structuredClone(over)
  const out: Record<string, unknown> = structuredClone(base)
  for (const [k, v] of Object.entries(over)) out[k] = deepMerge(out[k], v)
  return out
}

export default ScopeManager
