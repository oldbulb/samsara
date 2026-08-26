// The samsara jobs of this process by what they run: the experiment a
// campaign, round or control is charged to and the rounds it opened. The jobs
// registry knows a job by id, kind and label only; this map is how
// `/samsara stop <round-id>` finds the job driving a round, and how
// `/samsara reconcile <round-id>` knows a round is driven by this process.
// Written by the tools (at start, and as `round:opened` events arrive),
// dropped when the job settles, read by the commands.

import type { JobId } from '@oldbulb/samsara-kernel'

export interface JobTag {
  experiment_id?: string
  /** In the order the job opened them. */
  round_ids: string[]
}

export const jobTags = new Map<JobId, JobTag>()

/** The jobs tagged with a round, or with the experiment the round belongs to. */
export function jobsOfRound(roundId: string, experimentId: string | undefined): JobId[] {
  const ids: JobId[] = []
  for (const [id, tag] of jobTags) {
    if (tag.round_ids.includes(roundId) || (experimentId !== undefined && tag.experiment_id === experimentId)) ids.push(id)
  }
  return ids
}
