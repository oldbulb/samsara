// Diff scan — E8/S5: reject, before any evaluation spend, a patch that crosses
// its surface boundary, touches the judge pipeline, or carries task-specific
// knowledge. Pure: reads the skill snapshot, never the pack or the loader.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, matchesGlob, posix } from 'node:path'
import type { EntryOptions, Patch, PatchOptions, ScanResult, SurfaceBoundaries, Violation } from './types.ts'

export const DEFAULT_FORBIDDEN_PATHS: readonly string[] = [
  'bin/**',
  'tasks/**',
  'fixtures/**',
  'contract.schema.json',
  'pack.yaml',
]

/** Row ids (and inserted plugin names) no challenger may target: the fixed points and their storage. */
export const FORBIDDEN_ROW_PATTERNS: readonly string[] = [
  '*truth*',
  '*score*',
  'ledger',
  'gate*',
  'signoff',
  'book',
  'storage*',
]

// The YAML tag spelled in two halves so a repo-wide grep for the tag finds only rows, never this scanner.
const JS_EXPR_MARKERS = ['!!' + 'js', '__jsExpr']

const ROW_KEYS_OVERRIDE = new Set(['id', 'config'])
const ENTRY_KEYS_INSERT = new Set(['id', 'name', 'config', 'inject', 'group'])

export function scan(
  patch: Patch,
  boundaries: SurfaceBoundaries,
  taskIds: string[],
  forbiddenPaths: readonly string[] = DEFAULT_FORBIDDEN_PATHS,
  literals: readonly string[] = [],
): ScanResult {
  const violations: Violation[] = []
  const boundary = boundaries[patch.surface]
  if (!boundary) {
    violations.push({ code: 'SURFACE_UNDECLARED', where: patch.surface, detail: `the pack declares no boundary for surface "${patch.surface}"` })
    return { ok: false, violations }
  }
  const needles = [...new Set([...taskIds, ...literals].filter(s => s.length > 0))]

  if (patch.surface === 'skill') {
    scanSkill(patch.skill_dir, patch.mount ?? '', boundary.globs ?? [], forbiddenPaths, needles, violations)
  } else {
    scanRows(patch.rows, boundary.config_keys ?? [], needles, violations)
  }
  return { ok: violations.length === 0, violations }
}

// ---------------------------------------------------------------- skill

function scanSkill(
  dir: string,
  mount: string,
  globs: string[],
  forbiddenPaths: readonly string[],
  needles: string[],
  out: Violation[],
): void {
  let files: string[]
  try {
    files = listFiles(dir)
  } catch (error) {
    out.push({ code: 'SKILL_DIR_MISSING', where: dir, detail: String(error) })
    return
  }
  for (const rel of files) {
    const packRel = mount ? posix.join(mount, rel) : rel
    if (forbiddenPaths.some(g => matchesGlob(packRel, g))) {
      out.push({ code: 'FORBIDDEN_PATH', where: packRel, detail: 'matches a forbidden path' })
    }
    if (!globs.some(g => matchesGlob(packRel, g))) {
      out.push({ code: 'FILE_OUT_OF_BOUNDARY', where: packRel, detail: `outside the surface globs [${globs.join(', ')}]` })
    }
    scanText(readFileSync(join(dir, rel), 'utf8'), packRel, needles, out)
  }
}

function listFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (rel: string) => {
    for (const d of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const r = rel ? posix.join(rel, d.name) : d.name
      if (d.isDirectory()) walk(r)
      else if (d.isFile() || d.isSymbolicLink()) {
        if (statSync(join(dir, r)).isFile()) out.push(r)
      }
    }
  }
  walk('')
  return out.sort()
}

// ---------------------------------------------------------------- config rows

