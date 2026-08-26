// Formatting helpers shared by the page modules: escaping, dashes for
// nothing, badges in the design language's tones, tables inside an
// overflow-x container, the stat block, code blocks with a copy button, and
// the links between pages. Every value passes through `esc`.

export const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
export const DASH = '<span class="muted">—</span>'
export const val = (x: unknown): string => x === null || x === undefined || x === '' ? DASH : esc(x)
export const sha = (s: unknown): string => s ? `<span class="tnum" title="${esc(s)}">${esc(String(s).slice(0, 12))}</span>` : DASH
export const num = (x: unknown, d = 3): string => typeof x === 'number' ? `<span class="tnum">${x.toFixed(d)}</span>` : DASH
export const int = (x: unknown): string => typeof x === 'number' ? `<span class="tnum">${String(x)}</span>` : DASH

export type Tone = 'ok' | 'warn' | 'danger' | 'neutral'

/** Verdicts and statuses to the badge tones of the design note. */
const TONE: Record<string, Tone | `${Tone} outline`> = {
  promote: 'ok', confirmed: 'ok', hold: 'neutral', 'hold:underpowered': 'warn', 'hold:superseded': 'neutral', drop: 'danger', invalid: 'danger outline', reversed: 'danger',
  COMPLETED: 'ok', TRUNCATED: 'warn', ABORTED: 'danger', FAILED: 'danger', running: 'neutral',
  open: 'ok', judged: 'neutral', decided: 'neutral', active: 'ok', closed: 'neutral', proposed: 'neutral', opened: 'neutral',
}

export const badge = (v: unknown, tone?: Tone | `${Tone} outline` | ''): string =>
  v === null || v === undefined || v === '' ? DASH : `<span class="badge ${tone ?? TONE[String(v)] ?? ''}">${esc(v)}</span>`

export const pill = (text: unknown, extra = ''): string => `<span class="pill${extra ? ` ${extra}` : ''}">${esc(text)}</span>`

/** The verdict as the note names it: a `hold` whose rule is `power:*` (the row loses the suffix, the rule keeps it) reads `hold:underpowered`. */
export function verdictLabel(value: string, rule?: string): string {
  return value === 'hold' && rule?.startsWith('power:') ? 'hold:underpowered' : value
}

/**
 * A verdict as the note prescribes: `hold:superseded` reads `hold` with a
 * `superseded` suffix; a shadow verdict always carries the `shadow` pill and
 * its gate name. Pass the rule so an underpowered hold gets its label.
 */
export function verdictBadge(value: string | null | undefined, opts: { shadow?: boolean; gate?: string | null; rule?: string } = {}): string {
  if (!value) return DASH
  const label = verdictLabel(value, opts.rule)
  const out = label === 'hold:superseded' ? badge('hold', 'neutral') + ' <span class="muted">superseded</span>' : badge(label)
  return opts.shadow ? `${out} ${badge('shadow', 'neutral')}${opts.gate ? ` <span class="muted">${esc(opts.gate)}</span>` : ''}` : out
}

export const empty = (text: string): string => `<p class="empty">${esc(text)}</p>`
export const callout = (tone: Tone | '', html: string): string => `<div class="callout ${tone}">${html}</div>`
export const heading = (text: string, count?: number): string => `<h2>${esc(text)}${count === undefined ? '' : `<span class="count">${esc(count)}</span>`}</h2>`
export const card = (html: string, head?: string): string => `<div class="card">${head ? `<div class="card-head">${esc(head)}</div>` : ''}${html}</div>`
export const section = (title: string, html: string, count?: number): string => `<section>${heading(title, count)}${html}</section>`
export const stat = (pairs: [string, string][]): string => `<dl class="stat">${pairs.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`

/** A table inside its own overflow-x container; `emptyText` when there are no rows. Cells are trusted HTML. */
export function table(cols: string[], rows: string[][], emptyText = 'none'): string {
  if (rows.length === 0) return empty(emptyText)
  return `<div class="tbl"><table><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>`
    + rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('') + '</tbody></table></div>'
}

export function codeBlock(label: string, text: string): string {
  return `<div class="code"><div class="code-head"><span>${esc(label)}</span><button type="button" class="copy" data-copy="${esc(text)}">copy</button></div><pre>${esc(text)}</pre></div>`
}

/** Links between the pages under `base`. */
export function links(base: string) {
  const to = (path: string, id: string, text?: string) =>
    `<a class="tnum" title="${esc(id)}" href="${base}${path}/${encodeURIComponent(id)}">${esc(text ?? id.slice(0, 12))}</a>`
  return {
    challenger: (id: string | null | undefined, text?: string) => id ? to('/challengers', id, text) : DASH,
    round: (id: string | null | undefined, text?: string) => id ? to('/rounds', id, text) : DASH,
    experiment: (id: string | null | undefined, text?: string) => id ? to('/experiments', id, text) : DASH,
    notebook: (session: string | null | undefined, text?: string) => session ? to('/notebook', session, text) : DASH,
    home: `${base}/`,
  }
}
export type Links = ReturnType<typeof links>
