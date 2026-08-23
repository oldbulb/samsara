import { describe, expect, it } from 'vitest'
import { buildChallenger, buildSummary } from '../src/api.ts'
import { loadRenderers, renderPage } from '../src/page.ts'
import { CHAL, fakeDeps } from './fixtures.ts'

const html = renderPage('/samsara', 5000)
const R = loadRenderers('/samsara')
const HOSTILE = '<script>alert(1)</script>"\'&'
const ESCAPED = '&lt;script&gt;alert(1)&lt;/script&gt;&quot;&#39;&amp;'

describe('renderPage', () => {
  it('is self-contained: no external stylesheet or script', () => {
    expect(html).not.toMatch(/<link\s/i)
    expect(html).not.toMatch(/<script\s+src=/i)
    expect(html).not.toMatch(/https?:\/\//)
  })

  it('carries the ui-style.md tokens verbatim on :root and the dark-mode ladder override', () => {
    expect(html).toContain('--color-accent:#6d28d9;')
    expect(html).toContain('--color-canvas:#f8fafc;')
    expect(html).toContain('--page-max:1280px;')
    expect(html).toContain('--dur-fast:.12s; --dur-base:.18s;')
    expect(html).toMatch(/@media \(prefers-color-scheme: dark\) \{\s*:root \{ --color-canvas:#0b1220;/)
  })

  it('has the sticky header with the brand mark, the live caption and the eyebrow class', () => {
    expect(html).toContain('class="mark"')
    expect(html).toContain('<span>samsara</span>')
    expect(html).toContain('.hdr { position: sticky;')
    expect(html).toContain('.eyebrow {')
    expect(html).toContain('id="status"')
    expect(html).toContain('setInterval(refresh, REFRESH)')
    expect(html).toContain('const REFRESH = 5000;')
  })
})

describe('renderers', () => {
  it('escape every value', () => {
    expect(R.esc(HOSTILE)).toBe(ESCAPED)
    expect(R.val(HOSTILE)).toBe(ESCAPED)
    expect(R.badge(HOSTILE)).toContain(ESCAPED)
    expect(R.sha(HOSTILE)).toContain('title="' + ESCAPED + '"')
    expect(R.link(HOSTILE)).not.toContain('<script>')
    expect(R.link(HOSTILE)).toContain('href="/samsara?challenger=' + encodeURIComponent(HOSTILE) + '"')
    expect(R.table(['<a>'], [[R.esc('<b>')]])).toBe('<div class="tbl"><table><thead><tr><th>&lt;a&gt;</th></tr></thead><tbody><tr><td>&lt;b&gt;</td></tr></tbody></table></div>')
  })

  it('render a dash for nulls, never "undefined"', () => {
    expect(R.val(null)).toContain('—')
    expect(R.val(undefined)).toContain('—')
    expect(R.num(undefined)).toContain('—')
    expect(R.sha(null)).toContain('—')
    for (const out of [R.championSection({ state_sha: null, kept: [], skill_ref: null, promoted_at: null, replay: { equal: true, missingInFile: [], extraInFile: [] }, route: null }),
      R.settlementSection(null), R.tiersSection({}), R.signoffSection([])]) {
      expect(out).not.toContain('undefined')
      expect(out).not.toContain('null')
    }
  })

  it('map verdicts and statuses to the badge tones', () => {
    expect(R.badge('promote')).toContain('class="badge pos"')
    expect(R.badge('drop')).toContain('class="badge risk"')
    expect(R.badge('hold')).toContain('class="badge warn"')
    expect(R.badge('invalid')).toContain('class="badge risk"')
    expect(R.badge('TRUNCATED')).toContain('class="badge warn"')
    expect(R.badge('FAILED')).toContain('class="badge risk"')
    expect(R.badge('gate-permissive@test')).toContain('class="badge warn"')
    expect(R.badge('holdout')).toContain('class="badge "')
  })

  it('render the summary and the drill-down from the API shapes', () => {
    const s = buildSummary(fakeDeps())
    const overview = R.championSection(s.champion) + R.settlementSection(s.lastSettlement) + R.tiersSection(s.tiers) + R.signoffSection(s.pendingSignoffs)
    expect(overview).toContain('Champion')
    expect(overview).toContain('replay ok')
    expect(overview).toContain(`href="/samsara?challenger=${CHAL}"`)
    expect(overview).toContain('<div class="eyebrow">Challengers · holdout<span class="count">1</span></div>')
    expect(overview).toContain('class="callout warn"')
    expect(overview).toContain('data-copy="samsara-signoff confirm')
    expect(overview).not.toContain('undefined')

    const d = R.detailSection(buildChallenger(fakeDeps(), CHAL)!)
    expect(d).toContain('class="coords"')
    expect(d).toContain('<div class="k">env_sha</div>')
    expect(d).toContain('class="crumbs"')
    expect(d).toContain('Prediction vs observed')
    expect(d).toContain('fixes hit <span class="tnum">1</span>')
    expect(d).not.toContain('undefined')
  })
})
