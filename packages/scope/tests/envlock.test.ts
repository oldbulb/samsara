import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { envLock, findRepoRoot, packRuntimeLocks } from '../src/envlock.ts'

/** A pack with four runtimes; what pins each is what its `runtime.locks` globs say, nothing the framework knows about them. */
function fixture() {
  const root = mkdtempSync(join(process.env['TMPDIR'] ?? tmpdir(), 'envlock-'))
  writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  const pack = join(root, 'packs', 'p')
  mkdirSync(join(pack, 'runtime', 'py', '.venv', 'lib', 'python3.12', 'site-packages', 'foo-1.0.dist-info'), { recursive: true })
  mkdirSync(join(pack, 'runtime', 'js', 'node_modules', 'x'), { recursive: true })
  mkdirSync(join(pack, 'runtime', 'go'), { recursive: true })
  mkdirSync(join(pack, 'runtime', 'rust'), { recursive: true })
  writeFileSync(join(pack, 'runtime', 'py', 'requirements.txt'), 'foo==1.0\n')
  writeFileSync(join(pack, 'runtime', 'py', '.venv', 'lib', 'python3.12', 'site-packages', 'foo-1.0.dist-info', 'METADATA'), 'Metadata-Version: 2.1\nName: foo\nVersion: 1.0\n')
  writeFileSync(join(pack, 'runtime', 'js', 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  writeFileSync(join(pack, 'runtime', 'js', 'node_modules', 'x', 'package-lock.json'), '{}')
  writeFileSync(join(pack, 'runtime', 'go', 'go.sum'), 'example.com/m v1.0.0 h1:abc\n')
  writeFileSync(join(pack, 'runtime', 'rust', 'Cargo.lock'), '[[package]]\nname = "m"\nversion = "1.0.0"\n')
  const locks = ['runtime/py/requirements.txt', 'runtime/py/.venv/lib/*/site-packages/*.dist-info/METADATA', 'runtime/js/pnpm-lock.yaml', 'runtime/go/go.sum', 'runtime/rust/Cargo.lock']
  return { root, pack, locks }
}

const env = { PATH: '/nowhere', SECRET_TOKEN: 'xyz', DSH_HOME: '/d' }

describe('envLock', () => {
  it('is deterministic and hashes exactly the files the pack\'s lock globs name, in every runtime it declares', () => {
    const { root, pack, locks } = fixture()
    const a = envLock({ repoRoot: root, packDir: pack, packLocks: locks, loops: ['dsh'], env })
    const b = envLock({ repoRoot: root, packDir: pack, packLocks: locks, loops: ['dsh'], env })
    expect(a.sha).toBe(b.sha)
    expect(a.sha).toMatch(/^[0-9a-f]{64}$/)
    expect(Object.keys(a.inputs.packRuntimeLocks)).toEqual([
      'runtime/go/go.sum', 'runtime/js/pnpm-lock.yaml', 'runtime/py/.venv/lib/python3.12/site-packages/foo-1.0.dist-info/METADATA', 'runtime/py/requirements.txt', 'runtime/rust/Cargo.lock',
    ])
    expect(a.inputs.pnpmLock).toMatch(/^[0-9a-f]{64}$/)
    expect(a.inputs.envNames).toEqual(['DSH_HOME', 'PATH'])
    expect(a.inputs.claudeVersion).toBeUndefined()
    // Undeclared, nothing of the pack enters the fingerprint: the framework guesses no layout.
    expect(envLock({ repoRoot: root, packDir: pack, loops: ['dsh'], env }).inputs.packRuntimeLocks).toEqual({})
  })

  it('changes when a declared lock file, an installed distribution or the repo lock changes, and not when an undeclared file does', () => {
    const { root, pack, locks } = fixture()
    const lock = () => envLock({ repoRoot: root, packDir: pack, packLocks: locks, loops: ['dsh'], env }).sha
    const base = lock()
    writeFileSync(join(pack, 'runtime', 'py', 'requirements.txt'), 'foo==1.1\n')
    const afterReq = lock()
    expect(afterReq).not.toBe(base)
    writeFileSync(join(pack, 'runtime', 'py', '.venv', 'lib', 'python3.12', 'site-packages', 'foo-1.0.dist-info', 'METADATA'), 'Name: foo\nVersion: 1.1\n')
    const afterVenv = lock()
    expect(afterVenv).not.toBe(afterReq)
    writeFileSync(join(pack, 'runtime', 'go', 'go.sum'), 'example.com/m v1.1.0 h1:def\n')
    const afterGo = lock()
    expect(afterGo).not.toBe(afterVenv)
    writeFileSync(join(pack, 'runtime', 'js', 'node_modules', 'x', 'package-lock.json'), '{"changed":1}')
    expect(lock()).toBe(afterGo)
    writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 10\n')
    expect(lock()).not.toBe(afterGo)
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
    expect(packRuntimeLocks(join(root, 'nopack'), ['**/*.lock'])).toEqual({})
  })

  it('findRepoRoot walks up to pnpm-lock.yaml', () => {
    const { root, pack } = fixture()
    expect(findRepoRoot(pack)).toBe(root)
  })
})
