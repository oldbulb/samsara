// Controls (lifecycle spec § Campaign driver): one round whose challenger is
// known to carry no effect — the champion's own skill copied to a fresh
// directory (aa) — or a directory the operator injects (inject), judged at
// holdout like any sibling, so the gate's answer on it is a reading of the
// gate itself. The round is a normal round row; the row's intent tags it
// `control:aa` / `control:inject`, and the round closes without a decision.

import { cpSync, mkdirSync, mkdtempSync } from 'node:fs'
import { resolve } from 'node:path'
import { canonicalJson, sha256, type CompareRow, type RoundRow } from '@oldbulb/samsara-ledger'
import { loadPack } from '@oldbulb/samsara-pack'
import { requireNoiseFloor, skillChallengerOf, type CampaignChampion, type CampaignDeps, type CampaignHooks, type CampaignRunOptions } from './campaign.ts'
import { LifecycleError, type RunOptions } from './index.ts'

export type ControlKind = 'aa' | 'inject'

export interface ControlInput {
  kind: ControlKind
  /** inject: the skill directory run as the challenger. */
  skillDir?: string
  /** The pack directory. */
  pack: string
  champion: CampaignChampion
  metric: string
  nEffFloor: number
  /** Replicates at holdout. */
  repeat: number
  experimentId?: string
  shadowGates?: string[]
  out: string
  run: CampaignRunOptions
  operator?: RoundRow['operator']
}

export type ControlHooks = Pick<CampaignHooks, 'onEvent' | 'signal' | 'hashDir'>

export interface ControlResult {
  control: ControlKind
  roundId: string
  challengerId: string
  compare: CompareRow
}

export async function runControl(deps: CampaignDeps, input: ControlInput, hooks: ControlHooks): Promise<ControlResult> {
  const { lifecycle } = deps
  // Judged at holdout: the noise floor the round would pin (S1) is required before the round, and its reveal, is spent.
  requireNoiseFloor(deps.ledger, loadPack(input.pack), input.champion.proposal, input.metric)
  const round = await lifecycle.openRound({
    pack: input.pack, champion: input.champion.proposal, metric: input.metric, nEffFloor: input.nEffFloor,
    ...(input.experimentId !== undefined ? { experimentId: input.experimentId } : {}),
    ...(input.shadowGates !== undefined ? { shadowGates: input.shadowGates } : {}),
    ...(input.operator !== undefined ? { operator: input.operator } : {}),
  })
  hooks.onEvent({ kind: 'round:opened', roundId: round.id, championId: round.champion_id, resumed: false })
  const out = resolve(input.out, round.id.slice(0, 12))
  mkdirSync(out, { recursive: true })

  let skillDir: string
  if (input.kind === 'aa') {
    skillDir = mkdtempSync(resolve(out, 'aa-'))
    cpSync(input.champion.skillDir, skillDir, { recursive: true })
  } else {
    if (input.skillDir === undefined) throw new LifecycleError('BAD_TRANSITION', 'control inject needs the skill directory to run')
    skillDir = resolve(input.skillDir)
  }
  // A control is one reading of the gate per round: the same snapshot again is a new row under this round, not the first round's verdict.
  const proposal = skillChallengerOf(
    input.champion.proposal, round.champion_id,
    { skillDir, intent: `control:${input.kind}`, prediction: { metric: input.metric, direction: 'up' }, optimizerConfigSha: sha256(canonicalJson({ control: input.kind, round_id: round.id })) },
    hooks.hashDir,
  )
  const { id } = await lifecycle.propose(proposal, { roundId: round.id })
  await lifecycle.open(id)
  const opts: RunOptions = {
    ...input.run,
    repeat: input.repeat,
    out: resolve(out, 'holdout'),
    championSkillDir: input.champion.skillDir,
    signal: hooks.signal,
    log: (line) => hooks.onEvent({ kind: 'attempt:progress', roundId: round.id, challengerId: id, tier: 'holdout', line }),
  }
  const summary = await lifecycle.run(id, 'holdout', opts)
  if (summary.invalid) {
    await lifecycle.closeRound(round.id)
    throw new LifecycleError('NOT_COMPARABLE', `control ${id} is invalid on ${summary.invalid}`)
  }
  const compare = await lifecycle.judge(id, 'holdout')
  const spent = (input.experimentId !== undefined ? deps.ledger.experiment(input.experimentId)?.spent : undefined) ?? { usd: 0, attempts: 0, rounds: 0, holdout_reveals: 0 }
  hooks.onEvent({ kind: 'judged', roundId: round.id, challengerId: id, tier: 'holdout', compare, spent })
  await lifecycle.closeRound(round.id)
  hooks.onEvent({ kind: 'decided', roundId: round.id, challengerId: id, verdict: compare.verdict.value, spent })
  return { control: input.kind, roundId: round.id, challengerId: id, compare }
}
