// The Proposal contract (docs/design/proposers.md) as types, a JSON schema the
// host validates drafts against, and the adapter interface every proposer
// implements. Pure: no process, no ledger.

import { createHash } from 'node:crypto'
import { Ajv2020, type ErrorObject } from 'ajv/dist/2020.js'
import type { PatchOptions } from '@oldbulb/samsara-kernel'

export const SURFACES = ['skill', 'prompt', 'memory', 'tools', 'runtime', 'route', 'context'] as const
export type Surface = (typeof SURFACES)[number]

export type ProposalPatch =
  | { surface: 'skill'; skill_dir: string }
  | { surface: Exclude<Surface, 'skill'>; rows: PatchOptions[] }

export interface Prediction {
  metric: string
  direction: 'up' | 'down'
  magnitude?: number
  predicted_fixes?: string[]
  at_risk?: string[]
}

export interface ProposerIdentity {
  name: string
  version: string
  config_sha: string
}

export interface Proposal {
  parent: string
  surface: Surface
  patch: ProposalPatch
  intent: string
  prediction: Prediction
  proposer: ProposerIdentity
}

/** What an external proposer writes (`proposal.json`): a Proposal minus the fields the adapter stamps. */
export type ProposalDraft = Omit<Proposal, 'parent' | 'proposer'> & { parent?: string }

export interface ProposeInput {
  /** Directory of rendered files from `ledger.read(view, 'proposer')`; adapters read it and nothing else. */
  viewDir: string
  /** Scratch directory the adapter (and the process it runs) may write to; `skill_dir` resolves against it. */
  workDir: string
  signal: AbortSignal
  /** Challenger id the proposal builds on; falls back to the draft's own `parent`. */
  parent?: string
  /** Filesystem policy for the proposer process (composed by @oldbulb/samsara-sandbox; E9); absent = unconfined. */
  sandbox?: { readOnly: string[]; readWrite: string[]; denied: string[] }
}

export interface ProposerAdapter {
  readonly name: string
  readonly version: string
  readonly configSha: string
  propose(input: ProposeInput): Promise<Proposal>
}

// ------------------------------------------------------------------- schema

const taskIds = { type: 'array', items: { type: 'string', minLength: 1 } }

const prediction = {
  type: 'object',
  required: ['metric', 'direction'],
  additionalProperties: false,
  properties: {
    metric: { type: 'string', minLength: 1 },
    direction: { enum: ['up', 'down'] },
    magnitude: { type: 'number' },
    predicted_fixes: taskIds,
    at_risk: taskIds,
  },
}

const patch = {
  oneOf: [
    {
      type: 'object',
      required: ['surface', 'skill_dir'],
      additionalProperties: false,
      properties: { surface: { const: 'skill' }, skill_dir: { type: 'string', minLength: 1 } },
    },
    {
      type: 'object',
      required: ['surface', 'rows'],
      additionalProperties: false,
      properties: {
        surface: { enum: SURFACES.filter((s) => s !== 'skill') },
        rows: { type: 'array', minItems: 1, items: { type: 'object' } },
      },
    },
  ],
}

const proposer = {
  type: 'object',
  required: ['name', 'version', 'config_sha'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1 },
    version: { type: 'string', minLength: 1 },
    config_sha: { type: 'string', pattern: '^[0-9a-f]{64}$' },
  },
}

const draftProperties = {
  parent: { type: 'string', minLength: 1 },
  surface: { enum: [...SURFACES] },
  patch,
  intent: { type: 'string', minLength: 1 },
  prediction,
}

/** JSON schema (2020-12) for what a proposer writes; `parent` optional, no `proposer`. */
export const PROPOSAL_DRAFT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['surface', 'patch', 'intent', 'prediction'],
  additionalProperties: false,
  properties: draftProperties,
} as const

/** JSON schema (2020-12) for a complete Proposal. */
export const PROPOSAL_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['parent', 'surface', 'patch', 'intent', 'prediction', 'proposer'],
  additionalProperties: false,
  properties: { ...draftProperties, proposer },
} as const

export class ProposalError extends Error {
  constructor(message: string, readonly code: 'SCHEMA' | 'SURFACE_MISMATCH' | 'TASK_ID', readonly detail?: unknown) {
    super(message)
    this.name = 'ProposalError'
  }
}

const ajv = new Ajv2020({ allErrors: true, strict: false })
const validateDraftFn = ajv.compile(PROPOSAL_DRAFT_SCHEMA)
const validateFullFn = ajv.compile(PROPOSAL_SCHEMA)

function describe(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`.trim()).join('; ')
}

function checkSurface(value: { surface: Surface; patch: ProposalPatch }): void {
  if (value.patch.surface !== value.surface) {
    throw new ProposalError(`proposal surface "${value.surface}" does not match patch surface "${value.patch.surface}"`, 'SURFACE_MISMATCH')
  }
}

export function validateDraft(value: unknown): ProposalDraft {
  if (!validateDraftFn(value)) throw new ProposalError(`invalid proposal draft: ${describe(validateDraftFn.errors)}`, 'SCHEMA', validateDraftFn.errors)
  const draft = value as ProposalDraft
  checkSurface(draft)
  return draft
}

export function validateProposal(value: unknown): Proposal {
  if (!validateFullFn(value)) throw new ProposalError(`invalid proposal: ${describe(validateFullFn.errors)}`, 'SCHEMA', validateFullFn.errors)
  const proposal = value as Proposal
  checkSurface(proposal)
  return proposal
}

/** Every task id the proposal names (prediction lists). The host checks these against the held-in set. */
export function taskIdsOf(p: Pick<Proposal, 'prediction'>): string[] {
  return [...(p.prediction.predicted_fixes ?? []), ...(p.prediction.at_risk ?? [])]
}

/** Reject a proposal naming a task id outside `allowed` (the held-in ids of the view). */
export function assertTaskIdsWithin(p: Pick<Proposal, 'prediction'>, allowed: Iterable<string>): void {
  const ok = new Set(allowed)
  const bad = taskIdsOf(p).filter((id) => !ok.has(id))
  if (bad.length > 0) throw new ProposalError(`proposal names task ids outside the held-in set: ${bad.join(', ')}`, 'TASK_ID', bad)
}

// ------------------------------------------------------------------ hashing

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** JSON with object keys sorted recursively and `undefined` dropped; arrays keep their order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[k]
      if (v !== undefined) out[k] = sortKeys(v)
    }
    return out
  }
  return value
}
