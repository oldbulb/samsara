// `calibrate` through the service with this package's runSet as the executor:
// the champion reruns on the set, the noise floor row lands, `status` lists it.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LifecycleError } from '@oldbulb/samsara-lifecycle'
import { calibrate, formatCalibrate, type CalibrateRequest } from '../src/calibrate.ts'
import { formatStatus } from '../src/status.ts'
import { MINI, openHarness } from './harness.ts'

function req(over: Partial<CalibrateRequest> = {}): CalibrateRequest {
  return { pack: MINI, loop: 'fake', set: 'smoke', out: mkdtempSync(resolve(tmpdir(), 'runner-calibrate-')), maxTurns: 5, maxMinutes: 1, metric: 'pass_rate', reruns: 3, ...over }
}

describe('calibrate', () => {
  it('reruns the champion on the set and records the noise floor under its row; status shows it', async () => {
    const h = await openHarness()
    const floor = await calibrate(req(), h.deps())
    expect(floor).toMatchObject({ loop: 'fake', metric: 'pass_rate', tier: 'smoke', unit: 'entity', n_reruns: 3, n_tasks: 1, sd_paired: 0 })
    expect(h.ledger.floors.get(floor.id)).toEqual(floor)
    // the reruns are champion attempts at the same sample index, reusable by later rounds
    const attempts = h.ledger.attemptsOf(floor.champion_id)
    expect(attempts.map((a) => a.sample)).toEqual([0, 0, 0])
    expect(attempts.every((a) => a.tier === 'smoke')).toBe(true)
    expect(h.ledger.challenger(floor.champion_id)).toMatchObject({ parent_ids: [], pack: 'minipack', prediction: { metric: 'pass_rate' } })
    expect(h.ledger.rounds.size).toBe(0)
    const text = formatCalibrate(floor)
    expect(text).toContain(`noise floor ${floor.id}`)
    expect(text).toContain('sd_paired   0.0000  (entity unit; 3 reruns x 1 tasks)')
    const status = formatStatus(h.lifecycle.status())
    expect(status).toContain('champion   (none)')
    expect(status).toContain('rounds     0 open')
    expect(status).toContain('noise floors 1')
    expect(status).toContain(`  ${floor.id}  champion ${floor.champion_id}  loop fake  metric pass_rate  sd_paired 0.0000  reruns 3  tasks 1  tier smoke`)
    expect(status).toContain('experiments 0')
  })

  it('refuses fewer than 3 reruns before anything runs', async () => {
    const h = await openHarness()
    await expect(calibrate(req({ reruns: 2 }), h.deps())).rejects.toBeInstanceOf(LifecycleError)
    expect(h.ledger.attempts.size).toBe(0)
  })
})
