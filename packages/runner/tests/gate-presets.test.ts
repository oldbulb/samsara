import { describe, expect, it } from 'vitest'
import { GateRegistry, gateMethodOf } from '@oldbulb/samsara-gate'
import * as gateDefault from '@oldbulb/samsara-gate/plugin-default'
import { Context } from '@oldbulb/samsara-kernel'
import { gateFor } from '../src/challenge.ts'
import * as gatePresets from '../src/gate-presets.ts'
import { DEFAULT } from './harness.ts'

describe('gate-presets plugin', () => {
  it('mounts the named presets and catalog rules on ctx.gate in order; before gate-default they are shadows', async () => {
    const ctx = new Context()
    await ctx.plugin(GateRegistry)
    const fiber = await ctx.plugin(gatePresets, { policies: ['default', 'fast', 'permissive', 'keep-better'] })
    await ctx.plugin(gateDefault, {})
    expect(ctx.gate.list().map(gateMethodOf)).toEqual(['gate-fast@0.1.0', 'gate-permissive@test', 'keep-better@0.1.0', DEFAULT])
    expect(gateMethodOf(ctx.gate.current()!)).toBe(DEFAULT)
    const ledger = { consentsOf: () => [] }
    expect(gateFor('fast', { gate: ctx.gate, ledger })).toEqual({ promotionGate: DEFAULT, gate: 'gate-fast@0.1.0', shadow: true })
    expect(gateFor('keep-better', { gate: ctx.gate, ledger })).toMatchObject({ gate: 'keep-better@0.1.0', shadow: true })
    // the row's disposal unmounts what it registered
    await fiber.dispose()
    expect(ctx.gate.list().map(gateMethodOf)).toEqual([DEFAULT])
    expect(() => gateFor('fast', { gate: ctx.gate, ledger })).toThrow('gate policy gate-fast@0.1.0 is not mounted on ctx.gate')
  })

  it('an unknown name is a config error', async () => {
    const ctx = new Context()
    await ctx.plugin(GateRegistry)
    await expect(ctx.plugin(gatePresets, { policies: ['nope'] })).rejects.toThrow('unknown gate policy "nope"')
  })
})
