// `experiment new` pre-registers through the service; a challenge opened
// under the experiment is charged to it.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GATE_DEFAULT_NAME, GATE_DEFAULT_VERSION } from '@oldbulb/samsara-gate'
import { policySha, roundPolicy } from '@oldbulb/samsara-lifecycle'
import { challenge } from '../src/challenge.ts'
import { experimentNew, formatExperiment, type ExperimentNewRequest } from '../src/experiment.ts'
import { formatStatus } from '../src/status.ts'
import { MINI, MINI_SKILL, openHarness } from './harness.ts'

const req: ExperimentNewRequest = { pack: MINI, hypothesis: 'shorter instructions raise the pass rate', metric: 'pass_rate', direction: 'up', magnitude: 0.05, budgetUsd: 20, budgetRounds: 5, nEffFloor: 3, who: 'me' }

describe('experiment new', () => {
  it('registers the hypothesis, the prediction, the mounted gate at the round policy for this pack, and the budget', async () => {
    const h = await openHarness()
    const e = await experimentNew(req, { lifecycle: h.lifecycle, gate: h.gate })
    expect(e).toMatchObject({
      hypothesis: req.hypothesis, prediction: { metric: 'pass_rate', direction: 'up', magnitude: 0.05 }, pack: 'minipack',
      gate: { name: GATE_DEFAULT_NAME, version: GATE_DEFAULT_VERSION, policy_sha: policySha(roundPolicy(3, 0.1)) },
      budget: { usd: 20, rounds: 5 }, spent: { usd: 0, attempts: 0, rounds: 0, holdout_reveals: 0 },
      created_by: { channel: 'cli', who: 'me' }, status: 'active', round_ids: [],
    })
    expect(h.ledger.experiment(e.id)).toEqual(e)
    const text = formatExperiment(e)
    expect(text).toContain(`experiment ${e.id}`)
    expect(text).toContain('prediction pass_rate up by 0.05')
    expect(text).toContain(`pack       minipack  gate ${GATE_DEFAULT_NAME}@${GATE_DEFAULT_VERSION} policy ${e.gate.policy_sha.slice(0, 12)}`)
    expect(text).toContain('budget     usd 0/20  attempts 0/-  rounds 0/5  holdout reveals 0/-')
    expect(text).toContain('status     active')
    expect(formatStatus(h.lifecycle.status())).toContain(`  ${e.id}  active  pass_rate up by 0.05  rounds 0/5  usd 0/20  "${req.hypothesis}"`)
  })

  it('a challenge under the experiment opens its round there and is charged to it', async () => {
    const h = await openHarness()
    const e = await experimentNew(req, { lifecycle: h.lifecycle, gate: h.gate })
    const r = await challenge({
      pack: MINI, loop: 'fake', set: 'smoke', repeat: 1, out: mkdtempSync(resolve(tmpdir(), 'runner-experiment-')), maxTurns: 5, maxMinutes: 1,
      surface: 'skill', skillDir: MINI_SKILL, intent: 'i', metric: 'pass_rate', nEffFloor: 3, withChampion: false, gatePolicy: 'default', experiment: e.id,
    }, h.deps())
    expect(h.ledger.round(r.roundId)?.experiment_id).toBe(e.id)
    expect(h.ledger.experiment(e.id)).toMatchObject({ round_ids: [r.roundId], spent: { rounds: 1, attempts: 2, holdout_reveals: 0 } })
    expect(h.ledger.experiment(e.id)?.spent.usd).toBeCloseTo(0.04, 6)
  })

  it('with nothing mounted on ctx.gate there is no gate to pin', async () => {
    const h = await openHarness({ gate: [] })
    await expect(experimentNew(req, { lifecycle: h.lifecycle, gate: h.gate })).rejects.toThrow('no gate policy is mounted on ctx.gate')
  })
})
