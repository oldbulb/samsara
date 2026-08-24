// Champion state, pure. The champion is an alias to a set of content-addressed
// refs (`name:sha`); its on-disk form is the generated section of the host
// profile's patch layer (profiles/host/cordis.patch.yml). Everything here is
// text in / text out or data in / data out: no filesystem, no context.

import type { EntryOptions, PatchOptions } from '@oldbulb/samsara-kernel'
import { canonicalJson, sha256 } from '@oldbulb/samsara-ledger'
import { parse as parseYaml, stringify as stringifyYaml, type ScalarTag } from 'yaml'

/** `name:sha` of one kept surface object. */
export type ContentRef = string

/** One promotion the champion keeps: the ref, the rows it contributes, and who signed. */
export interface KeptPatch {
  challenger_id: string
  surface: string
  ref: ContentRef
  /** Loader patch rows merged into the profile layer (empty for a skill patch). */
  rows: PatchOptions[]
  /** Content-addressed skill snapshot directory, for a skill patch. */
  skill_ref?: string
  consent_id: string
  promoted_at: string
}

export interface ChampionState {
  /** Every kept ref, in promotion order. */
  rows: ContentRef[]
  /** The kept skill snapshot, if a skill patch is kept (the last one wins). */
  skill_ref?: string
  /** The loader patch rows the champion contributes to the profile layer, in promotion order. */
  profilePatchRows: PatchOptions[]
  /** The promotions the three views above are derived from. */
  kept: KeptPatch[]
}

export type ChampionStateErrorCode = 'BAD_SECTION' | 'BAD_ROWS' | 'RENDER_MISMATCH' | 'JS_EXPRESSION'

export class ChampionStateError extends Error {
  constructor(message: string, readonly code: ChampionStateErrorCode) {
    super(message)
    this.name = 'ChampionStateError'
  }
}

export const EMPTY_STATE: ChampionState = Object.freeze({ rows: [], profilePatchRows: [], kept: [] }) as ChampionState

/** Rebuild the derived views from the kept list. */
export function stateOf(kept: KeptPatch[]): ChampionState {
  const skill = [...kept].reverse().find((k) => k.skill_ref !== undefined)
  const state: ChampionState = {
    rows: kept.map((k) => k.ref),
    profilePatchRows: kept.flatMap((k) => k.rows),
    kept,
  }
  if (skill?.skill_ref !== undefined) state.skill_ref = skill.skill_ref
  return state
}

export function stateSha(state: ChampionState): string {
  return sha256(canonicalJson({ kept: state.kept }))
}

export function refOf(surface: string, sha: string): ContentRef {
  return `${surface}:${sha}`
}

// ----------------------------------------------------------------- yaml

// The loader dialect admits `!!js` expressions; the champion never writes
// one (E3) but a dump it verifies against may carry them from other layers.
// They are kept as their verbatim source text so rows stay comparable.
const jsExpression: ScalarTag = {
  tag: 'tag:yaml.org,2002:js',
  identify: () => false,
  resolve: (str) => str,
}

export function parseEntryList(text: string, what: string): unknown[] {
  const parsed: unknown = parseYaml(text, { customTags: [jsExpression] })
  if (parsed === null || parsed === undefined) return []
  if (!Array.isArray(parsed)) throw new ChampionStateError(`${what} must be a top-level YAML array`, 'BAD_ROWS')
  return parsed
}

function assertPatchRows(rows: unknown[], what: string): PatchOptions[] {
  for (const [i, row] of rows.entries()) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      throw new ChampionStateError(`${what} row ${i + 1} must be a mapping (a loader patch entry)`, 'BAD_ROWS')
    }
    assertPlainData(row, `${what} row ${i + 1}`)
  }
  return rows as PatchOptions[]
}

function assertPlainData(value: unknown, at: string): void {
  if (typeof value === 'function') throw new ChampionStateError(`${at} holds a function (E3: rows are plain data)`, 'JS_EXPRESSION')
  if (Array.isArray(value)) value.forEach((v, i) => assertPlainData(v, `${at}[${i}]`))
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) assertPlainData(v, `${at}.${k}`)
  }
}

// ---------------------------------------------------------- profile text

export const PROFILE_HEADER = `# samsara host profile patch. Rows above the champion marker are the deployment
# facts the host owns (edit by hand). The marked section below them is the
# champion state rendered by @oldbulb/samsara-champion and is rewritten on every
# promote/demote; the ledger is its source of truth.
`
export const CHAMPION_BEGIN = '# == samsara champion (generated; do not edit by hand)'
export const CHAMPION_END = '# == end samsara champion'
const STATE_PREFIX = '# samsara-champion-state: '
const SHA_PREFIX = '# samsara-champion-sha: '

