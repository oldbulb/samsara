// workbench-startup: reconciliation on host start. A round left `open` with a
// sibling still `running` is stale to this process: its scope is gone (E1:
// scopes are in-memory) — unless another process on the same ledger (the
// `host` profile's campaign, a second workbench) is driving it right now, and
// the ledger cannot tell the two apart (a round carries no owner). So apply
// writes nothing: it logs every stale round, and the person closes one with
// `/samsara reconcile <round-id>` when nothing drives it — `lifecycle.abortRound`
// judges the running rows `invalid` under the rule `aborted:restart` and closes
// the round with an `aborted` outcome (nothing here writes the ledger). A campaign left open is resumed by starting the
// campaign again on its experiment (it reopens its last open round); nothing
// about an aborted round is resumed.

import type { Context } from '@oldbulb/samsara-kernel'
import type { Ledger } from '@oldbulb/samsara-ledger'
import { ABORT_RULE, type Lifecycle } from '@oldbulb/samsara-lifecycle'

export const name = 'workbench-startup'
export const inject = ['lifecycle', 'ledger']

export { ABORT_RULE }

/** The slices of the two services reconciliation uses (structural, so fakes compose); the one write goes through the service. */
export type StartupLifecycle = Pick<Lifecycle, 'status' | 'abortRound'>
export type StartupLedger = Pick<Ledger, 'challenger'>

/** An open round with siblings still `running`: what a previous process left, or another live one is driving. */
export interface StaleRound {
  round_id: string
  challenger_ids: string[]
}

/** Every open round with a running sibling, in the service's order. */
export function staleRounds(lifecycle: Pick<StartupLifecycle, 'status'>, ledger: StartupLedger): StaleRound[] {
  const stale: StaleRound[] = []
  for (const round of lifecycle.status().rounds) {
    if (round.status !== 'open') continue
    const running = round.sibling_ids.filter((id) => ledger.challenger(id)?.status === 'running')
    if (running.length) stale.push({ round_id: round.id, challenger_ids: running })
  }
  return stale
}

/** One stale round closed through the service: its running siblings judged invalid, the round decided with an aborted outcome; one log line per row. */
export async function abortRound(lifecycle: Pick<StartupLifecycle, 'abortRound'>, stale: StaleRound, log: (line: string) => void = () => {}): Promise<void> {
  const { aborted } = await lifecycle.abortRound(stale.round_id)
  for (const id of aborted) log(`${name}: challenger ${id} was running in round ${stale.round_id}; judged invalid (${ABORT_RULE})`)
  log(`${name}: round ${stale.round_id} closed aborted (${aborted.length} running)`)
}

/** The line apply logs for a stale round: what it is, and the command that closes it. */
export function staleLine(stale: StaleRound): string {
  return `${name}: round ${stale.round_id} is open with running sibling(s) ${stale.challenger_ids.join(', ')}: left by a previous process, or driven by another host on this ledger; when nothing drives it, /samsara reconcile ${stale.round_id} closes it aborted`
}

export function apply(ctx: Context): void {
  const logger = ctx.logger(name)
  for (const stale of staleRounds(ctx.lifecycle, ctx.ledger)) logger.warn(staleLine(stale))
}
