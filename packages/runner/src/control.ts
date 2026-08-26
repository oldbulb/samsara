// `control aa|inject`: one round on ctx.lifecycle whose challenger is known to
// carry no effect (aa: the champion's own skill) or an injected one (inject:
// --skill-dir), judged at holdout — a reading of the gate itself. The command
// assembles the champion and the hooks; the service opens, runs, judges and
// closes the round.

import type { ControlKind, ControlResult, Lifecycle } from '@oldbulb/samsara-lifecycle'
import { loadPack } from '@oldbulb/samsara-pack'
import { hashDir } from '@oldbulb/samsara-workdir'
import { campaignRunOf, formatEvent } from './campaign.ts'
import { formatChallenge, type ChallengeDeps } from './challenge.ts'
import { bookOf, championProposal, type RunRequest } from './run.ts'

export type { ControlKind } from '@oldbulb/samsara-lifecycle'

export interface ControlRequest extends Omit<RunRequest, 'set'> {
  kind: ControlKind
  /** inject: the skill directory carrying the known effect. */
  skillDir?: string
  metric: string
  nEffFloor: number
  experiment?: string
  shadowGates?: string[]
}

export interface ControlDeps extends Pick<ChallengeDeps, 'loops' | 'route' | 'championSkillDir' | 'signal' | 'log'> {
  lifecycle: Pick<Lifecycle, 'control'>
}

export async function control(req: ControlRequest, deps: ControlDeps): Promise<ControlResult> {
  const def = loadPack(req.pack)
  const book = bookOf(def)
  const { kind, skillDir, metric, nEffFloor, experiment, shadowGates, ...run } = req
  if (kind === 'inject' && skillDir === undefined) throw new Error('control inject: --skill-dir is required')
  const log = deps.log ?? (() => {})
  const championSkillDir = deps.championSkillDir ?? def.skillDir
  const champion = { proposal: championProposal(def, book, { ...run, set: 'holdout' }, deps), skillDir: championSkillDir }
  return deps.lifecycle.control({
    kind, pack: req.pack, champion, metric, nEffFloor, repeat: req.repeat, out: req.out, run: campaignRunOf(req, deps),
    ...(skillDir !== undefined ? { skillDir } : {}),
    ...(experiment !== undefined ? { experimentId: experiment } : {}),
    ...(shadowGates !== undefined ? { shadowGates } : {}),
  }, { onEvent: (e) => log(formatEvent(e)), signal: deps.signal ?? new AbortController().signal, hashDir })
}

export function formatControl(r: ControlResult): string {
  return [`control    ${r.control}`, formatChallenge({ challengerId: r.challengerId, championId: r.compare.vs_id, roundId: r.roundId, compare: r.compare })].join('\n')
}
