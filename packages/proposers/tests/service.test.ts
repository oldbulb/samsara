import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@samsara/kernel'
import { Proposers, ProposerRegistryError, type ProposerAdapter } from '../src/index.ts'
import * as pluginHuman from '../src/plugin-human.ts'
import { createAdapter } from '../src/plugin-claude-p.ts'
import { fakeSpawn, tempRoot, writeSkill } from './fixture.ts'

function adapter(name: string): ProposerAdapter {
  return { name, version: '1', configSha: 'a'.repeat(64), propose: () => Promise.reject(new Error('unused')) }
}

describe('Proposers service', () => {
  it('registers, lists, disposes and refuses duplicates', async () => {
    const ctx = new Context()
    await ctx.plugin(Proposers)
    const dispose = ctx.proposers.register(adapter('a'))
    ctx.proposers.register(adapter('b'))
    expect(ctx.proposers.list().map((a) => a.name)).toEqual(['a', 'b'])
    expect(ctx.proposers.get('a')?.name).toBe('a')
    expect(() => ctx.proposers.register(adapter('a'))).toThrow(ProposerRegistryError)
    await dispose()
    expect(ctx.proposers.get('a')).toBeUndefined()
  })

  it('plugin-human registers a working human adapter for the scope lifetime', async () => {
    const ctx = new Context()
    await ctx.plugin(Proposers)
    const root = tempRoot()
    const dir = writeSkill(join(root, 'skill'))
    const fiber = await ctx.plugin(pluginHuman, { skillDir: dir, intent: 'i', prediction: { metric: 'pass', direction: 'up' } })
    const human = ctx.proposers.get('human')
    expect(human).toBeDefined()
    const p = await human!.propose({ viewDir: root, workDir: root, signal: new AbortController().signal, parent: 'p' })
    expect(p.patch).toEqual({ surface: 'skill', skill_dir: dir })
    await fiber.dispose()
    expect(ctx.proposers.get('human')).toBeUndefined()
  })

  it('plugin-claude-p wires spawn through ctx.subprocess inside an effect and resolves the credential into env only', async () => {
    const { spawn, records } = fakeSpawn((spec, h) => {
      writeSkill(join(spec.cwd, 'skill'))
      writeFileSync(join(spec.cwd, 'proposal.json'), JSON.stringify({
        surface: 'skill', patch: { surface: 'skill', skill_dir: 'skill' }, intent: 'i', prediction: { metric: 'pass', direction: 'up' },
      }))
      h.settle({ exitCode: 0, signal: null })
    })
    const effects: string[] = []
    const ctx = {
      effect: (fn: () => unknown, label: string) => { effects.push(label); const d = fn(); return () => (typeof d === 'function' ? d() : undefined) },
      subprocess: { spawn },
      credentials: { resolve: async (ref: string) => (ref === 'TOK' ? { value: 'sk-resolved' } : undefined) },
      proposers: undefined,
    } as never
    const a = createAdapter(ctx, { credentialRef: 'TOK' })
    const root = tempRoot()
    const p = await a.propose({ viewDir: root, workDir: root, signal: new AbortController().signal, parent: 'p' })
    expect(p.proposer.name).toBe('claude-p')
    expect(records[1]!.spec.env?.['ANTHROPIC_AUTH_TOKEN']).toBe('sk-resolved')
    expect(effects.filter((e) => e === 'proposer-claude-p:child')).toHaveLength(2)
    expect(JSON.stringify(p)).not.toContain('sk-resolved')

    const missing = createAdapter(ctx, { credentialRef: 'NOPE' })
    await expect(missing.propose({ viewDir: root, workDir: root, signal: new AbortController().signal, parent: 'p' })).rejects.toThrow(/not configured/)
  })
})
