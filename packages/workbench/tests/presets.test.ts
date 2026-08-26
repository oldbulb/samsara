import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@oldbulb/samsara-kernel'
import { MARKER_FILE, PRESET_ID, SHIPPED_DIR, USER_PRESET_DIR, apply, installPreset, presetRoot, presetSha } from '../src/presets.ts'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'samsara-presets-'))
  dirs.push(d)
  return d
}

/** A source preset directory with the two files dsh reads. */
function source(root: string, text = 'v1'): string {
  const dir = join(root, 'src')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'preset.yml'), `name: t\n`)
  writeFileSync(join(dir, 'agent.cordis.yml'), `- id: persona\n  config:\n    text: ${text}\n`)
  return dir
}

describe('installPreset', () => {
  it('installs, then is unchanged, then updates when the shipped hash changes', () => {
    const root = tmp()
    const from = source(root)
    const to = join(root, 'presets', PRESET_ID)
    expect(installPreset(from, to)).toBe('installed')
    expect(readFileSync(join(to, 'agent.cordis.yml'), 'utf8')).toContain('v1')
    expect(readFileSync(join(to, MARKER_FILE), 'utf8').trim()).toBe(presetSha(from))
    expect(installPreset(from, to)).toBe('unchanged')
    // the marker is not part of the hash, so the installed copy hashes like the source
    expect(presetSha(to)).toBe(presetSha(from))

    writeFileSync(join(from, 'agent.cordis.yml'), `- id: persona\n  config:\n    text: v2\n`)
    expect(installPreset(from, to)).toBe('updated')
    expect(readFileSync(join(to, 'agent.cordis.yml'), 'utf8')).toContain('v2')
    expect(readFileSync(join(to, MARKER_FILE), 'utf8').trim()).toBe(presetSha(from))
    expect(existsSync(`${to}.tmp-${process.pid}`)).toBe(false)
  })

  it('never overwrites a directory without the marker', () => {
    const root = tmp()
    const from = source(root)
    const to = join(root, 'presets', PRESET_ID)
    mkdirSync(to, { recursive: true })
    writeFileSync(join(to, 'agent.cordis.yml'), 'mine')
    expect(installPreset(from, to)).toBe('kept')
    expect(readFileSync(join(to, 'agent.cordis.yml'), 'utf8')).toBe('mine')
    expect(existsSync(join(to, MARKER_FILE))).toBe(false)
  })

  it('hashes by relative path and content, in a stable order', () => {
    const root = tmp()
    const a = source(join(root, 'a'))
    const b = source(join(root, 'b'))
    expect(presetSha(a)).toBe(presetSha(b))
    writeFileSync(join(b, 'extra.yml'), '')
    expect(presetSha(a)).not.toBe(presetSha(b))
  })
})

describe('the shipped preset', () => {
  it('has the metadata and the rows the spec names, and no shell/fs/web tool', () => {
    const meta = parse(readFileSync(join(SHIPPED_DIR, 'preset.yml'), 'utf8')) as Record<string, unknown>
    expect(meta).toEqual({ name: 'samsara operator', description: 'runs RSI experiments on samsara through tools; consent stays in /samsara commands', order: 50 })
    const rows = parse(readFileSync(join(SHIPPED_DIR, 'agent.cordis.yml'), 'utf8')) as { id: string; name: string; config?: unknown; isolate?: unknown }[]
    expect(rows.map((r) => r.name)).toEqual(['@deepseek-ai/dsh-persona', '@deepseek-ai/dsh-tool-jobs', '@deepseek-ai/dsh-tool-ask-user', '@deepseek-ai/dsh-tool-todo', 'cordis:group'])
    const persona = (rows[0]!.config as { text: string }).text
    for (const phrase of ['samsara_* tools only', 'comes from a tool result', 'never simulate', '/samsara commands', 'next_actions']) expect(persona).toContain(phrase)
    const group = rows[4]!
    expect(group.isolate).toEqual({ samsaraWorkbench: true })
    expect(group.config).toEqual([{ id: 'workbench-tools', name: '@oldbulb/samsara-workbench/tools', inject: ['lifecycle', 'ledger', 'jobs', 'approval'] }])
    const text = readFileSync(join(SHIPPED_DIR, 'agent.cordis.yml'), 'utf8')
    for (const banned of ['dsh-tool-bash', 'dsh-tool-fs', 'dsh-tool-web', 'dsh-fs-local', '!!js']) expect(text).not.toContain(banned)
  })
})

describe('workbench-presets plugin', () => {
  it('installs the shipped preset under the configured root on apply', async () => {
    const root = tmp()
    const ctx = new Context()
    await ctx.plugin({ name: 'workbench-presets', apply }, { root })
    const to = join(root, PRESET_ID)
    expect(readFileSync(join(to, 'preset.yml'), 'utf8')).toBe(readFileSync(join(SHIPPED_DIR, 'preset.yml'), 'utf8'))
    expect(readFileSync(join(to, MARKER_FILE), 'utf8').trim()).toBe(presetSha(SHIPPED_DIR))
    await ctx.plugin({ name: 'workbench-presets-again', apply }, { root })
    expect(readFileSync(join(to, MARKER_FILE), 'utf8').trim()).toBe(presetSha(SHIPPED_DIR))
  })

  it('resolves the root from ctx.dshHomePath, then $DSH_HOME, then ~/.dsh', () => {
    const ctx = new Context()
    const home = process.env.DSH_HOME
    try {
      process.env.DSH_HOME = '/dsh-home'
      expect(presetRoot(ctx)).toBe(join('/dsh-home', USER_PRESET_DIR))
      process.env.DSH_HOME = '  '
      expect(presetRoot(ctx)).toMatch(new RegExp(`/\\.dsh/${USER_PRESET_DIR}$`))
      ctx.provide('dshHomePath', (...s: string[]) => join('/from-boot', ...s))
      expect(presetRoot(ctx)).toBe(join('/from-boot', USER_PRESET_DIR))
      expect(presetRoot(ctx, { root: 'rel/presets' })).toBe(join(process.cwd(), 'rel/presets'))
    } finally {
      if (home === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = home
    }
  })
})
