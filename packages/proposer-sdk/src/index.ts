// @oldbulb/samsara-proposer-sdk — write a proposer in TypeScript against the
// directory-in / directory-out contract (examples/proposers/README.md): load
// the rendered view, build a Proposal, validate it, write it to the out
// directory. No dsh, no cordis; the only dependency is zod.
//
// The proposal schema mirrors the draft schema the host validates with
// (packages/proposers/src/types.ts, PROPOSAL_DRAFT_SCHEMA); a parity test keeps
// the two from drifting.

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'

export const VIEW_VERSION = 1

export const VIEW_FILE = 'view.json'
export const CHAMPION_FILE = 'champion.json'
export const CHAMPION_SKILL_DIR = 'champion-skill'
export const TASKS_FILE = 'tasks.jsonl'
export const CHAMPION_ATTEMPTS_FILE = 'champion-attempts.jsonl'
export const CHAMPION_SCORES_FILE = 'champion-scores.jsonl'
export const COMPARES_FILE = 'compares.jsonl'
export const ENVIRONMENT_FILE = 'environment.md'
export const PROPOSAL_SCHEMA_FILE = 'proposal.schema.json'
export const PROPOSAL_FILE = 'proposal.json'
export const SKILL_DIR = 'skill'

// --------------------------------------------------------------------- view

const viewHeaderSchema = z.object({
  view_version: z.number().int(),
  champion_id: z.string().min(1),
  metric: z.string().min(1),
  files: z.array(z.string()),
})

const championSchema = z.object({
  challenger_id: z.string().min(1),
  skill: z.string().min(1),
  metric: z.string().min(1),
})

export type ViewRecord = Record<string, unknown>

export interface View {
  /** Absolute path of the view directory. */
  dir: string
  viewVersion: number
  championId: string
  metric: string
  /** Names present in the directory (from view.json, or listed when it is absent). */
  files: string[]
  /** Absolute path of the champion's skill directory. */
  championSkillDir: string
  /** Held-in task rows; opaque beyond `task_id` / `entity_key` / `stratum`. */
  tasks: ViewRecord[]
  championAttempts: ViewRecord[]
  championScores: ViewRecord[]
  compares: ViewRecord[]
  /** `environment.md` when the host wrote one. */
  environment: string | undefined
  /** `proposal.schema.json` when the host wrote one. */
  proposalSchema: unknown | undefined
}

export class ViewError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ViewError'
  }
}

