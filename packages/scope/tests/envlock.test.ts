import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { envLock, findRepoRoot, packRuntimeLocks, venvListing } from '../src/envlock.ts'

function fixture() {
  const root = mkdtempSync(join(process.env['TMPDIR'] ?? tmpdir(), 'envlock-'))
  writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  const pack = join(root, 'packs', 'p')
  mkdirSync(join(pack, 'runtime', 'py', '.venv', 'lib', 'python3.12', 'site-packages', 'foo-1.0.dist-info'), { recursive: true })
  mkdirSync(join(pack, 'runtime', 'js', 'node_modules', 'x'), { recursive: true })
  writeFileSync(join(pack, 'runtime', 'py', 'requirements.txt'), 'foo==1.0\n')
  writeFileSync(join(pack, 'runtime', 'py', '.venv', 'pyvenv.cfg'), 'home = /usr/bin\n')
  writeFileSync(join(pack, 'runtime', 'py', '.venv', 'lib', 'python3.12', 'site-packages', 'foo-1.0.dist-info', 'METADATA'), 'Metadata-Version: 2.1\nName: foo\nVersion: 1.0\n')
  writeFileSync(join(pack, 'runtime', 'js', 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  writeFileSync(join(pack, 'runtime', 'js', 'node_modules', 'x', 'package-lock.json'), '{}')
  return { root, pack }
}

const env = { PATH: '/nowhere', SECRET_TOKEN: 'xyz', DSH_HOME: '/d' }

describe('envLock', () => {
  it('is deterministic and lists lock files and venv distributions, skipping node_modules', () => {
    const { root, pack } = fixture()
    const a = envLock({ repoRoot: root, packDir: pack, loops: ['dsh'], env })
    const b = envLock({ repoRoot: root, packDir: pack, loops: ['dsh'], env })
    expect(a.sha).toBe(b.sha)
    expect(a.sha).toMatch(/^[0-9a-f]{64}$/)
    expect(Object.keys(a.inputs.packRuntimeLocks)).toEqual(['runtime/js/pnpm-lock.yaml', 'runtime/py/.venv', 'runtime/py/requirements.txt'])
    expect(a.inputs.pnpmLock).toMatch(/^[0-9a-f]{64}$/)
    expect(a.inputs.envNames).toEqual(['DSH_HOME', 'PATH'])
    expect(a.inputs.claudeVersion).toBeUndefined()
    expect(venvListing(join(pack, 'runtime', 'py', '.venv'))).toEqual(['foo==1.0'])
  })

  it('changes when a lock file, a venv distribution or the repo lock changes', () => {
    const { root, pack } = fixture()
    const base = envLock({ repoRoot: root, packDir: pack, loops: ['dsh'], env }).sha
    writeFileSync(join(pack, 'runtime', 'py', 'requirements.txt'), 'foo==1.1\n')
    const afterReq = envLock({ repoRoot: root, packDir: pack, loops: ['dsh'], env }).sha
    expect(afterReq).not.toBe(base)
    writeFileSync(join(pack, 'runtime', 'py', '.venv', 'lib', 'python3.12', 'site-packages', 'foo-1.0.dist-info', 'METADATA'), 'Name: foo\nVersion: 1.1\n')
    const afterVenv = envLock({ repoRoot: root, packDir: pack, loops: ['dsh'], env }).sha
    expect(afterVenv).not.toBe(afterReq)
    writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 10\n')
    expect(envLock({ repoRoot: root, packDir: pack, loops: ['dsh'], env }).sha).not.toBe(afterVenv)
  })

  it('excludes env values and honours claudeVersion / imageDigest inputs', () => {
    const { root, pack } = fixture()
    const a = envLock({ repoRoot: root, packDir: pack, loops: ['dsh'], env })
    const b = envLock({ repoRoot: root, packDir: pack, loops: ['dsh'], env: { ...env, PATH: '/elsewhere', SECRET_TOKEN: 'changed' } })
    expect(a.sha).toBe(b.sha)
    expect(JSON.stringify(a)).not.toContain('xyz')
    const cc = envLock({ repoRoot: root, packDir: pack, loops: ['dsh', 'claude-code'], env, claudeVersion: '1.0.0 (Claude Code)' })
    expect(cc.inputs.claudeVersion).toBe('1.0.0 (Claude Code)')
    expect(cc.sha).not.toBe(a.sha)
    const img = envLock({ repoRoot: root, packDir: pack, loops: ['dsh'], env: { ...env, SAMSARA_IMAGE_DIGEST: 'sha256:abc' } })
    expect(img.inputs.imageDigest).toBe('sha256:abc')
    expect(img.sha).not.toBe(a.sha)
    expect(packRuntimeLocks(join(root, 'nopack'))).toEqual({})
  })

  it('findRepoRoot walks up to pnpm-lock.yaml', () => {
    const { root, pack } = fixture()
    expect(findRepoRoot(pack)).toBe(root)
  })
})
