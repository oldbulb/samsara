// Inline SVG in dsh's idiom: marks in `currentColor`, the accent through the
// `--dsw-alias-state-business-primary` variable, 10px caption axis labels,
// `<title>` tooltips. Pure functions over numbers already read from the
// ledger; nothing here computes a statistic.

export interface LineageSibling {
  /** Row id, in the dot's `<title>`. */
  id: string
  /** x: the round index (0-based). */
  round: number
  /** y: the observed delta against the round's champion, on the one tier the chart is pinned to. */
  value: number
  /** The verdict, in the `<title>`. */
  verdict?: string
  /** Drawn as whiskers on promoted rows. */
  ci?: [number, number]
  promoted?: boolean
}

export interface LineageStep {
  /** The round of the promotion. */
  round: number
  /** The margin the promoted row won: its delta against the champion it replaced. */
  value: number
}

/**
 * The champion is the baseline every sibling is measured against, so in
 * delta space its line is flat at `baseline` (0): each promotion resets the
 * origin instead of moving the line. A promotion is a tick on the baseline;
 * the margin it won is the promoted row's dot.
 */
export interface Lineage {
  name: string
  /** The promotions, in round order. */
  steps: LineageStep[]
}

export interface LineageData {
  siblings: LineageSibling[]
  lineages: Lineage[]
  /** Shadow-gate verdicts: hollow squares under the axis, one per (sibling, gate), laid out within the round's column. */
  shadows?: { round: number; gate: string; verdict: string; id?: string }[]
  /** Gate changes: dashed vertical lines labelled `name@version`. */
  gateChanges?: { round: number; label: string }[]
  /** The predicted magnitude as a horizontal band in metric units. */
  prediction?: { low: number; high: number; label?: string }
  /** The champion's level in y units: 0 in delta space (the default). */
  baseline?: number
  /** Number of rounds on the x axis; the largest round seen + 1 when absent. */
  rounds?: number
  metric?: string
  width?: number
  height?: number
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
const f = (x: number) => Number.isInteger(x) ? String(x) : x.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
const px = (x: number) => Math.round(x * 100) / 100

const ACCENT = 'var(--dsw-alias-state-business-primary)'

/** The lineage curve: sibling dots, the champion baseline per lineage with a tick per promotion, whiskers, shadow markers, gate changes, the prediction band. */
export function lineageSvg(data: LineageData): string {
  const width = data.width ?? 640
  const height = data.height ?? 220
  const baseline = data.baseline ?? 0
  const m = { top: 12, right: 16, bottom: 40, left: 48 }
  const rounds = Math.max(1, data.rounds ?? Math.max(0, ...data.siblings.map((s) => s.round), ...data.lineages.flatMap((l) => l.steps.map((s) => s.round)), ...(data.gateChanges ?? []).map((g) => g.round), ...(data.shadows ?? []).map((s) => s.round)) + 1)

  const ys: number[] = []
  for (const s of data.siblings) { ys.push(s.value); if (s.ci) ys.push(s.ci[0], s.ci[1]) }
  for (const l of data.lineages) { if (l.steps.length) ys.push(baseline); for (const s of l.steps) ys.push(s.value) }
  if (data.prediction) ys.push(data.prediction.low, data.prediction.high)
  let lo = ys.length ? Math.min(...ys) : 0
  let hi = ys.length ? Math.max(...ys) : 1
  if (hi - lo < 1e-9) { lo -= 0.05; hi += 0.05 }
  const pad = (hi - lo) * 0.1
  lo -= pad
  hi += pad

  const plotW = width - m.left - m.right
  const plotH = height - m.top - m.bottom
  // Round r sits at the centre of its column so round 0 is not on the y axis.
  const x = (round: number) => px(m.left + ((round + 0.5) / rounds) * plotW)
  const y = (v: number) => px(m.top + (1 - (v - lo) / (hi - lo)) * plotH)
  const axisY = m.top + plotH
  const parts: string[] = []

  // Prediction band first, under every mark.
  if (data.prediction) {
    const p = data.prediction
    const top = y(Math.max(p.low, p.high))
    const bottom = y(Math.min(p.low, p.high))
    parts.push(`<g class="prediction"><rect class="band" x="${m.left}" y="${top}" width="${px(plotW)}" height="${px(Math.max(1, bottom - top))}" opacity="0.6">`
      + `<title>${esc(p.label ?? 'predicted')}: ${f(p.low)} to ${f(p.high)}</title></rect>`
      + `<line x1="${m.left}" x2="${m.left + plotW}" y1="${top}" y2="${top}" stroke="${ACCENT}" stroke-dasharray="1 3" />`
      + `<line x1="${m.left}" x2="${m.left + plotW}" y1="${bottom}" y2="${bottom}" stroke="${ACCENT}" stroke-dasharray="1 3" /></g>`)
  }

  // Axes and labels.
  parts.push(`<g class="axes"><line x1="${m.left}" x2="${m.left + plotW}" y1="${axisY}" y2="${axisY}" stroke="currentColor" opacity="0.35" />`
    + `<line x1="${m.left}" x2="${m.left}" y1="${m.top}" y2="${axisY}" stroke="currentColor" opacity="0.35" />`
    + [lo + pad, (lo + hi) / 2, hi - pad].map((v) => `<text class="axis" x="${m.left - 6}" y="${y(v) + 3}" text-anchor="end">${f(v)}</text>`).join('')
    + Array.from({ length: rounds }, (_, r) => `<text class="axis" x="${x(r)}" y="${axisY + 12}" text-anchor="middle">r${r + 1}</text>`).join('')
    + (data.metric ? `<text class="axis" x="${m.left}" y="${m.top - 2}">${esc(data.metric)}</text>` : '')
    + '</g>')

  for (const g of data.gateChanges ?? []) {
    const gx = px(m.left + (g.round / rounds) * plotW)
    parts.push(`<g class="gate-change"><line x1="${gx}" x2="${gx}" y1="${m.top}" y2="${axisY}" stroke="currentColor" stroke-dasharray="4 3" opacity="0.6"><title>gate ${esc(g.label)} from round ${g.round + 1}</title></line>`
      + `<text class="axis" x="${gx + 3}" y="${m.top + 10}">${esc(g.label)}</text></g>`)
  }

  for (const l of data.lineages) {
    const steps = [...l.steps].sort((a, b) => a.round - b.round)
    if (steps.length === 0) continue
    const y0 = y(baseline)
    const title = `${esc(l.name)}: champion baseline ${f(baseline)}; promoted ${steps.map((s) => `r${s.round + 1} by ${f(s.value)}`).join(', ')}`
    parts.push(`<path class="champion" d="M${m.left} ${y0} H${px(m.left + plotW)}" fill="none" stroke="${ACCENT}" stroke-width="1.5"><title>${title}</title></path>`)
    for (const s of steps) {
      parts.push(`<line class="promotion" x1="${x(s.round)}" x2="${x(s.round)}" y1="${px(y0 - 4)}" y2="${px(y0 + 4)}" stroke="${ACCENT}" stroke-width="2"><title>${esc(l.name)}: promoted r${s.round + 1} by ${f(s.value)}</title></line>`)
    }
  }

  for (const s of data.siblings) {
    const cx = x(s.round)
    const cy = y(s.value)
    const title = `${esc(s.id)} r${s.round + 1}: ${f(s.value)}${s.ci ? ` [${f(s.ci[0])}, ${f(s.ci[1])}]` : ''}${s.verdict ? ` ${esc(s.verdict)}` : ''}`
    if (s.promoted && s.ci) {
      parts.push(`<line class="whisker" x1="${cx}" x2="${cx}" y1="${y(s.ci[1])}" y2="${y(s.ci[0])}" stroke="${ACCENT}" stroke-width="1" />`)
    }
    parts.push(s.promoted
      ? `<circle class="sibling promoted" cx="${cx}" cy="${cy}" r="4" fill="${ACCENT}"><title>${title}</title></circle>`
      : `<circle class="sibling" cx="${cx}" cy="${cy}" r="3" fill="currentColor"><title>${title}</title></circle>`)
  }

  // One square per (sibling, gate), side by side within the round's column, wrapping to a second row when it is narrow.
  const perRow = Math.max(1, Math.floor(plotW / rounds / 8))
  const seen = new Map<number, number>()
  for (const s of data.shadows ?? []) {
    const i = seen.get(s.round) ?? 0
    seen.set(s.round, i + 1)
    const n = Math.min(perRow, (data.shadows ?? []).filter((o) => o.round === s.round).length)
    const sx = x(s.round) + ((i % perRow) - (n - 1) / 2) * 8
    const sy = axisY + 18 + Math.floor(i / perRow) * 8
    parts.push(`<rect class="shadow" x="${px(sx - 3)}" y="${px(sy)}" width="6" height="6" fill="none" stroke="currentColor"><title>${esc(s.gate)} (shadow)${s.id ? ` ${esc(s.id)}` : ''} r${s.round + 1}: ${esc(s.verdict)}</title></rect>`)
  }

  return `<svg class="lineage" viewBox="0 0 ${width} ${height}" role="img" aria-label="lineage curve">${parts.join('')}</svg>`
}

/** A 100x24 line in `currentColor`; empty for fewer than two values. */
export function sparkline(values: number[]): string {
  const w = 100
  const h = 24
  let body = ''
  if (values.length >= 2) {
    const lo = Math.min(...values)
    const hi = Math.max(...values)
    const span = hi - lo < 1e-9 ? 1 : hi - lo
    const pts = values.map((v, i) => `${px((i / (values.length - 1)) * (w - 2) + 1)} ${px(h - 2 - ((v - lo) / span) * (h - 4))}`)
    body = `<path d="M${pts.join(' L')}" fill="none" stroke="currentColor" stroke-width="1.5" />`
  }
  return `<svg class="sparkline" viewBox="0 0 ${w} ${h}" aria-hidden="true">${body}</svg>`
}
