import { describe, expect, it } from 'vitest'
import { buildChallenger, buildSummary } from '../src/api.ts'
import { badge, esc, links, num, sha, table, val, verdictBadge } from '../src/html.ts'
import { detailSection, notFoundSection } from '../src/pages/challenger.ts'
import { championSection, load, render, settlementSection, signoffSection, tiersSection } from '../src/pages/home.ts'
import { CHAL, CHAMP, fakeDeps } from './fixtures.ts'

const deps = { ...fakeDeps(), base: '/samsara', refreshMs: 5000 }
const html = render(load(deps, { query: new URLSearchParams() }))
const L = links('/samsara')
const HOSTILE = '<script>alert(1)</script>"\'&'
const ESCAPED = '&lt;script&gt;alert(1)&lt;/script&gt;&quot;&#39;&amp;'

describe('home page', () => {
  it('is self-contained: no external stylesheet or script', () => {
    expect(html).not.toMatch(/<link\s/i)
    expect(html).not.toMatch(/<script\s+src=/i)
    expect(html).not.toMatch(/https?:\/\//)
  })

  it('carries the design tokens on body, the dark block, and the bootstrap right after <body>', () => {
    expect(html).toContain('body {\n  --dsw-alias-bg-base: #fff;')
    expect(html).toContain('body[data-ds-dark-theme] {\n  --dsw-alias-bg-base: rgb(21,21,23);')
    expect(html).toMatch(/<body>\n<script>\(\(\)=>\{const p='system'/)
    expect(html).not.toContain('prefers-color-scheme: dark) {')
  })

  it('has the wordmark, the nav with Home active, the live caption and the refresh script', () => {
    expect(html).toContain('<a class="wordmark" href="/samsara">samsara</a>')
    expect(html).toContain('<a class="pill active" href="/samsara/" aria-current="page">Home</a>')
    expect(html).toContain('id="live"')
    expect(html).toContain('setInterval(refresh, REFRESH)')
    expect(html).toContain('const REFRESH = 5000;')
  })

  it('renders the four sections server-side, in the design order', () => {
    const order = ['<h2>Champion</h2>', '<h2>Last settlement</h2>', 'Challengers · smoke', 'Challengers · holdin', 'Challengers · holdout', 'Challengers · live', 'Pending sign-offs']
    const at = order.map((s) => html.indexOf(s))
    expect(at.every((i) => i >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
  })

  it('renders the drill-down above the overview for ?challenger=<id>, and a not-found card for an unknown one', () => {
    const detail = render(load(deps, { query: new URLSearchParams({ challenger: CHAL }) }))
    expect(detail.indexOf('<h2>Challenger</h2>')).toBeLessThan(detail.indexOf('<h2>Champion</h2>'))
    expect(detail).toContain('<h3>Coordinates</h3>')
    const missing = render(load(deps, { query: new URLSearchParams({ challenger: 'nope' }) }))
    expect(missing).toContain('Unknown challenger <span class="tnum">nope</span>')
    expect(missing).toContain('<h2>Champion</h2>')
  })
})

describe('helpers', () => {
  it('escape every value', () => {
    expect(esc(HOSTILE)).toBe(ESCAPED)
    expect(val(HOSTILE)).toBe(ESCAPED)
    expect(badge(HOSTILE)).toContain(ESCAPED)
    expect(sha(HOSTILE)).toContain('title="' + ESCAPED + '"')
    expect(L.challenger(HOSTILE)).not.toContain('<script>')
    expect(L.challenger(HOSTILE)).toContain('href="/samsara/challengers/' + encodeURIComponent(HOSTILE) + '"')
    expect(table(['<a>'], [[esc('<b>')]])).toBe('<div class="tbl"><table><thead><tr><th>&lt;a&gt;</th></tr></thead><tbody><tr><td>&lt;b&gt;</td></tr></tbody></table></div>')
  })

  it('render a dash for nulls, never "undefined"', () => {
    expect(val(null)).toContain('—')
    expect(val(undefined)).toContain('—')
    expect(num(undefined)).toContain('—')
    expect(sha(null)).toContain('—')
    for (const out of [championSection({ state_sha: null, rows: [], kept: [], skill_ref: null, promoted_at: null, replay: { equal: true, missingInFile: [], extraInFile: [] }, route: null }, L),
      settlementSection(null, L), tiersSection({}, L), signoffSection([], L)]) {
      expect(out).not.toContain('undefined')
      expect(out).not.toContain('null')
    }
  })

  it('map verdicts and statuses to the badge tones of the design note', () => {
    expect(badge('promote')).toContain('class="badge ok"')
    expect(badge('hold')).toContain('class="badge neutral"')
    expect(badge('hold:underpowered')).toContain('class="badge warn"')
    expect(badge('drop')).toContain('class="badge danger"')
    expect(badge('invalid')).toContain('class="badge danger outline"')
    expect(badge('TRUNCATED')).toContain('class="badge warn"')
    expect(badge('FAILED')).toContain('class="badge danger"')
    expect(badge('holdout')).toContain('class="badge "')
    expect(verdictBadge('hold:superseded')).toBe('<span class="badge neutral">hold</span> <span class="muted">superseded</span>')
    expect(verdictBadge('promote', { shadow: true, gate: 'keep-better@0.1.0' })).toBe('<span class="badge ok">promote</span> <span class="badge neutral">shadow</span> <span class="muted">keep-better@0.1.0</span>')
    expect(verdictBadge(null)).toContain('—')
  })

  it('render the summary and the drill-down from the API shapes', () => {
    const s = buildSummary(fakeDeps())
    const overview = championSection(s.champion, L) + settlementSection(s.lastSettlement, L) + tiersSection(s.tiers, L) + signoffSection(s.pendingSignoffs, L)
    expect(overview).toContain('Champion')
    expect(overview).toContain('replay ok')
    expect(overview).toContain(`href="/samsara/challengers/${CHAL}"`)
    expect(overview).toContain('<h2>Challengers · holdout<span class="count">2</span></h2>')
    expect(overview).toContain('class="callout warn"')
    expect(overview).toContain('data-copy="samsara-signoff confirm')
    expect(overview).not.toContain('undefined')

    const d = detailSection(buildChallenger(fakeDeps(), CHAL)!, L)
    expect(d).toContain('<dt>env sha</dt>')
    expect(d).toContain('class="crumbs"')
    expect(d).toContain(`href="/samsara/challengers/${CHAMP}"`)
    expect(d).toContain('Prediction vs observed')
    expect(d).toContain('fixes hit <span class="tnum">1</span>')
    // The shadow row is listed with its marker and gate; the promotion row shows no marker.
    expect(d).toContain('<th>gate</th>')
    expect(d).toContain('<span class="badge ok">promote</span> <span class="badge neutral">shadow</span> <span class="muted">keep-better@0.1.0</span>')
    expect(d).toContain('<td>keep-better@0.1.0</td>')
    expect(d).toContain('<span class="badge warn">hold:underpowered</span></td><td>gate-default@1</td>')
    expect(d).not.toContain('undefined')
    expect(notFoundSection('x', L)).toContain('class="callout danger"')
  })
})
