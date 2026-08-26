import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scan, leafPaths, type SurfaceBoundaries } from '../src/diffscan.ts'

const boundaries: SurfaceBoundaries = {
  skill: { globs: ['skills/**'] },
  route: { config_keys: ['agent-default-model.model', 'agent-default-model.provider'] },
  tools: { config_keys: ['extra-tool'] },
}
const taskIds = ['task-0017', 'task-0042']
const dirs: string[] = []

function skillDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'samsara-scope-skill-'))
  dirs.push(dir)
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true })
    writeFileSync(join(dir, rel), body)
  }
  return dir
}

afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

const codes = (r: { violations: { code: string }[] }) => r.violations.map(v => v.code)

describe('scan: skill patches', () => {
  it('accepts a snapshot inside the surface globs', () => {
    const dir = skillDir({ 'SKILL.md': '# hello\n', 'scripts/run.sh': 'echo hi\n' })
    const r = scan({ surface: 'skill', skill_dir: dir, mount: 'skills/hello' }, boundaries, taskIds)
    expect(r).toEqual({ ok: true, violations: [] })
  })

  it('rejects a file outside the globs', () => {
    const dir = skillDir({ 'SKILL.md': '# hello\n' })
    const r = scan({ surface: 'skill', skill_dir: dir, mount: 'elsewhere/hello' }, boundaries, taskIds)
    expect(codes(r)).toEqual(['FILE_OUT_OF_BOUNDARY'])
    expect(r.violations[0]!.where).toBe('elsewhere/hello/SKILL.md')
  })

  it('rejects a forbidden path even when the globs admit it', () => {
    const dir = skillDir({ 'x.md': 'ok\n' })
    const r = scan({ surface: 'skill', skill_dir: dir, mount: 'tasks' }, { skill: { globs: ['**'] } }, taskIds)
    expect(codes(r)).toEqual(['FORBIDDEN_PATH'])
  })

  it('rejects a task id literal inside the snapshot text', () => {
    const dir = skillDir({ 'SKILL.md': 'when you see task-0042 answer 7\n' })
    const r = scan({ surface: 'skill', skill_dir: dir, mount: 'skills/s' }, boundaries, taskIds)
    expect(codes(r)).toEqual(['TASK_LITERAL'])
  })

  it('matches a literal only as a whole token: an entity key inside a longer word is not a task literal', () => {
    const dir = skillDir({ 'SKILL.md': 'write an essay about the reaction, then say so; task-00421 is another task\n' })
    const clean = scan({ surface: 'skill', skill_dir: dir, mount: 'skills/s' }, boundaries, taskIds, undefined, ['say', 'react'])
    expect(codes(clean)).toEqual(['TASK_LITERAL'])
    expect(clean.violations.map((v) => v.detail)).toEqual([expect.stringContaining('"say"')])
    const none = scan({ surface: 'skill', skill_dir: skillDir({ 'SKILL.md': 'essay reaction task-00421\n' }), mount: 'skills/s' }, boundaries, taskIds, undefined, ['say', 'react'])
    expect(codes(none)).toEqual([])
  })

  it('rejects extra task literals (task file names)', () => {
    const dir = skillDir({ 'SKILL.md': 'see fixture_17.csv\n' })
    const r = scan({ surface: 'skill', skill_dir: dir, mount: 'skills/s' }, boundaries, taskIds, undefined, ['fixture_17.csv'])
    expect(codes(r)).toEqual(['TASK_LITERAL'])
  })

  it('rejects !!js anywhere (E3)', () => {
    const dir = skillDir({ 'SKILL.md': 'config: !!js ctx.secret\n' })
    const r = scan({ surface: 'skill', skill_dir: dir, mount: 'skills/s' }, boundaries, taskIds)
    expect(codes(r)).toEqual(['JS_EXPR'])
  })

  it('reports a missing snapshot dir', () => {
    const r = scan({ surface: 'skill', skill_dir: '/nonexistent/skill', mount: 'skills/s' }, boundaries, taskIds)
    expect(codes(r)).toEqual(['SKILL_DIR_MISSING'])
  })

  it('rejects a surface the pack did not declare', () => {
    const r = scan({ surface: 'memory', rows: [] }, boundaries, taskIds)
    expect(codes(r)).toEqual(['SURFACE_UNDECLARED'])
  })
})

