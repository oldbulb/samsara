// `calibrate`: the noise floor (S1) — the champion rerun n times on one set
// with the null diff, recorded by ctx.lifecycle as the paired spread per
// entity across reruns. The command performs no transition itself.

import type { NoiseFloorRow } from '@oldbulb/samsara-ledger'
import type { Lifecycle } from '@oldbulb/samsara-lifecycle'
import { loadPack } from '@oldbulb/samsara-pack'
import { runOptionsOf, type ChallengeDeps } from './challenge.ts'
import { bookOf, championProposal, newRunId, type RunRequest } from './run.ts'

export interface CalibrateRequest extends Omit<RunRequest, 'repeat'> {
  /** Primary metric (kind reality) the floor is measured on. */
  metric: string
  /** Same-config reruns of every task (>= 3). */
  reruns: number
}

export interface CalibrateDeps extends Pick<ChallengeDeps, 'loops' | 'route' | 'championSkillDir' | 'signal' | 'log' | 'runId'> {
  lifecycle: Pick<Lifecycle, 'calibrate'>
}

export async function calibrate(req: CalibrateRequest, deps: CalibrateDeps): Promise<NoiseFloorRow> {
  const def = loadPack(req.pack)
  const book = bookOf(def)
  const { metric, reruns, ...run } = req
  const champion = championProposal(def, book, { ...run, repeat: reruns }, deps)
  const { repeat: _r, withChampion: _w, ...opts } = runOptionsOf({ ...run, repeat: reruns, withChampion: false }, deps, deps.runId ?? newRunId())
  return deps.lifecycle.calibrate({ pack: req.pack, champion, metric, set: req.set, reruns, run: opts })
}

export function formatCalibrate(f: NoiseFloorRow): string {
  return [
    `noise floor ${f.id}`,
    `champion    ${f.champion_id}  loop ${f.loop}  metric ${f.metric}  tier ${f.tier}`,
    `sd_paired   ${f.sd_paired.toFixed(4)}  (${f.unit} unit; ${f.n_reruns} reruns x ${f.n_tasks} tasks)`,
    `eval config ${f.eval_config_sha.slice(0, 12)}  measured ${f.measured_at}`,
  ].join('\n')
}
