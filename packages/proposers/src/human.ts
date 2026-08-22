// Adapter 'human': the operator supplies the patch directly (no model). The
// Proposal is assembled from configuration; `propose` only resolves and checks
// the skill directory.

import { existsSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type { PatchOptions } from '@samsara/kernel'
import { canonicalJson, sha256, validateProposal, type Prediction, type Proposal, type ProposeInput, type ProposerAdapter, type Surface } from './types.ts'

export const HUMAN_NAME = 'human'
export const HUMAN_VERSION = '1'

export interface HumanProposalConfig {
  parent?: string
  /** Surface of the patch; defaults to 'skill' when `skillDir` is given. */
  surface?: Surface
  /** Replacement skill directory (surface 'skill'). */
  skillDir?: string
  /** Patch rows (any other surface); an empty array counts as absent. */
  rows?: PatchOptions[]
  intent: string
  prediction: Prediction
}

export class HumanAdapter implements ProposerAdapter {
  readonly name = HUMAN_NAME
  readonly version = HUMAN_VERSION
  readonly configSha: string

  constructor(private readonly config: HumanProposalConfig) {
    const hasDir = config.skillDir !== undefined
    const hasRows = (config.rows?.length ?? 0) > 0
    if (hasDir === hasRows) throw new Error('proposers/human: exactly one of skillDir or rows is required')
    const surface = config.surface ?? (hasDir ? 'skill' : undefined)
    if (surface === undefined) throw new Error('proposers/human: surface is required with rows')
    if ((surface === 'skill') !== hasDir) throw new Error(`proposers/human: surface "${surface}" does not fit the supplied patch`)
    this.configSha = sha256(canonicalJson({ ...config, surface, parent: undefined }))
  }

  async propose(input: ProposeInput): Promise<Proposal> {
    const parent = input.parent ?? this.config.parent
    if (parent === undefined) throw new Error('proposers/human: parent is required (input or config)')
    const { intent, prediction } = this.config
    const proposer = { name: this.name, version: this.version, config_sha: this.configSha }
    if (this.config.skillDir !== undefined) {
      const dir = isAbsolute(this.config.skillDir) ? this.config.skillDir : resolve(input.workDir, this.config.skillDir)
      if (!existsSync(join(dir, 'SKILL.md')) || !statSync(dir).isDirectory()) {
        throw new Error(`proposers/human: ${dir} is not a skill directory (no SKILL.md)`)
      }
      return validateProposal({ parent, surface: 'skill', patch: { surface: 'skill', skill_dir: dir }, intent, prediction, proposer })
    }
    const surface = this.config.surface as Exclude<Surface, 'skill'>
    return validateProposal({ parent, surface, patch: { surface, rows: this.config.rows }, intent, prediction, proposer })
  }
}
