// @oldbulb/samsara-scope types — a challenger is the champion plus one patch on one surface.

import type { EntryOptions, PatchOptions } from '@oldbulb/samsara-kernel'

export type { EntryOptions, PatchOptions }

/** The surfaces a v1 challenger may touch (architecture.md "Surfaces"). */
export type Surface = 'skill' | 'prompt' | 'memory' | 'tools' | 'runtime' | 'route' | 'context'

export const SURFACES: readonly Surface[] = ['skill', 'prompt', 'memory', 'tools', 'runtime', 'route', 'context']

/** A whole-directory skill snapshot; its identity is `hashDir(skill_dir)`. */
export interface SkillPatch {
  surface: 'skill'
  /** Content-addressed snapshot directory (already materialized by the proposer). */
  skill_dir: string
  /**
   * Pack-relative path the snapshot lands at, used to match the surface globs
   * (`<mount>/<file>`); defaults to '' so globs match the snapshot's own layout.
   */
  mount?: string
}

/** Cordis patch rows over the champion's composed entries. */
export interface ConfigPatch {
  surface: Exclude<Surface, 'skill'>
  /**
   * Either `{ id, config }` (deep-merged over the champion row with that id,
   * only on declared `config_keys`) or `{ insert: [entries] }` (ids must be
   * declared as whole rows). No other patch keys are admitted.
   */
  rows: PatchOptions[]
}

export type Patch = SkillPatch | ConfigPatch

/** One surface's machine-checkable boundary, as the pack declares it. */
export interface SurfaceBoundary {
  /** Pack-relative file globs a skill patch may touch. */
  globs?: string[]
  /** Dotted `<rowId>` or `<rowId>.<path>` a config patch may set. */
  config_keys?: string[]
}

export type SurfaceBoundaries = Record<string, SurfaceBoundary>

export type ViolationCode =
  | 'SURFACE_UNDECLARED'
  | 'FILE_OUT_OF_BOUNDARY'
  | 'FORBIDDEN_PATH'
  | 'CONFIG_KEY_UNDECLARED'
  | 'ROW_FORBIDDEN'
  | 'ROW_KEY_NOT_ALLOWED'
  | 'ROW_UNTARGETED'
  | 'TASK_LITERAL'
  | 'JS_EXPR'
  | 'SKILL_DIR_MISSING'

export interface Violation {
  code: ViolationCode
  /** File (skill) or row id / key path (config) the violation anchors to. */
  where: string
  detail: string
}

export interface ScanResult {
  ok: boolean
  violations: Violation[]
}

export interface Challenger {
  id: string
  patch: Patch
  boundaries: SurfaceBoundaries
  taskIds: string[]
  /** Extra task-specific literals (task file names, entity keys) the scan must not find. */
  literals?: string[]
  /** Pack-relative paths (globs) a skill patch may never touch, as the pack declares them; defaults to `DEFAULT_FORBIDDEN_PATHS`. */
  forbiddenPaths?: string[]
  /** Loader isolate labels put on the scope group (`{ serviceName: label | true }`). */
  isolate?: Record<string, string | true>
}
