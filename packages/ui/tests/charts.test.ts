import { describe, expect, it } from 'vitest'
import { lineageSvg, sparkline, type LineageData } from '../src/charts.ts'

const data: LineageData = {
  metric: 'acc',
  siblings: [
    { id: 'aaaa', round: 0, value: 0.65, ci: [0.55, 0.75], promoted: true, verdict: 'promote' },
    { id: 'bbbb', round: 1, value: 0.7, ci: [0.4, 1.0], verdict: 'hold' },
    { id: 'cccc', round: 1, value: 0.62, verdict: 'drop' },
    { id: 'dddd', round: 2, value: 0.6 },
  ],
  lineages: [{ name: 'main', steps: [{ round: 0, value: 0.65 }] }],
  shadows: [{ round: 1, gate: 'keep-better@0.1.0', verdict: 'promote', id: 'bbbb' }],
  gateChanges: [{ round: 2, label: 'gate-default@2' }],
  prediction: { low: 0.6, high: 0.7, label: 'predicted acc up by 0.1' },
}

const count = (svg: string, re: RegExp) => (svg.match(re) ?? []).length

describe('lineageSvg', () => {
  const svg = lineageSvg(data)

  it('is one inline svg with a viewBox and no external reference', () => {
    expect(svg).toMatch(/^<svg class="lineage" viewBox="0 0 640 220"/)
    expect(svg).toMatch(/<\/svg>$/)
    expect(svg).not.toMatch(/https?:\/\/|xlink|<image/)
  })

  it('draws one dot per sibling in currentColor, promoted ones in the accent with whiskers', () => {
    expect(count(svg, /<circle class="sibling/g)).toBe(4)
    expect(count(svg, /<circle class="sibling" [^>]*fill="currentColor"/g)).toBe(3)
    expect(count(svg, /<circle class="sibling promoted" [^>]*fill="var\(--dsw-alias-state-business-primary\)"/g)).toBe(1)
    expect(count(svg, /<line class="whisker"/g)).toBe(1)
  })

  it('draws one flat baseline path per lineage in the accent, at the baseline value, with a tick per promotion', () => {
    expect(count(svg, /<path class="champion"/g)).toBe(1)
    const d = /<path class="champion" d="([^"]+)"/.exec(svg)![1]!
    // Flat across the whole plot: the dots are deltas against the champion, so it never steps.
    expect(d).toMatch(/^M48 ([\d.]+) H624$/)
    const y0 = Number(/^M48 ([\d.]+)/.exec(d)![1])
    expect(svg).toContain('<title>main: champion baseline 0; promoted r1 by 0.65</title>')
    expect(svg).toContain(`<line class="promotion" x1="144" x2="144" y1="${y0 - 4}" y2="${y0 + 4}"`)
    expect(svg).toContain('<title>main: promoted r1 by 0.65</title>')
    expect(svg).toContain('stroke="var(--dsw-alias-state-business-primary)"')
    // The baseline is on the axis: 0 sits between the lowest and highest label.
    expect(y0).toBeGreaterThan(Number(/y="([\d.]+)" text-anchor="end">1</.exec(svg)![1]))
    expect(lineageSvg({ ...data, lineages: [...data.lineages, { name: 'side', steps: [{ round: 1, value: 0.6 }] }] })).toMatch(/(<path class="champion"[\s\S]*){2}/)
    // Another baseline moves the line, not the marks.
    const shifted = lineageSvg({ ...data, baseline: 0.5 })
    expect(shifted).toContain('<title>main: champion baseline 0.5; promoted r1 by 0.65</title>')
    expect(/<path class="champion" d="M48 ([\d.]+) H624"/.exec(shifted)![1]).not.toBe(String(y0))
  })

  it('marks shadow verdicts as hollow squares under the axis, gate changes as dashed lines with a label, the prediction as a band', () => {
    expect(count(svg, /<rect class="shadow" [^>]*fill="none" stroke="currentColor"/g)).toBe(1)
    expect(svg).toContain('<title>keep-better@0.1.0 (shadow) bbbb r2: promote</title>')
    expect(count(svg, /<g class="gate-change"><line [^>]*stroke-dasharray="4 3"/g)).toBe(1)
    expect(svg).toContain('>gate-default@2</text>')
    expect(count(svg, /<rect class="band"/g)).toBe(1)
    expect(svg).toContain('<title>predicted acc up by 0.1: 0.6 to 0.7</title>')
    // The band is drawn first so every mark sits on top of it.
    expect(svg.indexOf('class="band"')).toBeLessThan(svg.indexOf('class="sibling"'))
  })

  it('lays the shadow squares of one round side by side, each with its own title, wrapping when the column is narrow', () => {
    const three = [
      { round: 1, gate: 'a@1', verdict: 'promote', id: 'bbbb' },
      { round: 1, gate: 'b@1', verdict: 'hold', id: 'bbbb' },
      { round: 1, gate: 'a@1', verdict: 'drop', id: 'cccc' },
    ]
    const out = lineageSvg({ ...data, shadows: three })
    const rects = [...out.matchAll(/<rect class="shadow" x="([\d.]+)" y="([\d.]+)"[^>]*><title>([^<]+)<\/title>/g)].map((m) => [Number(m[1]), Number(m[2]), m[3]] as const)
    expect(rects).toHaveLength(3)
    expect(new Set(rects.map((r) => r[0])).size).toBe(3)
    expect(new Set(rects.map((r) => r[1])).size).toBe(1)
    expect(rects.map((r) => r[2])).toEqual(['a@1 (shadow) bbbb r2: promote', 'b@1 (shadow) bbbb r2: hold', 'a@1 (shadow) cccc r2: drop'])
    // Centred on the round's column, 8px apart.
    expect(rects[1]![0]).toBe(333)
    expect(rects[0]![0]).toBe(325)
    expect(rects[2]![0]).toBe(341)
    // Forty rounds leave 14px per column: one square per row, the rest stacked below.
    const narrow = lineageSvg({ ...data, rounds: 40, shadows: three })
    const ys = [...narrow.matchAll(/<rect class="shadow" x="([\d.]+)" y="([\d.]+)"/g)].map((m) => [m[1], m[2]])
    expect(new Set(ys.map((r) => r[0])).size).toBe(1)
    expect(new Set(ys.map((r) => r[1])).size).toBe(3)
  })

  it('titles every sibling with its numbers and labels the axes in the caption class', () => {
    expect(svg).toContain('<title>aaaa r1: 0.65 [0.55, 0.75] promote</title>')
    expect(svg).toContain('<title>dddd r3: 0.6</title>')
    expect(count(svg, /<text class="axis"[^>]*>r\d<\/text>/g)).toBe(3)
    expect(svg).toContain('>acc</text>')
  })

  it('escapes labels and copes with an empty data set', () => {
    const hostile = lineageSvg({ siblings: [{ id: '<x>', round: 0, value: 1 }], lineages: [] })
    expect(hostile).toContain('&lt;x&gt;')
    expect(hostile).not.toContain('<x>')
    const blank = lineageSvg({ siblings: [], lineages: [] })
    expect(blank).toMatch(/^<svg class="lineage" viewBox="0 0 640 220"/)
    expect(blank).not.toContain('NaN')
  })

  it('honours the given size and round count', () => {
    const small = lineageSvg({ ...data, width: 320, height: 120, rounds: 6 })
    expect(small).toContain('viewBox="0 0 320 120"')
    expect(count(small, /<text class="axis"[^>]*>r\d<\/text>/g)).toBe(6)
  })
})

describe('sparkline', () => {
  it('draws one path in currentColor, none for fewer than two values', () => {
    const svg = sparkline([0.1, 0.5, 0.3, 0.9])
    expect(svg).toMatch(/^<svg class="sparkline" viewBox="0 0 100 24"/)
    expect(svg).toContain('stroke="currentColor"')
    expect(svg).toMatch(/<path d="M[\d.]+ [\d.]+( L[\d.]+ [\d.]+){3}"/)
    expect(sparkline([1])).not.toContain('<path')
    expect(sparkline([])).not.toContain('<path')
    expect(sparkline([2, 2, 2])).not.toContain('NaN')
  })
})
