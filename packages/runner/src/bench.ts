// samsara gate bench: measure gate policies on recorded attempts. Reads an
// attempts.jsonl and a task list, builds the gate list (the runner's presets,
// catalog rules, a subprocess gate), runs @oldbulb/samsara-gate-catalog/bench
// and prints its table. No ledger, no pack command, no model: pure over the
// two files and the seed.

import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { CommandGatePolicy, type GatePolicyProvider } from '@oldbulb/samsara-gate'
import { CATALOG } from '@oldbulb/samsara-gate-catalog'
import { bench, formatBench, type BenchAttemptRow, type BenchResult, type BenchTaskRow } from '@oldbulb/samsara-gate-catalog/bench'
import { GATE_DEFAULT, gatePresetOf, type GatePolicyName } from './challenge.ts'

export interface BenchRequest {
  /** attempts.jsonl of >= 2 same-config reruns of one champion (the runner's own row shape). */
  attempts: string
  /** Task rows (`task_id`, `entity_key`, `stratum?`): the entity the bootstrap clusters by comes only from here. */
  tasks: string
  metric: string
  /** Gate names: presets or catalog rules; absent = `default` plus every catalog rule. */
  gates?: GatePolicyName[]
  /** A gate written in any language (docs: examples/gates/README.md), run as a subprocess per judgement. */
  gateCommand?: string
  resamples?: number
  seed?: number
  /** SESOI handed to every policy (`policy.mde`). */
  sesoi?: number
  nEffFloor?: number
  /** Write the BenchResult as JSON here. */
  out?: string
}

export const GATE_COMMAND_VERSION = 'command'

export function readJsonl<T>(file: string): T[] {
  return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as T)
}

/** The providers a bench request names, in order: presets and catalog rules by name, then the subprocess gate. */
export function benchGatesOf(req: Pick<BenchRequest, 'gates' | 'gateCommand'>): GatePolicyProvider[] {
  const names = req.gates ?? ['default', ...CATALOG.map((g) => g.name)]
  if (names.length === 0 && req.gateCommand === undefined) throw new Error('gate bench: --gates is empty and no --gate-command was given')
  const gates = names.map((name) => gatePresetOf(name) ?? GATE_DEFAULT)
  if (req.gateCommand !== undefined) {
    const command = resolve(req.gateCommand)
    gates.push(new CommandGatePolicy({ command, name: basename(command), version: GATE_COMMAND_VERSION }))
  }
  return gates
}

export async function benchRun(req: BenchRequest): Promise<BenchResult> {
  const attempts = readJsonl<BenchAttemptRow>(resolve(req.attempts))
  const tasks = readJsonl<BenchTaskRow>(resolve(req.tasks))
  const policy = {
    ...(req.nEffFloor !== undefined ? { nEffFloor: req.nEffFloor } : {}),
    ...(req.sesoi !== undefined ? { mde: req.sesoi } : {}),
  }
  return bench({
    attempts,
    tasks,
    metric: req.metric,
    gates: benchGatesOf(req),
    ...(Object.keys(policy).length ? { policy } : {}),
    ...(req.resamples !== undefined ? { resamples: req.resamples } : {}),
    ...(req.seed !== undefined ? { seed: req.seed } : {}),
  })
}

export { formatBench }
