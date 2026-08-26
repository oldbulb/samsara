// `experiment new`: pre-register a hypothesis, its prediction, the gate the
// rounds will open under and the budget on the ledger before any spend
// (ctx.lifecycle.preregister). Rounds opened with `--experiment <id>` must
// match its gate and are charged to its budget by the service.

import type { GateRegistry } from '@oldbulb/samsara-gate'
import type { ExperimentRow } from '@oldbulb/samsara-ledger'
import { gateRefOf, refMethod, roundPolicy, type Lifecycle } from '@oldbulb/samsara-lifecycle'
import { loadPack } from '@oldbulb/samsara-pack'

export interface ExperimentNewRequest {
  pack: string
  hypothesis: string
  metric: string
  direction: 'up' | 'down'
  magnitude?: number
  budgetUsd?: number
  budgetRounds?: number
  budgetAttempts?: number
  budgetHoldoutReveals?: number
  /** The n_eff floor the rounds will run at: part of the policy the experiment pins. */
  nEffFloor: number
  who?: string
}

export interface ExperimentNewDeps {
  lifecycle: Pick<Lifecycle, 'preregister'>
  gate: Pick<GateRegistry, 'current'>
}

export async function experimentNew(req: ExperimentNewRequest, deps: ExperimentNewDeps): Promise<ExperimentRow> {
  const def = loadPack(req.pack)
  const mounted = deps.gate.current()
  if (!mounted) throw new Error('no gate policy is mounted on ctx.gate')
  // The gate a round opens under for this pack and floor: the promotion gate at the policy `openRound` computes.
  const gate = gateRefOf(mounted, roundPolicy(req.nEffFloor, def.manifest.holdout?.mde))
  return deps.lifecycle.preregister({
    hypothesis: req.hypothesis,
    prediction: { metric: req.metric, direction: req.direction, ...(req.magnitude !== undefined ? { magnitude: req.magnitude } : {}) },
    pack: def.name,
    gate,
    budget: {
      ...(req.budgetUsd !== undefined ? { usd: req.budgetUsd } : {}),
      ...(req.budgetAttempts !== undefined ? { attempts: req.budgetAttempts } : {}),
      ...(req.budgetRounds !== undefined ? { rounds: req.budgetRounds } : {}),
      ...(req.budgetHoldoutReveals !== undefined ? { holdout_reveals: req.budgetHoldoutReveals } : {}),
    },
    created_by: { channel: 'cli', ...(req.who !== undefined ? { who: req.who } : {}) },
  })
}

function budgetLine(e: ExperimentRow): string {
  const cell = (spent: number, budget: number | undefined) => `${spent}/${budget ?? '-'}`
  return `usd ${cell(e.spent.usd, e.budget.usd)}  attempts ${cell(e.spent.attempts, e.budget.attempts)}  rounds ${cell(e.spent.rounds, e.budget.rounds)}  holdout reveals ${cell(e.spent.holdout_reveals, e.budget.holdout_reveals)}`
}

export function formatExperiment(e: ExperimentRow): string {
  const p = e.prediction
  return [
    `experiment ${e.id}`,
    `hypothesis ${e.hypothesis}`,
    `prediction ${p.metric} ${p.direction}${p.magnitude !== undefined ? ` by ${p.magnitude}` : ''}`,
    `pack       ${e.pack}  gate ${refMethod(e.gate)} policy ${e.gate.policy_sha.slice(0, 12)}`,
    `budget     ${budgetLine(e)}`,
    `status     ${e.status}  created ${e.created_at}${e.created_by.who !== undefined ? ` by ${e.created_by.who}` : ''}  rounds ${e.round_ids.length}`,
  ].join('\n')
}