describe('scan: config patches', () => {
  it('accepts declared keys on a champion row', () => {
    const r = scan({ surface: 'route', rows: [{ id: 'agent-default-model', config: { model: 'm2' } }] }, boundaries, taskIds)
    expect(r.ok).toBe(true)
  })

  it('rejects an undeclared config key', () => {
    const r = scan({ surface: 'route', rows: [{ id: 'agent-default-model', config: { model: 'm2', temperature: 0 } }] }, boundaries, taskIds)
    expect(codes(r)).toEqual(['CONFIG_KEY_UNDECLARED'])
    expect(r.violations[0]!.where).toBe('agent-default-model.temperature')
  })

  it('rejects rows targeting fixed points and their storage', () => {
    for (const id of ['ledger', 'gate-default', 'signoff', 'book', 'storage-sqlite', 'pack-truth', 'my-score']) {
      const r = scan({ surface: 'route', rows: [{ id, config: {} }] }, { route: { config_keys: [id] } }, taskIds)
      expect(codes(r), id).toContain('ROW_FORBIDDEN')
    }
  })

  it('rejects disabling or renaming a champion row', () => {
    const r = scan({ surface: 'route', rows: [{ id: 'agent-default-model', disabled: true }] }, boundaries, taskIds)
    expect(codes(r)).toEqual(['ROW_KEY_NOT_ALLOWED'])
  })

  it('rejects a task id literal inside row config', () => {
    const r = scan({ surface: 'route', rows: [{ id: 'agent-default-model', config: { model: 'task-0017-tuned' } }] }, boundaries, taskIds)
    expect(codes(r)).toEqual(['TASK_LITERAL'])
  })

  it('rejects a !!js expression node inside rows (E3)', () => {
    const r = scan({ surface: 'route', rows: [{ id: 'agent-default-model', config: { model: { __jsExpr: 'ctx.x' } } }] }, boundaries, taskIds)
    expect(codes(r)).toEqual(['JS_EXPR'])
  })

  it('rejects an inserted entry that injects a fixed point, its storage, or a service that writes them', () => {
    for (const inject of [['ledger'], ['signoff'], ['gate'], ['storage-json'], ['lifecycle'], ['champion'], { ledger: true }, { book: { required: false } }]) {
      const r = scan({ surface: 'tools', rows: [{ insert: [{ id: 'extra-tool', name: 'some-plugin', inject } as never] }] }, boundaries, taskIds)
      expect(codes(r), JSON.stringify(inject)).toContain('ROW_FORBIDDEN')
      expect(r.violations.find(v => v.code === 'ROW_FORBIDDEN')?.where).toBe('rows[0].insert[0].inject')
    }
    const ok = scan({ surface: 'tools', rows: [{ insert: [{ id: 'extra-tool', name: 'some-plugin', inject: ['logger', 'http'] }] }] }, boundaries, taskIds)
    expect(ok.ok).toBe(true)
  })

  it('admits an insert only for a whole-row declared id', () => {
    const ok = scan({ surface: 'tools', rows: [{ insert: [{ id: 'extra-tool', name: 'some-plugin' }] }] }, boundaries, taskIds)
    expect(ok.ok).toBe(true)
    const bad = scan({ surface: 'tools', rows: [{ insert: [{ id: 'other-tool', name: 'some-plugin' }] }] }, boundaries, taskIds)
    expect(codes(bad)).toEqual(['CONFIG_KEY_UNDECLARED'])
    const noId = scan({ surface: 'tools', rows: [{ insert: [{ name: 'some-plugin' } as never] }] }, boundaries, taskIds)
    expect(codes(noId)).toEqual(['ROW_UNTARGETED'])
  })
})

describe('leafPaths', () => {
  it('flattens nested objects and keeps arrays as leaves', () => {
    expect(leafPaths({ a: { b: 1, c: [1, 2] }, d: 'x', e: {} })).toEqual(['a.b', 'a.c', 'd', 'e'])
  })
})
