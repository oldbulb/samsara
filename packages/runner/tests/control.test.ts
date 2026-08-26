// `control aa` through the service: the champion's own skill as the
// challenger, judged at holdout under the noise floor a calibrate recorded.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { calibrate } from '../src/calibrate.ts'
import { control, formatControl, type ControlRequest } from '../src/control.ts'
import { DEFAULT, MINI, openHarness } from './harness.ts'

function req(over: Partial<ControlRequest> = {}): ControlRequest {
  return { kind: 'aa', pack: MINI, loop: 'fake', repeat: 1, out: mkdtempSync(resolve(tmpdir(), 'runner-control-')), maxTurns: 5, maxMinutes: 1, metric: 'pass_rate', nEffFloor: 1, ...over }
}

describe('control', () => {
  it('aa: one round at holdout on a copy of the champion skill, intent control:aa, closed without a decision', async () => {
    const h = await openHarness()
    const floor = await calibrate({ pack: MINI, loop: 'fake', set: 'holdout', out: mkdtempSync(resolve(tmpdir(), 'runner-control-')), maxTurns: 5, maxMinutes: 1, metric: 'pass_rate', reruns: 3 }, h.deps())
    const logs: string[] = []
    const r = await control(req(), h.deps({ log: (l) => logs.push(l) }))
    expect(r.control).toBe('aa')
    expect(r.compare).toMatchObject({ challenger_id: r.challengerId, vs_id: floor.champion_id, tier: 'holdout', gate: DEFAULT, shadow: false, sd_source: 'noise_floor', round_id: r.roundId })
    const row = h.ledger.challenger(r.challengerId)!
    expect(row).toMatchObject({ intent: 'control:aa', parent_ids: [floor.champion_id], skill_sha: h.ledger.challenger(floor.champion_id)!.skill_sha, status: 'judged', tier_reached: 'holdout' })
    expect(row.patch.skill_ref).toContain(r.roundId.slice(0, 12))
    expect(h.ledger.round(r.roundId)).toMatchObject({ noise_floor_id: floor.id, sibling_ids: [r.challengerId], status: 'decided', outcome: { superseded: [] } })
    // the champion's holdout attempts from the calibrate were reused; the control ran once
    expect(h.ledger.attemptsOf(floor.champion_id)).toHaveLength(3)
    expect(h.ledger.attemptsOf(r.challengerId)).toHaveLength(1)
    expect(logs.some((l) => l.startsWith(`round ${r.roundId.slice(0, 12)} opened: champion ${floor.champion_id}`))).toBe(true)
    expect(logs.some((l) => l.includes(`${r.challengerId} judged at holdout: ${r.compare.verdict.value}`))).toBe(true)
    const text = formatControl(r)
    expect(text).toContain('control    aa')
    expect(text).toContain(`round      ${r.roundId}`)
    expect(text).toContain(`verdict    ${r.compare.verdict.value}  rule ${r.compare.rule_fired}  by ${DEFAULT}`)
  })

  it('inject needs the skill directory', async () => {
    const h = await openHarness()
    await expect(control(req({ kind: 'inject' }), h.deps())).rejects.toThrow('control inject: --skill-dir is required')
    expect(h.ledger.rounds.size).toBe(0)
  })
})
