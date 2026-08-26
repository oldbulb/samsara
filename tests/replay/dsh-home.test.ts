// The replay test's precondition: it must skip, not fail, when the operator's
// $DSH_HOME has no linked or installed `host` profile.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { dshHome, hostProfileMissing } from './dsh-home.ts'

const tmp = mkdtempSync(join(tmpdir(), 'samsara-dsh-home-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

describe('hostProfileMissing', () => {
  it('resolves $DSH_HOME, else ~/.dsh', () => {
    expect(dshHome({ DSH_HOME: '/elsewhere' }, '/home/u')).toBe('/elsewhere')
    expect(dshHome({}, '/home/u')).toBe('/home/u/.dsh')
    expect(dshHome({ DSH_HOME: '' }, '/home/u')).toBe('/home/u/.dsh')
  })

  it('names the missing link with the README remedy when the profile directory is absent', () => {
    const home = join(tmp, 'empty')
    mkdirSync(home)
    expect(hostProfileMissing({ DSH_HOME: home })).toContain(`ln -s "$PWD/profiles/host" ${join(home, 'profiles', 'host')}`)
  })

  it('names the missing install when the profile is linked but has no node_modules', () => {
    const home = join(tmp, 'linked')
    const profile = join(home, 'profiles', 'host')
    mkdirSync(profile, { recursive: true })
    writeFileSync(join(profile, 'package.json'), '{}\n')
    expect(hostProfileMissing({ DSH_HOME: home })).toContain('dsh plugin --profile host install')
  })

  it('is satisfied by a linked and installed profile', () => {
    const home = join(tmp, 'installed')
    const profile = join(home, 'profiles', 'host')
    mkdirSync(join(profile, 'node_modules'), { recursive: true })
    writeFileSync(join(profile, 'package.json'), '{}\n')
    expect(hostProfileMissing({ DSH_HOME: home })).toBeUndefined()
  })
})
