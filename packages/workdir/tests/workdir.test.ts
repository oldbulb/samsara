import { afterEach, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { loadPack } from '@samsara/pack'
import { materialize, workdirDiff, denyGuard, hashDir, WorkdirError, type Workdir } from '../src/index.ts'

const MINI = resolve(import.meta.dirname, '..', '..', 'pack', 'tests', 'fixtures', 'minipack')
const pack = loadPack(MINI)
const skill = { name: pack.manifest.skill.name, dir: pack.skillDir }

let baseDir: string
const made: Workdir[] = []
afterEach(async () => {
  for (const w of made.splice(0)) await w.dispose()
  rmSync(baseDir, { recursive: true, force: true })
})

async function make(attemptId = 'a1', extra: Partial<Parameters<typeof materialize>[0]> = {}) {
  baseDir ??= mkdtempSync(resolve(tmpdir(), 'workdir-'))
  const w = await materialize({ attemptId, taskId: 's1', challengerId: 'c1', pack, skill, baseDir, ...extra })
  made.push(w)
  return w
}

describe('materialize', () => {
  it('seals the attempt dir: skill snapshot, token 0400, tmpdir', async () => {
    const w = await make('a1', { extraSkillDirs: ['.claude/skills'] })
    expect(w.path).toBe(resolve(baseDir, 'a1'))
    expect(readFileSync(resolve(w.path, '.agents/skills/mini/SKILL.md'), 'utf8')).toBe(
      readFileSync(resolve(MINI, 'skill/SKILL.md'), 'utf8'),
    )
    expect(existsSync(resolve(w.path, '.claude/skills/mini/SKILL.md'))).toBe(true)
    expect(statSync(w.tokenPath).mode & 0o777).toBe(0o400)
    const token = JSON.parse(readFileSync(w.tokenPath, 'utf8'))
    expect(token).toMatchObject({ attemptId: 'a1', taskId: 's1', challengerId: 'c1' })
    expect(typeof token.issuedAt).toBe('string')
    expect(w.tmpdir).toBe(resolve(w.path, '.tmp'))
    expect(statSync(w.tmpdir).isDirectory()).toBe(true)
    expect(w.baseline.has('.agents/skills/mini/SKILL.md')).toBe(true)
    expect(w.baseline.has('.task/token.json')).toBe(true)
  })
  it('skill sha is content-addressed and stable', async () => {
    const a = await make('a1')
    const b = await make('a2')
    expect(a.skillSha).toBe(b.skillSha)
    expect(a.skillSha).toBe(hashDir(pack.skillDir))
    expect(a.skillSha).toMatch(/^[0-9a-f]{64}$/)
  })
  it('refuses an existing attempt dir', async () => {
    await make('a1')
    await expect(make('a1')).rejects.toBeInstanceOf(WorkdirError)
  })
  it('dispose removes the attempt dir and is idempotent', async () => {
    const w = await make('a1')
    await w.dispose()
    expect(existsSync(w.path)).toBe(false)
    await w.dispose()
  })
})

describe('workdirDiff', () => {
  it('detects an edited, added and removed file', async () => {
    const w = await make('a1')
    expect(workdirDiff(w.path, w.baseline)).toEqual({ added: [], modified: [], removed: [] })
    writeFileSync(resolve(w.path, '.agents/skills/mini/SKILL.md'), 'changed\n')
    writeFileSync(resolve(w.path, 'out.json'), '{}')
    writeFileSync(resolve(w.tmpdir, 'scratch'), 'ignored')
    rmSync(resolve(w.path, '.claude'), { recursive: true, force: true })
    expect(workdirDiff(w.path, w.baseline)).toEqual({
      added: ['out.json'],
      modified: ['.agents/skills/mini/SKILL.md'],
      removed: [],
    })
  })
})

describe('denyGuard', () => {
  const guard = denyGuard(['rm -rf', 'token\\.json', '[unclosed'])
  it('matches substrings and regexes', () => {
    expect(guard('{"command":"rm -rf /"}')).toMatch(/rm -rf/)
    expect(guard('{"path":".task/token.json"}')).toMatch(/token/)
    expect(guard('{"x":"[unclosed"}')).toMatch(/unclosed/)
    expect(guard('{"command":"ls"}')).toBeUndefined()
  })
})
