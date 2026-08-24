import { describe, expect, it } from 'vitest'
import { matchesDeny, serializeArgs } from '../src/deny.ts'
import { addUsage, createLimits, priceUsage } from '../src/limits.ts'
import { EventQueue } from '../src/queue.ts'
import { skillBody } from '../src/skill.ts'

describe('limits', () => {
  it('admits maxTurns steps, rejects the next and records max_turns once', () => {
    const l = createLimits({ maxTurns: 2 })
    expect([l.preStep(), l.preStep()]).toEqual(['enter', 'enter'])
    expect(l.preStep()).toBe('reject')
    expect(l.stop).toBe('max_turns')
    expect(l.steps).toBe(2)
    expect(l.trip('timeout')).toBe(false)
    expect(l.stop).toBe('max_turns')
  })

  it('rejects every step once a limit has tripped', () => {
    const l = createLimits({ maxTurns: 5 })
    expect(l.trip('timeout')).toBe(true)
    expect(l.preStep()).toBe('reject')
    expect(l.steps).toBe(0)
  })

  it('trips the budget only with both a ceiling and a price table', () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 0 }
    expect(createLimits({ maxTurns: 1, maxBudgetUsd: 0.5 }).observeUsage(usage)).toBe(false)
    expect(createLimits({ maxTurns: 1, price: { input: 2, output: 2 } }).observeUsage(usage)).toBe(false)
    const l = createLimits({ maxTurns: 1, maxBudgetUsd: 0.5, price: { input: 2, output: 2 } })
    expect(l.observeUsage({ inputTokens: 100_000, outputTokens: 0 })).toBe(false)
    expect(l.observeUsage(usage)).toBe(true)
    expect(l.stop).toBe('budget')
    expect(l.observeUsage(usage)).toBe(false)
  })

  it('sums and prices usage', () => {
    const total = addUsage(addUsage({ inputTokens: 0, outputTokens: 0 }, { inputTokens: 1, outputTokens: 2, reasoningTokens: 3 }), { inputTokens: 4, outputTokens: 5, cacheReadTokens: 6 })
    expect(total).toEqual({ inputTokens: 5, outputTokens: 7, reasoningTokens: 3, cacheReadTokens: 6 })
    // disjoint counts: 2M input at 1, 1M cache read at the input price, 1M output at 3
    expect(priceUsage({ inputTokens: 2_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000 }, { input: 1, output: 3 })).toBe(2 + 1 + 3)
    expect(priceUsage({ inputTokens: 2_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000 }, { input: 1, output: 3, cacheRead: 0.1 })).toBeCloseTo(2 + 0.1 + 3, 10)
    // a cached prefix far larger than the billed input is normal, not a sign of overlap
    expect(priceUsage({ inputTokens: 20_000, outputTokens: 2_000, cacheReadTokens: 100_000 }, { input: 0.44, output: 1.32, cacheRead: 0.014 })).toBeCloseTo((20_000 * 0.44 + 100_000 * 0.014 + 2_000 * 1.32) / 1e6, 12)
  })
})

describe('deny guard', () => {
  it('matches regex patterns, falls back to substring for invalid regexes', () => {
    expect(matchesDeny('{"cmd":"rm -rf /"}', ['rm\\s+-rf'])).toBe('rm\\s+-rf')
    expect(matchesDeny('{"cmd":"ls ("}', ['ls ('])).toBe('ls (')
    expect(matchesDeny('{"cmd":"ls"}', ['rm\\s+-rf', 'curl'])).toBeUndefined()
    expect(serializeArgs({ a: 1 })).toBe('{"a":1}')
    expect(serializeArgs('raw')).toBe('raw')
  })
})

describe('event queue', () => {
  it('delivers pushed items in order and ends after close', async () => {
    const q = new EventQueue<number>()
    q.push(1)
    const it = q[Symbol.asyncIterator]()
    expect(await it.next()).toEqual({ value: 1, done: false })
    const pending = it.next()
    q.push(2)
    expect(await pending).toEqual({ value: 2, done: false })
    q.close()
    q.push(3)
    expect(await it.next()).toEqual({ value: undefined, done: true })
  })
})

describe('skill body', () => {
  it('strips YAML frontmatter and keeps the body', () => {
    expect(skillBody('---\nname: x\nmodel: y\n---\n# Title\nbody\n')).toBe('# Title\nbody')
    expect(skillBody('no frontmatter\n')).toBe('no frontmatter')
  })
})
