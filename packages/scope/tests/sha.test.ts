import { describe, expect, it } from 'vitest'
import { canonicalJson, envFacts, envSha, harnessSha, harnessShaOfLayers } from '../src/sha.ts'

describe('harnessSha', () => {
  it('is stable under key order and changes with content', () => {
    const a = harnessSha([{ id: 'x', name: 'p', config: { a: 1, b: 2 } }])
    const b = harnessSha([{ config: { b: 2, a: 1 }, name: 'p', id: 'x' }])
    const c = harnessSha([{ id: 'x', name: 'p', config: { a: 1, b: 3 } }])
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })

  it('hashes what composeEntries produces from patch layers', () => {
    const layers = [[{ insert: [{ id: 'x', name: 'p', config: { a: 1 } }] }], [{ id: 'x', config: { a: 2 } }]]
    expect(harnessShaOfLayers(layers)).toBe(harnessSha([{ id: 'x', name: 'p', config: { a: 2 } }]))
    expect(harnessShaOfLayers(layers)).toBe(harnessShaOfLayers(layers))
  })

  it('canonicalJson drops undefined and sorts keys recursively', () => {
    expect(canonicalJson({ b: { y: 1, x: undefined }, a: [3, { q: 1, p: 2 }] })).toBe('{"a":[3,{"p":2,"q":1}],"b":{"y":1}}')
  })
})

describe('envSha', () => {
  it('depends on env var names, never values, and is stable', () => {
    const base = { PATH: '/usr/bin', TMPDIR: '/tmp', HOME: '/h', SECRET_TOKEN: 'xyz' }
    expect(envSha(base)).toBe(envSha({ ...base, PATH: '/other/bin', SECRET_TOKEN: 'changed' }))
    expect(envSha(base)).not.toBe(envSha({ ...base, DSH_HOME: '/d' }))
    expect(envSha(base)).toBe(envSha({ ...base, HOME: '/elsewhere', ANOTHER_KEY: '1' }))
  })

  it('records only allowlisted names', () => {
    const facts = envFacts({ PATH: 'p', LANG: 'C', DSH_HOME: 'x', DSH_PROFILE: 'y', API_KEY: 'no' })
    expect(facts.envNames).toEqual(['DSH_HOME', 'DSH_PROFILE', 'LANG', 'PATH'])
    expect(JSON.stringify(facts)).not.toContain('API_KEY')
    expect(facts.dshPin).toBeTruthy()
  })
})
