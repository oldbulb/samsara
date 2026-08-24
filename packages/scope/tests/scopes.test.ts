import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, Group, Loader, type Fiber } from '@oldbulb/samsara-kernel'
import { ScopeManager, ScopeError, SCOPE_GROUP_PREFIX, type Challenger } from '../src/index.ts'

const here = dirname(fileURLToPath(import.meta.url))
const NOOP = './fixtures/noop-plugin.mjs'
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex')

const boundaries = { route: { config_keys: ['champ.model'] }, skill: { globs: ['skills/**'] }, tools: { config_keys: ['added'] } }

function challenger(id: string, rows: Challenger['patch'] = { surface: 'route', rows: [{ id: 'champ', config: { model: 'm2' } }] }): Challenger {
  return { id, patch: rows, boundaries, taskIds: ['task-1'] }
}

/** A bare Context with the loader mounted on an in-memory root holding one champion row. */
async function hostWithLoader(): Promise<{ ctx: Context; loader: Loader; fiber: Fiber }> {
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(here).href + '/'
  await ctx.plugin(Loader)
  const loader = ctx.loader
  loader.builtins.group = Group
  await loader.create({ id: 'champ', name: NOOP, config: { model: 'm1', keep: true } } as never, null)
  const fiber = await ctx.plugin(ScopeManager)
  return { ctx, loader, fiber }
}

const tmp: string[] = []
afterEach(() => { for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('ScopeManager with the loader', () => {
  it('rejects before creating anything', async () => {
    const { ctx, loader } = await hostWithLoader()
    const before = [...loader.entries()].length
    await expect(ctx.scopes.open(challenger('c', { surface: 'route', rows: [{ id: 'champ', config: { secret: 1 } }] })))
      .rejects.toMatchObject({ code: 'PATCH_REJECTED', violations: [{ code: 'CONFIG_KEY_UNDECLARED' }] })
    expect([...loader.entries()].length).toBe(before)
    expect(ctx.scopes.size()).toBe(0)
  })

  it('mounts a patched copy of the champion row in a scope group and disposes it', async () => {
    const { ctx, loader } = await hostWithLoader()
    const scope = await ctx.scopes.open(challenger('c1'))
    expect(ctx.scopes.size()).toBe(1)
    expect(scope.entryIds[0]).toBe(`${SCOPE_GROUP_PREFIX}${scope.scopeId}`)
    expect(scope.unappliedRows).toEqual([])
    expect(scope.ctx).not.toBe(ctx)
    // the champion row is untouched; the scope row carries the merged config
    expect(loader.resolve('champ').options.config).toEqual({ model: 'm1', keep: true })
    const row = loader.resolve(scope.entryIds[1]!)
    expect(row.options).toMatchObject({ name: NOOP, config: { model: 'm2', keep: true } })
    expect((globalThis as { __samsaraNoopConfigs?: unknown[] }).__samsaraNoopConfigs?.at(-1)).toEqual({ model: 'm2', keep: true })
    expect(scope.harnessSha).toMatch(/^[0-9a-f]{64}$/)
    expect(scope.envSha).toMatch(/^[0-9a-f]{64}$/)
    await scope.dispose()
    await scope.dispose()
    expect(ctx.scopes.size()).toBe(0)
    expect(() => loader.resolve(scope.entryIds[0]!)).toThrow()
    expect(loader.resolve('champ').fiber).toBeDefined()
  })

  it('throws ROW_NOT_FOUND for a row the champion does not have', async () => {
    const { ctx } = await hostWithLoader()
    const c: Challenger = { id: 'c', patch: { surface: 'route', rows: [{ id: 'ghost', config: {} }] }, boundaries: { route: { config_keys: ['ghost'] } }, taskIds: [] }
    await expect(ctx.scopes.open(c)).rejects.toBeInstanceOf(ScopeError)
    await expect(ctx.scopes.open(c)).rejects.toMatchObject({ code: 'ROW_NOT_FOUND' })
    expect(ctx.scopes.size()).toBe(0)
  })

  it('inserts declared rows and a skill patch hashes its snapshot', async () => {
    const { ctx, loader } = await hostWithLoader()
    const ins = await ctx.scopes.open(challenger('ins', { surface: 'tools', rows: [{ insert: [{ id: 'added', name: NOOP, config: { k: 1 } }] }] }))
    expect(loader.resolve(ins.entryIds[1]!).options.id).toBe('added')
    await ins.dispose()

    const dir = mkdtempSync(join(tmpdir(), 'samsara-scope-skill-'))
    tmp.push(dir)
    mkdirSync(join(dir, 'scripts'))
    writeFileSync(join(dir, 'SKILL.md'), '# s\n')
    const sk = await ctx.scopes.open(challenger('sk', { surface: 'skill', skill_dir: dir, mount: 'skills/s' }))
    expect(sk.skillDir).toBe(dir)
    expect(sk.skillSha).toMatch(/^[0-9a-f]{64}$/)
    expect(sk.entryIds).toEqual([`${SCOPE_GROUP_PREFIX}${sk.scopeId}`])
    await sk.dispose()
    expect(ctx.scopes.size()).toBe(0)
  })

  it('E1: 100 open/dispose cycles leave the registry and the profile file untouched', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'samsara-scope-profile-'))
    tmp.push(dir)
    const patchFile = join(dir, 'cordis.patch.yml')
    writeFileSync(patchFile, '- id: champ\n  config:\n    model: m1\n')
    const fileSha = sha(patchFile)

    const { ctx, loader } = await hostWithLoader()
    const entriesBefore = [...loader.entries()].map(e => e.id)
    const harness = ctx.scopes.championRows()
    for (let i = 0; i < 100; i++) {
      const scope = await ctx.scopes.open(challenger(`cyc-${i}`))
      expect(ctx.scopes.size()).toBe(1)
      expect(scope.harnessSha).toBe(await ctx.scopes.open(challenger('probe')).then(async p => { await p.dispose(); return p.harnessSha }))
      await scope.dispose()
    }
    expect(ctx.scopes.size()).toBe(0)
    expect([...loader.entries()].map(e => e.id)).toEqual(entriesBefore)
    expect(ctx.scopes.championRows()).toEqual(harness)
    expect(sha(patchFile)).toBe(fileSha)
    await ctx.plugin(function noop() {}).dispose()
  })

  it('disposes every open scope when the service unmounts', async () => {
    const { ctx, loader, fiber } = await hostWithLoader()
    const a = await ctx.scopes.open(challenger('a'))
    const b = await ctx.scopes.open(challenger('b'))
    await fiber.dispose()
    expect(() => loader.resolve(a.entryIds[0]!)).toThrow()
    expect(() => loader.resolve(b.entryIds[0]!)).toThrow()
  })
})

describe('ScopeManager without a loader (fallback)', () => {
  it('opens a bare child fiber and reports the rows it could not apply', async () => {
    const ctx = new Context()
    await ctx.plugin(ScopeManager)
    const scope = await ctx.scopes.open(challenger('bare'))
    expect(scope.entryIds).toEqual([])
    expect(scope.unappliedRows).toEqual([{ id: 'champ', config: { model: 'm2' } }])
    expect(scope.ctx).not.toBe(ctx)
    expect(ctx.scopes.size()).toBe(1)
    await scope.dispose()
    expect(ctx.scopes.size()).toBe(0)
  })
})