function readJsonl(path: string): ViewRecord[] {
  if (!existsSync(path)) return []
  const out: ViewRecord[] = []
  const lines = readFileSync(path, 'utf8').split('\n')
  lines.forEach((line, i) => {
    if (line.trim() === '') return
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch (error: unknown) {
      throw new ViewError(`${path}:${i + 1} is not JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ViewError(`${path}:${i + 1} is not an object`)
    out.push(value as ViewRecord)
  })
  return out
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error: unknown) {
    throw new ViewError(`${path} is not JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Load a rendered view directory; `view.json` is optional (inferred from `champion.json` and the files present). */
export function loadView(dir: string): View {
  const root = resolve(dir)
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new ViewError(`${root} is not a directory`)
  const championPath = join(root, CHAMPION_FILE)
  const champion = existsSync(championPath) ? championSchema.parse(readJson(championPath)) : undefined
  const headerPath = join(root, VIEW_FILE)
  let header: z.infer<typeof viewHeaderSchema>
  if (existsSync(headerPath)) {
    header = viewHeaderSchema.parse(readJson(headerPath))
    if (header.view_version !== VIEW_VERSION) throw new ViewError(`${headerPath}: view_version ${header.view_version} is not ${VIEW_VERSION}`)
  } else {
    if (champion === undefined) throw new ViewError(`${root} has neither ${VIEW_FILE} nor ${CHAMPION_FILE}`)
    header = { view_version: VIEW_VERSION, champion_id: champion.challenger_id, metric: champion.metric, files: readdirSync(root).sort() }
  }
  const skillRel = champion?.skill ?? CHAMPION_SKILL_DIR
  const championSkillDir = isAbsolute(skillRel) ? skillRel : resolve(root, skillRel)
  if (!existsSync(join(championSkillDir, 'SKILL.md'))) throw new ViewError(`${championSkillDir} is not a skill directory (no SKILL.md)`)
  const environmentPath = join(root, ENVIRONMENT_FILE)
  const schemaPath = join(root, PROPOSAL_SCHEMA_FILE)
  return {
    dir: root,
    viewVersion: header.view_version,
    championId: header.champion_id,
    metric: header.metric,
    files: header.files,
    championSkillDir,
    tasks: readJsonl(join(root, TASKS_FILE)),
    championAttempts: readJsonl(join(root, CHAMPION_ATTEMPTS_FILE)),
    championScores: readJsonl(join(root, CHAMPION_SCORES_FILE)),
    compares: readJsonl(join(root, COMPARES_FILE)),
    environment: existsSync(environmentPath) ? readFileSync(environmentPath, 'utf8') : undefined,
    proposalSchema: existsSync(schemaPath) ? readJson(schemaPath) : undefined,
  }
}

// ----------------------------------------------------------------- proposal

export const SURFACES = ['skill', 'prompt', 'memory', 'tools', 'runtime', 'route', 'context'] as const
export type Surface = (typeof SURFACES)[number]
export const DIRECTIONS = ['up', 'down'] as const

const taskIds = z.array(z.string().min(1))

export const predictionSchema = z.strictObject({
  metric: z.string().min(1),
  direction: z.enum(DIRECTIONS),
  magnitude: z.number().optional(),
  predicted_fixes: taskIds.optional(),
  at_risk: taskIds.optional(),
})

export const skillPatchSchema = z.strictObject({
  surface: z.literal('skill'),
  skill_dir: z.string().min(1),
})

export const rowsPatchSchema = z.strictObject({
  surface: z.enum(SURFACES.filter((s) => s !== 'skill') as [Exclude<Surface, 'skill'>, ...Exclude<Surface, 'skill'>[]]),
  rows: z.array(z.record(z.string(), z.unknown())).min(1),
})

export const patchSchema = z.union([skillPatchSchema, rowsPatchSchema])

/** What a proposer writes to `proposal.json`: the host stamps `proposer` and, when it knows it, `parent`. */
export const proposalSchema = z
  .strictObject({
    parent: z.string().min(1).optional(),
    surface: z.enum(SURFACES),
    patch: patchSchema,
    intent: z.string().min(1),
    prediction: predictionSchema,
  })
  .refine((p) => p.patch.surface === p.surface, { message: 'proposal surface does not match patch surface', path: ['patch', 'surface'] })

export type Prediction = z.infer<typeof predictionSchema>
export type ProposalPatch = z.infer<typeof patchSchema>
export type Proposal = z.infer<typeof proposalSchema>

export class ProposalError extends Error {
  constructor(message: string, readonly detail?: unknown) {
    super(message)
    this.name = 'ProposalError'
  }
}

export function validateProposal(value: unknown): Proposal {
  const result = proposalSchema.safeParse(value)
  if (!result.success) {
    const detail = result.error.issues.map((i) => `${i.path.length ? '/' + i.path.join('/') : '/'} ${i.message}`).join('; ')
    throw new ProposalError(`invalid proposal: ${detail}`, result.error.issues)
  }
  return result.data
}

export interface WriteProposalOptions {
  /** A skill directory to copy to `<outDir>/skill`; `patch.skill_dir` is rewritten to point at the copy. */
  skillDir?: string
}

/** Validate and write `proposal.json` into `outDir`, copying `opts.skillDir` to `<outDir>/skill` first. Returns the written path. */
export function writeProposal(outDir: string, proposal: Proposal, opts: WriteProposalOptions = {}): string {
  const out = resolve(outDir)
  mkdirSync(out, { recursive: true })
  let value: Proposal = proposal
  if (opts.skillDir !== undefined) {
    if (proposal.patch.surface !== 'skill') throw new ProposalError(`skillDir given for surface "${proposal.surface}"`)
    const src = resolve(opts.skillDir)
    if (!existsSync(join(src, 'SKILL.md'))) throw new ProposalError(`${src} is not a skill directory (no SKILL.md)`)
    const dest = join(out, SKILL_DIR)
    if (src !== dest) cpSync(src, dest, { recursive: true })
    value = { ...proposal, patch: { surface: 'skill', skill_dir: SKILL_DIR } }
  }
  const valid = validateProposal(value)
  const path = join(out, PROPOSAL_FILE)
  writeFileSync(path, JSON.stringify(valid, null, 2) + '\n')
  return path
}

// --------------------------------------------------------------------- argv

export interface ProposerArgs {
  view: string
  out: string
  /** Everything that was not `--view`/`--out`, in order. */
  rest: string[]
}

/** Parse the `--view <dir> --out <dir>` convention (also `--view=<dir>`); `argv` excludes the program name. */
export function parseArgs(argv: readonly string[]): ProposerArgs {
  let view: string | undefined
  let out: string | undefined
  const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    const eq = arg.indexOf('=')
    const key = eq === -1 ? arg : arg.slice(0, eq)
    if (key === '--view' || key === '--out') {
      const value = eq === -1 ? argv[++i] : arg.slice(eq + 1)
      if (value === undefined || value === '') throw new Error(`${key} needs a directory`)
      if (key === '--view') view = value
      else out = value
    } else {
      rest.push(arg)
    }
  }
  if (view === undefined) throw new Error('--view <dir> is required')
  if (out === undefined) throw new Error('--out <dir> is required')
  return { view: resolve(view), out: resolve(out), rest }
}
