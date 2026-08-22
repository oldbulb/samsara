import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HumanAdapter } from '../src/human.ts'
import { tempRoot, writeSkill } from './fixture.ts'

const prediction = { metric: 'pass', direction: 'up' as const, predicted_fixes: ['t1'] }
const input = (workDir: string) => ({ viewDir: join(workDir, 'view'), workDir, signal: new AbortController().signal })

describe('HumanAdapter', () => {
  it('proposes a skill directory from config; parent from input wins', async () => {
    const root = tempRoot()
    const dir = writeSkill(join(root, 'my-skill'))
    const a = new HumanAdapter({ parent: 'cfg-parent', skillDir: dir, intent: 'Because.', prediction })
    const p = await a.propose({ ...input(root), parent: 'in-parent' })
    expect(p).toMatchObject({ parent: 'in-parent', surface: 'skill', patch: { surface: 'skill', skill_dir: dir }, intent: 'Because.', prediction })
    expect(p.proposer).toEqual({ name: 'human', version: '1', config_sha: a.configSha })
    expect((await a.propose(input(root))).parent).toBe('cfg-parent')
  })
  it('resolves a relative skillDir against workDir and rejects a dir without SKILL.md', async () => {
    const root = tempRoot()
    writeSkill(join(root, 'skill'))
    const a = new HumanAdapter({ skillDir: './skill', intent: 'x', prediction })
    expect((await a.propose({ ...input(root), parent: 'p' })).patch).toEqual({ surface: 'skill', skill_dir: join(root, 'skill') })
    const b = new HumanAdapter({ skillDir: './missing', intent: 'x', prediction })
    await expect(b.propose({ ...input(root), parent: 'p' })).rejects.toThrow(/SKILL.md/)
  })
  it('proposes rows for a non-skill surface', async () => {
    const rows = [{ id: 'r1', config: { k: 1 } }]
    const a = new HumanAdapter({ surface: 'prompt', rows, intent: 'x', prediction })
    const p = await a.propose({ ...input(tempRoot()), parent: 'p' })
    expect(p.patch).toEqual({ surface: 'prompt', rows })
  })
  it('refuses ambiguous or inconsistent config, and a missing parent', async () => {
    expect(() => new HumanAdapter({ intent: 'x', prediction })).toThrow(/exactly one/)
    expect(() => new HumanAdapter({ skillDir: '/s', rows: [{}], intent: 'x', prediction })).toThrow(/exactly one/)
    expect(() => new HumanAdapter({ rows: [{}], intent: 'x', prediction })).toThrow(/surface is required/)
    expect(() => new HumanAdapter({ surface: 'prompt', skillDir: '/s', intent: 'x', prediction })).toThrow(/does not fit/)
    const a = new HumanAdapter({ surface: 'prompt', rows: [{}], intent: 'x', prediction })
    await expect(a.propose(input(tempRoot()))).rejects.toThrow(/parent/)
  })
  it('config_sha is stable across key order and ignores parent', () => {
    const a = new HumanAdapter({ intent: 'x', prediction, skillDir: '/s', parent: 'p1' })
    const b = new HumanAdapter({ skillDir: '/s', prediction: { ...prediction }, intent: 'x', parent: 'p2' })
    const c = new HumanAdapter({ skillDir: '/s', prediction, intent: 'y' })
    expect(a.configSha).toBe(b.configSha)
    expect(a.configSha).not.toBe(c.configSha)
  })
})
