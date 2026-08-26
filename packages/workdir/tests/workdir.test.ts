import { afterEach, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname } from 'node:path'
import type { Environment } from '@oldbulb/samsara-environments'
import { loadPack, protectedPaths } from '@oldbulb/samsara-pack'
import { materialize, policyPaths, workdirDiff, denyGuard, hashDir, WorkdirError, type Workdir } from '../src/index.ts'

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
  const w = await materialize({ attemptId, taskId: 's1', challengerId: 'c1', sample: 0, pack, skill, baseDir, ...extra })
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
    expect(token).toMatchObject({ attemptId: 'a1', taskId: 's1', challengerId: 'c1', sample: 0, skill_path: '.agents/skills/mini' })
    expect(typeof token.issuedAt).toBe('string')
    expect(existsSync(resolve(w.path, token.skill_path, 'SKILL.md'))).toBe(true)
    expect(w.tmpdir).toBe(resolve(w.path, '.tmp'))
    expect(statSync(w.tmpdir).isDirectory()).toBe(true)
    expect(w.baseline.has('.agents/skills/mini/SKILL.md')).toBe(true)
    expect(w.baseline.has('.task/token.json')).toBe(true)
  })
  it('the token carries the sample it was sealed with', async () => {
    const w = await make('a3', { sample: 3 })
    expect(JSON.parse(readFileSync(w.tokenPath, 'utf8')).sample).toBe(3)
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
  it('exposes the sandbox policy paths: workdir, pack dir, the declared runtime roots that exist, the protected pack paths', async () => {
    const w = await make('a1')
    expect(w.policyPaths).toEqual({ workdir: w.path, packDir: resolve(MINI), runtimeDirs: [], packDenied: protectedPaths(pack) })
    expect(w.policyPaths.packDenied).toEqual(['bin/materialize', 'bin/score', 'bin/truth', 'contract.schema.json', 'pack.yaml', 'tasks/holdin.jsonl', 'tasks/holdout.jsonl', 'tasks/smoke.jsonl'])
    const runtimePack = resolve(import.meta.dirname, 'fixtures', 'runtime-pack')
    const withRuntime = policyPaths(w.path, { ...pack, dir: runtimePack, manifest: { ...pack.manifest, runtime: { dirs: ['runtime/py', 'runtime/missing', 'runtime/notes.txt'] } } })
    expect(withRuntime.runtimeDirs).toEqual([resolve(runtimePack, 'runtime', 'py')])
    // Undeclared, nothing under the pack is granted: the framework assumes no layout.
    expect(policyPaths(w.path, { ...pack, dir: runtimePack }).runtimeDirs).toEqual([])
  })
  it('dispose removes the attempt dir and is idempotent', async () => {
    const w = await make('a1')
    await w.dispose()
    expect(existsSync(w.path)).toBe(false)
    await w.dispose()
  })
  it('with an environment: the sealed files are put into its workdir, path names that side, the host copy stays as localPath', async () => {
    const remote = mkdtempSync(resolve(tmpdir(), 'workdir-env-'))
    const puts: [string, string][] = []
    const environment = {
      id: 'e1', provider: 'fake', workdir: remote,
      async put(localPath: string, remotePath: string) {
        puts.push([localPath, remotePath])
        mkdirSync(dirname(resolve(remote, remotePath)), { recursive: true })
        cpSync(localPath, resolve(remote, remotePath), { recursive: true })
      },
    } as unknown as Environment
    try {
      const w = await make('a1', { extraSkillDirs: ['.claude/skills'], environment })
      expect(w.path).toBe(remote)
      expect(w.localPath).toBe(resolve(baseDir, 'a1'))
      expect(w.tmpdir).toBe(resolve(remote, '.tmp'))
      expect(puts.map(([local, rel]) => [local, rel])).toEqual(['.agents', '.claude', '.task', '.tmp'].map((e) => [resolve(w.localPath, e), e]))
      expect(readFileSync(resolve(remote, '.agents/skills/mini/SKILL.md'), 'utf8')).toBe(readFileSync(resolve(MINI, 'skill/SKILL.md'), 'utf8'))
      expect(JSON.parse(readFileSync(resolve(remote, '.task/token.json'), 'utf8'))).toMatchObject({ attemptId: 'a1', skill_path: '.agents/skills/mini' })
      expect(statSync(resolve(remote, '.tmp')).isDirectory()).toBe(true)
      expect(w.tokenPath).toBe(resolve(w.localPath, '.task/token.json'))
      expect(w.skillSha).toBe(hashDir(pack.skillDir))
      expect(w.baseline.has('.task/token.json')).toBe(true)
      expect(w.policyPaths.workdir).toBe(remote)
      await w.dispose()
      expect(existsSync(w.localPath)).toBe(false)
      expect(existsSync(remote)).toBe(true)
    } finally {
      rmSync(remote, { recursive: true, force: true })
    }
  })

  it('with an environment opened on the attempt dir itself (the local provider): sealed in place, nothing is put, path is localPath; a dir with content in it is still refused', async () => {
    baseDir ??= mkdtempSync(resolve(tmpdir(), 'workdir-'))
    const puts: string[] = []
    const inPlace = (attemptId: string) => {
      const workdir = resolve(baseDir, attemptId)
      mkdirSync(workdir, { recursive: true })
      return { id: attemptId, provider: 'local', workdir, async put(_local: string, remotePath: string) { puts.push(remotePath) } } as unknown as Environment
    }
    const w = await make('a2', { extraSkillDirs: ['.claude/skills'], environment: inPlace('a2') })
    expect(w.path).toBe(resolve(baseDir, 'a2'))
    expect(w.localPath).toBe(w.path)
    expect(w.tmpdir).toBe(resolve(w.path, '.tmp'))
    expect(puts).toEqual([])
    expect(existsSync(resolve(w.path, '.agents/skills/mini/SKILL.md'))).toBe(true)
    expect(w.policyPaths.workdir).toBe(w.path)
    // what a host left behind is not sealed over
    const left = inPlace('a3')
    writeFileSync(resolve(left.workdir, 'stale'), 'x')
    await expect(make('a3', { environment: left })).rejects.toThrow(/attempt dir already exists/)
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