function scanRows(rows: PatchOptions[], configKeys: string[], needles: string[], out: Violation[]): void {
  rows.forEach((row, i) => {
    const where = row.id ? `rows[${i}]#${row.id}` : `rows[${i}]`
    if (row.insert) {
      for (const key of Object.keys(row)) {
        if (key !== 'insert') out.push({ code: 'ROW_KEY_NOT_ALLOWED', where, detail: `"${key}" is not allowed beside "insert"` })
      }
      row.insert.forEach((entry, j) => scanInsert(entry, `${where}.insert[${j}]`, configKeys, out))
    } else {
      if (!row.id) {
        out.push({ code: 'ROW_UNTARGETED', where, detail: 'a row must carry an id or an insert list' })
        return
      }
      for (const key of Object.keys(row)) {
        if (!ROW_KEYS_OVERRIDE.has(key)) out.push({ code: 'ROW_KEY_NOT_ALLOWED', where, detail: `only id and config may be set on a champion row, got "${key}"` })
      }
      checkRowId(row.id, where, out)
      if (row.config === undefined) return
      for (const path of leafPaths(row.config)) {
        const dotted = `${row.id}.${path}`
        if (!declared(configKeys, row.id, path)) {
          out.push({ code: 'CONFIG_KEY_UNDECLARED', where: dotted, detail: 'not in the surface config_keys' })
        }
      }
    }
  })
  scanText(JSON.stringify(rows), 'rows', needles, out)
}

function scanInsert(entry: EntryOptions, where: string, configKeys: string[], out: Violation[]): void {
  for (const key of Object.keys(entry)) {
    if (!ENTRY_KEYS_INSERT.has(key)) out.push({ code: 'ROW_KEY_NOT_ALLOWED', where, detail: `"${key}" is not allowed on an inserted entry` })
  }
  if (!entry.id) {
    out.push({ code: 'ROW_UNTARGETED', where, detail: 'an inserted entry must carry a stable id' })
    return
  }
  checkRowId(entry.id, where, out)
  if (typeof entry.name === 'string') checkRowId(entry.name, where, out)
  if (!configKeys.includes(entry.id)) {
    out.push({ code: 'CONFIG_KEY_UNDECLARED', where: entry.id, detail: 'inserting a row requires its id declared as a whole row in config_keys' })
  }
}

function checkRowId(id: string, where: string, out: Violation[]): void {
  const hit = FORBIDDEN_ROW_PATTERNS.find(p => matchesGlob(id, p))
  if (hit) out.push({ code: 'ROW_FORBIDDEN', where, detail: `"${id}" matches forbidden row pattern ${hit}` })
}

/** `rowId` alone covers the whole row; `rowId.a.b` covers `a.b` and everything under it. */
function declared(configKeys: string[], rowId: string, path: string): boolean {
  return configKeys.some(k => {
    if (k === rowId) return true
    if (!k.startsWith(rowId + '.')) return false
    const sub = k.slice(rowId.length + 1)
    return path === sub || path.startsWith(sub + '.')
  })
}

/** Dotted paths of every leaf in a config object; an empty/non-object config is one leaf ''. */
export function leafPaths(config: unknown, prefix = ''): string[] {
  if (config && typeof config === 'object' && !Array.isArray(config)) {
    const keys = Object.keys(config as Record<string, unknown>)
    if (keys.length === 0) return [prefix]
    return keys.flatMap(k => leafPaths((config as Record<string, unknown>)[k], prefix ? `${prefix}.${k}` : k))
  }
  return [prefix]
}

// ---------------------------------------------------------------- text

function scanText(text: string, where: string, needles: string[], out: Violation[]): void {
  for (const marker of JS_EXPR_MARKERS) {
    if (text.includes(marker)) out.push({ code: 'JS_EXPR', where, detail: `contains ${marker} (E3)` })
  }
  for (const needle of needles) {
    if (text.includes(needle)) out.push({ code: 'TASK_LITERAL', where, detail: `contains task literal ${JSON.stringify(needle)} (S5)` })
  }
}