export interface ParsedProfilePatch {
  /** The host-owned text, verbatim (header and champion section stripped). */
  baseText: string
  baseRows: PatchOptions[]
  /** The champion's rows as the loader will see them. */
  championRows: PatchOptions[]
  /** The state recorded in the section; EMPTY_STATE when there is no section. */
  state: ChampionState
  hasSection: boolean
}

/**
 * Render the profile patch layer: header, the host's base text byte-for-byte,
 * then the generated champion section (state as one canonical-JSON comment
 * line, its sha, and the kept rows). The result is one YAML array the loader
 * reads like any other patch file.
 */
export function renderProfilePatch(state: ChampionState, base: string | PatchOptions[]): string {
  const baseText = typeof base === 'string' ? stripHeader(base) : (base.length ? stringifyYaml(base) : '')
  const baseRows = assertPatchRows(parseEntryList(baseText, 'base'), 'base')
  // Keys sorted canonically so the rendered text is a function of the state, not of input key order.
  const rows = assertPatchRows(JSON.parse(canonicalJson(state.profilePatchRows)) as unknown[], 'champion')
  const body = rows.length ? stringifyYaml(rows) : ''
  if (body.includes('!!js')) throw new ChampionStateError('champion rows must not carry !!js expressions (E3)', 'JS_EXPRESSION')
  // A flow-empty base (`[]`, the dsh template) cannot be followed by block
  // items; it is dropped so the file stays one array.
  const baseOut = baseRows.length === 0 && /^\s*\[\]\s*$/m.test(baseText) ? baseText.replace(/^\s*\[\]\s*$/m, '') : baseText
  const section = [
    CHAMPION_BEGIN,
    `${STATE_PREFIX}${canonicalJson({ kept: state.kept })}`,
    `${SHA_PREFIX}${stateSha(state)}`,
    body.trimEnd(),
    CHAMPION_END,
  ].filter((line) => line.length > 0).join('\n') + '\n'
  const text = `${PROFILE_HEADER}${baseOut.length && !baseOut.endsWith('\n') ? baseOut + '\n' : baseOut}\n${section}`
  const check = parseEntryList(text, 'rendered profile patch')
  const want = canonicalJson([...baseRows, ...rows])
  if (canonicalJson(check) !== want) {
    throw new ChampionStateError('rendered profile patch does not parse back to base rows + champion rows', 'RENDER_MISMATCH')
  }
  return text
}

function stripHeader(text: string): string {
  return text.startsWith(PROFILE_HEADER) ? text.slice(PROFILE_HEADER.length) : text
}

/** Split a profile patch file into the host's text and the champion section; round-trips with renderProfilePatch. */
export function parseProfilePatch(text: string): ParsedProfilePatch {
  const body = stripHeader(text)
  const marker = `\n${CHAMPION_BEGIN}\n`
  const at = body.startsWith(`${CHAMPION_BEGIN}\n`) ? 0 : body.indexOf(marker)
  if (at < 0) {
    const baseRows = assertPatchRows(parseEntryList(body, 'profile patch'), 'profile patch')
    return { baseText: body, baseRows, championRows: [], state: EMPTY_STATE, hasSection: false }
  }
  const baseText = body.slice(0, at)
  const sectionText = body.slice(at === 0 ? 0 : at + 1)
  const endAt = sectionText.indexOf(`\n${CHAMPION_END}`)
  if (endAt < 0) throw new ChampionStateError('champion section has no end marker', 'BAD_SECTION')
  const lines = sectionText.slice(0, endAt).split('\n')
  const stateLine = lines.find((l) => l.startsWith(STATE_PREFIX))
  if (!stateLine) throw new ChampionStateError('champion section has no state line', 'BAD_SECTION')
  let kept: KeptPatch[]
  try {
    kept = (JSON.parse(stateLine.slice(STATE_PREFIX.length)) as { kept: KeptPatch[] }).kept
  } catch (error) {
    throw new ChampionStateError(`champion state line is not JSON: ${String(error)}`, 'BAD_SECTION')
  }
  if (!Array.isArray(kept)) throw new ChampionStateError('champion state has no kept list', 'BAD_SECTION')
  const state = stateOf(kept)
  const shaLine = lines.find((l) => l.startsWith(SHA_PREFIX))
  if (shaLine && shaLine.slice(SHA_PREFIX.length) !== stateSha(state)) {
    throw new ChampionStateError('champion state sha does not match its state line', 'BAD_SECTION')
  }
  const rowsText = lines.filter((l) => !l.startsWith(STATE_PREFIX) && !l.startsWith(SHA_PREFIX) && l !== CHAMPION_BEGIN).join('\n')
  const championRows = assertPatchRows(parseEntryList(rowsText, 'champion section'), 'champion section')
  const baseRows = assertPatchRows(parseEntryList(baseText, 'base'), 'base')
  return { baseText, baseRows, championRows, state, hasSection: true }
}

