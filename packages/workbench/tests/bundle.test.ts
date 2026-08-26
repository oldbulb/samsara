// The workbench bundle patch composed over the layers `profiles/workbench`
// boots — dsh-base, dsh-web-app (both reduced to their patch shape in
// tests/fixtures/dsh-layers.yml), the samsara bundle and the profile's own
// patch — at the YAML level, exactly as boot does (`composeEntries`): every
// id unique (the loader rejects a duplicate before it reads `disabled`), the
// host rows the workbench injects present, the CLI rows and the samsara
// bundle's own webserver and storage rows disabled, the ledger domain routed
// to sqlite through dsh-web-app's facility, the workbench rows inserted, the
// preset default set, and nothing else touched. The profile layer is the
// tracked template (`cordis.patch.example.yml`): the real `cordis.patch.yml`
// is gitignored deployment state and absent on a fresh clone and in CI.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'
import { composeEntries, type EntryOptions, type PatchOptions } from '@oldbulb/samsara-kernel'

const SAMSARA = resolve(import.meta.dirname, '..', '..', 'bundle', 'cordis.patch.yml')
const WORKBENCH = resolve(import.meta.dirname, '..', 'cordis.patch.yml')
const PROFILE = resolve(import.meta.dirname, '..', '..', '..', 'profiles', 'workbench')
const layer = (path: string) => parse(readFileSync(path, 'utf8')) as PatchOptions[]
const DSH = parse(readFileSync(resolve(import.meta.dirname, 'fixtures', 'dsh-layers.yml'), 'utf8')) as Record<string, PatchOptions[]>

/** The bundle order the profile manifest declares. */
const BUNDLES = (JSON.parse(readFileSync(resolve(PROFILE, 'package.json'), 'utf8')) as { dsh: { profile: { bundles: string[] } } }).dsh.profile.bundles

/** The services the workbench rows and the operator preset inject, and the host rows that provide them. */
const HOST_ROWS = ['agent', 'session', 'tools', 'commands', 'jobs', 'approval', 'agent-default-model', 'agent-presets', 'llm-deepseek', 'storage', 'storage-domain', 'webserver']

function ids(entries: EntryOptions[]): string[] {
  return entries.flatMap((e) => [e.id!, ...(e.group && Array.isArray(e.config) ? ids(e.config as EntryOptions[]) : [])])
}

function byId(entries: EntryOptions[]): Map<string, EntryOptions[]> {
  const map = new Map<string, EntryOptions[]>()
  for (const e of entries) map.set(e.id!, [...(map.get(e.id!) ?? []), e])
  return map
}

describe('the workbench profile composed as boot composes it', () => {
  const warnings: string[] = []
  const layers = [...BUNDLES.map((b) => (b === '@oldbulb/samsara' ? layer(SAMSARA) : b === '@oldbulb/samsara-workbench' ? layer(WORKBENCH) : DSH[b]!)), layer(resolve(PROFILE, 'cordis.patch.example.yml'))]
  const entries = composeEntries(layers, (m) => warnings.push(m))
  const rows = byId(entries)

  it('boots dsh-base first: the host rows every workbench row injects are in the composition', () => {
    expect(BUNDLES).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@oldbulb/samsara', '@oldbulb/samsara-workbench'])
    for (const id of HOST_ROWS) expect(rows.get(id), id).toHaveLength(1)
  })

  it('composes without a warning: every patched id exists', () => {
    expect(warnings).toEqual([])
  })

  it('has no duplicate id: the loader throws on one before it reads `disabled`', () => {
    const all = ids(entries)
    expect(all.filter((id, i) => all.indexOf(id) !== i)).toEqual([])
  })

  it('disables the CLI rows and the samsara bundle\'s own webserver and storage rows', () => {
    for (const id of ['samsara-run-startup', 'samsara-runner', 'samsara-webserver', 'samsara-storage', 'samsara-storage-domain']) expect(rows.get(id)![0]!.disabled, id).toBe(true)
    expect(rows.get('webserver')![0]).toMatchObject({ name: '@deepseek-ai/dsh-host-webserver' })
    expect(rows.get('webserver')![0]!.disabled).toBeUndefined()
  })

  it('routes the ledger domain to sqlite through dsh-web-app\'s storage facility', () => {
    expect(rows.get('storage-domain')![0]!.config).toEqual({ backend: 'json', routes: { samsara_ledger: 'sqlite' } })
    expect(rows.get('storage-sqlite')![0]).toMatchObject({ name: '@deepseek-ai/dsh-storage-sqlite', inject: ['storage'] })
    expect(rows.get('storage-sqlite')![0]!.disabled).toBeUndefined()
  })

  it('sets the preset default and keeps roots for the CLI', () => {
    expect(rows.get('agent-presets')![0]!.config).toEqual({ default: 'samsara-operator' })
  })

  it('inserts the five workbench rows after the samsara rows', () => {
    const order = entries.map((e) => e.id)
    expect(order.slice(-5)).toEqual(['workbench-executor', 'workbench-commands', 'workbench-notebook', 'workbench-startup', 'workbench-presets'])
    // the attempt executor is a host row (the lifecycle reads it for the life of the host), never the per-session tools row
    expect(rows.get('workbench-executor')![0]).toEqual({ id: 'workbench-executor', name: '@oldbulb/samsara-workbench/executor' })
    expect(rows.get('workbench-commands')![0]).toMatchObject({ name: '@oldbulb/samsara-workbench/commands', inject: ['commands', 'lifecycle', 'ledger', 'signoff', 'champion'] })
    expect(rows.get('workbench-notebook')![0]).toMatchObject({ name: '@oldbulb/samsara-workbench/notebook', inject: ['ledger'] })
    expect(rows.get('workbench-startup')![0]).toMatchObject({ name: '@oldbulb/samsara-workbench/startup', inject: ['lifecycle', 'ledger'] })
    expect(rows.get('workbench-presets')![0]).toMatchObject({ name: '@oldbulb/samsara-workbench/presets' })
    expect(order.indexOf('lifecycle')).toBeLessThan(order.indexOf('workbench-commands'))
  })

  it('leaves every other samsara row as the samsara patch wrote it', () => {
    const alone = byId(composeEntries([DSH['@deepseek-ai/dsh-base']!, DSH['@deepseek-ai/dsh-web-app']!, layer(SAMSARA)]))
    const touched = ['samsara-run-startup', 'samsara-runner', 'samsara-webserver', 'samsara-storage', 'samsara-storage-domain', 'storage-domain', 'agent-presets', 'llm-deepseek', 'agent-default-model', 'loops-dsh', 'proposer-claude-p', 'champion']
    for (const [id, before] of alone) {
      if (touched.includes(id)) continue
      expect(rows.get(id), id).toEqual(before)
    }
  })

  it('is plain data: no !!js in the workbench patch', () => {
    expect(readFileSync(WORKBENCH, 'utf8')).not.toContain('!!js')
  })
})
