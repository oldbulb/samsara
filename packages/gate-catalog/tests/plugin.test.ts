import { describe, expect, it } from 'vitest'
import { GateRegistry, gateMethodOf } from '@oldbulb/samsara-gate'
import * as gateDefault from '@oldbulb/samsara-gate/plugin-default'
import { Context } from '@oldbulb/samsara-kernel'
import { CATALOG } from '../src/index.ts'
import * as plugin from '../src/plugin.ts'

describe('gate-catalog plugin', () => {
  it('mounts the named rules on ctx.gate in order; before gate-default they are shadows', async () => {
    const ctx = new Context()
    await ctx.plugin(GateRegistry)
    const fiber = await ctx.plugin(plugin, { policies: ['keep-better', 'miller@0.1.0'] })
    await ctx.plugin(gateDefault, {})
    expect(ctx.gate.list().map(gateMethodOf)).toEqual(['keep-better@0.1.0', 'miller@0.1.0', gateMethodOf(ctx.gate.current()!)])
    expect(ctx.gate.current()!.name).toBe('gate-default')
    // the row's disposal unmounts what it registered
    await fiber.dispose()
    expect(ctx.gate.list().map(gateMethodOf)).toEqual([gateMethodOf(ctx.gate.current()!)])
    expect(ctx.gate.current()!.name).toBe('gate-default')
  })

  it('defaults to every catalog rule', async () => {
    const ctx = new Context()
    await ctx.plugin(GateRegistry)
    await ctx.plugin(plugin, {})
    expect(ctx.gate.list().map(gateMethodOf)).toEqual(CATALOG.map(gateMethodOf))
  })

  it('an unknown name is a config error', async () => {
    const ctx = new Context()
    await ctx.plugin(GateRegistry)
    await expect(ctx.plugin(plugin, { policies: ['nope'] })).rejects.toThrow('unknown catalog rule "nope"')
  })
})