// ---------------------------------------------------------- hot apply (E7)

export interface HotApplyResult {
  ok: boolean
  /** sha over the expected values at every coordinate the kept rows touch. */
  expected_sha: string
  /** sha over what the dump holds at those same coordinates. */
  observed_sha: string
  mismatches: string[]
}

function flattenEntries(entries: unknown[], out: Map<string, EntryOptions>): void {
  for (const e of entries) {
    if (typeof e !== 'object' || e === null || Array.isArray(e)) continue
    const entry = e as EntryOptions
    if (typeof entry.id === 'string') out.set(entry.id, entry)
    if (entry.group && Array.isArray(entry.config)) flattenEntries(entry.config as unknown[], out)
  }
}

/**
 * Verify that a rendered config dump (`dsh --profile X --dump-config`, or
 * kernel `renderConfigDump` over the same layers) holds every kept row: each
 * inserted entry is present and equal, and each id-targeted patch's override
 * keys read back equal on the composed entry. The comparison is by sha over
 * the projected coordinates, so the result is one pair of hashes.
 */
export function verifyHotApply(expectedRows: PatchOptions[], renderedDumpText: string): HotApplyResult {
  const byId = new Map<string, EntryOptions>()
  flattenEntries(parseEntryList(renderedDumpText, 'config dump'), byId)
  const expected: unknown[] = []
  const observed: unknown[] = []
  const mismatches: string[] = []
  for (const [i, row] of expectedRows.entries()) {
    const { id, insert, name, ...overrides } = row
    if (Array.isArray(insert)) {
      for (const entry of insert as EntryOptions[]) {
        const found = typeof entry.id === 'string' ? byId.get(entry.id) : undefined
        expected.push(['insert', entry])
        observed.push(['insert', found ?? null])
        if (!found) mismatches.push(`row ${i + 1}: inserted entry ${String(entry.id)} is absent from the dump`)
        else if (canonicalJson(found) !== canonicalJson(entry)) mismatches.push(`row ${i + 1}: inserted entry ${String(entry.id)} differs in the dump`)
      }
      continue
    }
    const found = typeof id === 'string' ? byId.get(id) : undefined
    if (!found) {
      expected.push(['patch', id, overrides])
      observed.push(['patch', id, null])
      mismatches.push(`row ${i + 1}: entry ${String(id)} is absent from the dump`)
      continue
    }
    if (name !== undefined && found.name !== name) mismatches.push(`row ${i + 1}: entry ${id} has name ${String(found.name)}, patch names ${name}`)
    const seen: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(overrides)) {
      seen[key] = (found as unknown as Record<string, unknown>)[key] ?? null
      if (canonicalJson(seen[key]) !== canonicalJson(value)) mismatches.push(`row ${i + 1}: entry ${id}.${key} did not apply`)
    }
    expected.push(['patch', id, overrides])
    observed.push(['patch', id, seen])
  }
  const expected_sha = sha256(canonicalJson(expected))
  const observed_sha = sha256(canonicalJson(observed))
  return { ok: mismatches.length === 0 && expected_sha === observed_sha, expected_sha, observed_sha, mismatches }
}

// ------------------------------------------------------------ replay check

export interface ReplayResult {
  equal: boolean
  /** Kept on the ledger, absent from the file. */
  missingInFile: ContentRef[]
  /** In the file, not kept on the ledger. */
  extraInFile: ContentRef[]
}

/** Does the file's kept set equal what the ledger says is promoted and not reversed? Order-insensitive. */
export function replayCheck(ledgerKeptRefs: ContentRef[], fileRefs: ContentRef[]): ReplayResult {
  const ledger = new Set(ledgerKeptRefs)
  const file = new Set(fileRefs)
  const missingInFile = [...ledger].filter((r) => !file.has(r)).sort()
  const extraInFile = [...file].filter((r) => !ledger.has(r)).sort()
  return { equal: missingInFile.length === 0 && extraInFile.length === 0, missingInFile, extraInFile }
}
