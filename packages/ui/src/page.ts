// The /samsara page: one self-contained HTML string (no external assets, no
// build step) implementing docs/design/ui-style.md. The script polls the JSON
// API and renders the sections of docs/design/ui-and-certification.md, plus
// the drill-down when the URL carries ?challenger=<id>. Read-only.
//
// The renderers live in RENDER_SOURCE: a DOM-free function body (BASE → an
// object of pure string builders) that the page inlines and the tests evaluate
// with `loadRenderers`, so escaping is asserted on the same code the browser runs.

/** Tokens from ui-style.md, copied verbatim. */
const TOKENS = `--color-canvas:#f8fafc; --color-surface-1:#ffffff; --color-surface-2:#f8fafc; --color-sunken:#f1f5f9;
--color-border:#e2e8f0; --color-border-strong:#cbd5e1;
--color-ink:#0f172a; --color-ink-soft:#334155; --color-ink-muted:#64748b; --color-ink-faint:#94a3b8;
--color-accent:#6d28d9; --color-accent-hover:#5b21b6; --color-accent-soft:#f5f3ff; --color-accent-border:#ddd6fe; --color-accent-focus:rgba(109,40,217,.40);
--color-pos:#15803d; --color-pos-soft:#f0fdf4; --color-risk:#be185d; --color-risk-soft:#fdf2f8;
--color-warn:#b45309; --color-warn-soft:#fffbeb; --color-info:#0e7490; --color-info-soft:#ecfeff;
--color-code-bg:#0d1117; --color-code-header:#161b22; --color-code-border:#21262d;
--font-mono:"Maple Mono","Maple Mono CN",ui-monospace,"SF Mono",Menlo,monospace;
--font-cn:"MiSans","PingFang SC","Maple Mono CN",ui-sans-serif,system-ui,sans-serif;
--leading-body:1.65; --leading-heading:1.15; --leading-prose:1.75;
--radius-xs:4px; --radius-sm:6px; --radius-md:8px; --radius-lg:12px; --radius-xl:16px; --radius-pill:9999px;
--shadow-card:none; --shadow-hover:0 1px 2px rgba(15,23,42,.04),0 4px 12px rgba(15,23,42,.05);
--ease:cubic-bezier(.2,0,0,1); --dur-fast:.12s; --dur-base:.18s; --page-max:1280px; --header-h:56px;`

const CSS = `
:root { ${TOKENS} }
@media (prefers-color-scheme: dark) {
  :root { --badge-pos-border: #14532d; --badge-risk-border: #831843; --badge-warn-border: #78350f; --badge-info-border: #164e63; --color-pos: #4ade80; --color-risk: #f472b6; --color-warn: #fbbf24; --color-info: #22d3ee; }
  :root { --color-canvas:#0b1220; --color-surface-1:#0f172a; --color-surface-2:#111a2e; --color-sunken:#1e293b; --color-border:#1f2937; --color-border-strong:#334155;
    --color-ink:#e2e8f0; --color-ink-soft:#cbd5e1; --color-ink-muted:#94a3b8; --color-ink-faint:#64748b;
    --color-accent-soft:#2e1065; --color-accent-border:#4c1d95; --color-pos-soft:#052e16; --color-risk-soft:#4a044e; --color-warn-soft:#451a03; --color-info-soft:#083344; }
}
* { box-sizing: border-box; }
html, body { margin: 0; }
body { background: var(--color-canvas); color: var(--color-ink); font: 14px/var(--leading-body) var(--font-mono); -webkit-font-smoothing: antialiased; }
h1, h2, h3 { margin: 0; line-height: var(--leading-heading); font-weight: 700; }
h1 { font-size: 20px; letter-spacing: -0.025em; } h2 { font-size: 16px; letter-spacing: -0.02em; } h3 { font-size: 14px; font-weight: 600; letter-spacing: -0.01em; }
a { color: var(--color-accent); text-decoration: none; transition: color var(--dur-fast) var(--ease); }
a:hover { color: var(--color-accent-hover); text-decoration: underline; }
:focus-visible { outline: 2px solid var(--color-accent-focus); outline-offset: 1px; }
::selection { background: var(--color-accent-soft); color: var(--color-accent-hover); }
code { font-family: var(--font-mono); }
.tnum { font-variant-numeric: tabular-nums; }
.muted { color: var(--color-ink-muted); }
.eyebrow { font-size: 12px; font-weight: 600; line-height: 1.3; letter-spacing: .06em; text-transform: uppercase; color: var(--color-ink-muted); }
.eyebrow .count { font-weight: 500; letter-spacing: 0; text-transform: none; color: var(--color-ink-faint); margin-left: 6px; }

.hdr { position: sticky; top: 0; z-index: 10; height: var(--header-h); background: var(--color-surface-1); border-bottom: 1px solid var(--color-border); }
.hdr-in { max-width: var(--page-max); height: 100%; margin: 0 auto; padding: 0 24px; display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.brand { display: flex; align-items: center; gap: 10px; color: var(--color-ink); font-size: 13px; font-weight: 600; }
.brand:hover { text-decoration: none; color: var(--color-ink); }
.mark { width: 24px; height: 24px; border-radius: var(--radius-md); background: var(--color-accent); color: #fff; display: inline-flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 700; }
.live { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--color-ink-muted); }
.dot { width: 8px; height: 8px; border-radius: var(--radius-pill); background: var(--color-ink-faint); transition: background var(--dur-base) var(--ease); }
.dot.ok { background: var(--color-pos); } .dot.err { background: var(--color-risk); }

main { max-width: var(--page-max); margin: 0 auto; padding: 32px 24px 64px; display: flex; flex-direction: column; gap: 32px; }
section > .eyebrow { margin-bottom: 12px; }
.card { background: var(--color-surface-1); border: 1px solid var(--color-border); border-radius: var(--radius-lg); padding: 24px; box-shadow: var(--shadow-card); }
.sub { margin: 24px 0 12px; }
.intent { margin: 12px 0 0; font-size: 13px; } .note { margin: 8px 0 0; font-size: 13px; }

.kv { display: grid; grid-template-columns: max-content 1fr; gap: 12px 24px; margin: 0; }
.kv dt { font-size: 12px; color: var(--color-ink-muted); line-height: 1.65; } .kv dd { margin: 0; font-size: 13px; min-width: 0; overflow-wrap: anywhere; }

.tbl { overflow-x: auto; border: 1px solid var(--color-border); border-radius: var(--radius-md); }
table { border-collapse: collapse; width: 100%; }
th { font-size: 12px; font-weight: 600; text-align: left; color: var(--color-ink-muted); background: var(--color-sunken); border-bottom: 1px solid var(--color-border); padding: 8px 12px; white-space: nowrap; }
td { font-size: 13px; padding: 8px 12px; border-bottom: 1px solid var(--color-border); vertical-align: top; font-variant-numeric: tabular-nums; }
tbody tr:last-child td { border-bottom: 0; }
tbody tr { transition: background var(--dur-fast) var(--ease); } tbody tr:hover td { background: var(--color-surface-2); }

.badge { display: inline-flex; align-items: center; font-size: 11px; font-weight: 600; line-height: 1.5; white-space: nowrap; border-radius: var(--radius-pill); padding: 2px 9px; border: 1px solid var(--color-border); background: var(--color-sunken); color: var(--color-ink-soft); }
.badge.pos { background: var(--color-pos-soft); color: var(--color-pos); border-color: var(--badge-pos-border, #bbf7d0); }
.badge.risk { background: var(--color-risk-soft); color: var(--color-risk); border-color: var(--badge-risk-border, #fbcfe8); }
.badge.warn { background: var(--color-warn-soft); color: var(--color-warn); border-color: var(--badge-warn-border, #fde68a); }
.badge.info { background: var(--color-info-soft); color: var(--color-info); border-color: var(--badge-info-border, #a5f3fc); }

.callout { border-left: 3px solid var(--color-info); background: var(--color-info-soft); border-radius: var(--radius-md); padding: 10px 14px; font-size: 13px; color: var(--color-ink-soft); }
.callout.pos { border-color: var(--color-pos); background: var(--color-pos-soft); }
.callout.warn { border-color: var(--color-warn); background: var(--color-warn-soft); }
.callout.risk { border-color: var(--color-risk); background: var(--color-risk-soft); }
.empty { font-size: 13px; color: var(--color-ink-muted); margin: 0; }

.code { background: var(--color-code-bg); border: 1px solid var(--color-code-border); border-radius: var(--radius-md); overflow: hidden; margin-top: 12px; }
.code-head { display: flex; align-items: center; justify-content: space-between; background: var(--color-code-header); border-bottom: 1px solid var(--color-code-border); padding: 6px 12px; font-size: 11px; color: #94a3b8; }
.code pre { margin: 0; padding: 12px; font-size: 12.5px; line-height: 1.6; color: #e2e8f0; white-space: pre-wrap; overflow-wrap: anywhere; }
.copy { background: none; border: 0; padding: 2px 6px; font: inherit; font-weight: 600; color: #a78bfa; cursor: pointer; border-radius: var(--radius-xs); transition: color var(--dur-fast) var(--ease); }
.copy:hover { color: #c4b5fd; }

.crumbs { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 13px; }
.crumbs .sep { color: var(--color-ink-faint); }
.coords { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
.coord { background: var(--color-surface-2); border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: 8px 12px; min-width: 0; }
.coord .k { font-size: 11px; color: var(--color-ink-muted); line-height: 1.4; } .coord .v { font-size: 13px; overflow-wrap: anywhere; }
`

/**
 * The renderers. A function body over `BASE` (the route prefix) returning an
 * object of pure (data → HTML string) builders. Every value passes through `esc`.
 */
export const RENDER_SOURCE = `
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DASH = '<span class="muted">\\u2014</span>';
const val = (x) => x === null || x === undefined || x === '' ? DASH : esc(x);
const sha = (s) => s ? '<span class="tnum" title="' + esc(s) + '">' + esc(String(s).slice(0, 12)) + '</span>' : DASH;
const num = (x, d = 3) => typeof x === 'number' ? '<span class="tnum">' + x.toFixed(d) + '</span>' : DASH;
const link = (id) => id ? '<a class="tnum" title="' + esc(id) + '" href="' + BASE + '?challenger=' + encodeURIComponent(id) + '">' + esc(String(id).slice(0, 12)) + '</a>' : DASH;
const TONE = { promote: 'pos', confirmed: 'pos', drop: 'risk', invalid: 'risk', reversed: 'risk', hold: 'warn', 'hold:underpowered': 'warn',
  COMPLETED: 'pos', TRUNCATED: 'warn', ABORTED: 'risk', FAILED: 'risk', running: 'info', 'gate-permissive@test': 'warn' };
const badge = (v, tone) => v === null || v === undefined || v === '' ? DASH : '<span class="badge ' + (tone ?? TONE[v] ?? '') + '">' + esc(v) + '</span>';
const eyebrow = (text, count) => '<div class="eyebrow">' + esc(text) + (count === undefined ? '' : '<span class="count">' + esc(count) + '</span>') + '</div>';
const callout = (tone, html) => '<div class="callout ' + tone + '">' + html + '</div>';
const empty = (text) => '<p class="empty">' + esc(text) + '</p>';
const kv = (pairs) => '<dl class="kv">' + pairs.map(([k, v]) => '<dt>' + esc(k) + '</dt><dd>' + v + '</dd>').join('') + '</dl>';
const table = (cols, rows, emptyText) => rows.length === 0 ? empty(emptyText ?? 'none')
  : '<div class="tbl"><table><thead><tr>' + cols.map((c) => '<th>' + esc(c) + '</th>').join('') + '</tr></thead><tbody>'
    + rows.map((r) => '<tr>' + r.map((c) => '<td>' + c + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>';
const verdict = (v, method) => v ? badge(v.value) + ' <span class="muted">' + esc(v.rule) + ' \\u00b7 ' + esc(method ?? v.by) + '</span>' : DASH;
const codeBlock = (label, text) => '<div class="code"><div class="code-head"><span>' + esc(label) + '</span>'
  + '<button type="button" class="copy" data-copy="' + esc(text) + '">copy</button></div><pre>' + esc(text) + '</pre></div>';

function championSection(c) {
  if (!c.state_sha) return '<section>' + eyebrow('Champion') + '<div class="card">' + callout('info', 'No champion yet \\u2014 nothing has been promoted.') + '</div></section>';
  const replay = c.replay.equal ? badge('replay ok', 'pos')
    : badge('replay mismatch', 'risk') + ' <span class="muted">missing in file: ' + val(c.replay.missingInFile.join(', ')) + '; extra in file: ' + val(c.replay.extraInFile.join(', ')) + '</span>';
  return '<section>' + eyebrow('Champion') + '<div class="card">' + kv([
    ['state sha', '<span class="tnum">' + esc(c.state_sha) + '</span>'],
    ['kept rows', c.kept.length === 0 ? DASH : c.kept.map((k) => esc(k.surface) + ' <span class="tnum">' + esc(k.ref) + '</span> (' + link(k.challenger_id) + ')').join('<br>')],
    ['skill ref', c.skill_ref ? '<span class="tnum">' + esc(c.skill_ref) + '</span>' : DASH],
    ['promoted at', val(c.promoted_at)],
    ['replay check', replay],
    ['route', c.route ? esc(c.route.loop) + ' / ' + esc(c.route.model) : DASH],
  ]) + '</div></section>';
}

function settlementSection(s) {
  const body = !s ? empty('No settlement yet.') : kv([
    ['kind', val(s.kind)], ['as of', val(s.as_of)],
    ['settled / pending', '<span class="tnum">' + esc(s.n_settled) + ' / ' + esc(s.n_pending) + '</span>'],
    ['truth snapshot', sha(s.truth_snapshot_id)],
    ['rows re-scored', s.triggered_rescoring.length === 0 ? DASH : s.triggered_rescoring.map(link).join(' ')],
    ['demoted', s.demoted.length === 0 ? '<span class="muted">none</span>' : s.demoted.map(link).join(' ')],
  ]);
  return '<section>' + eyebrow('Last settlement') + '<div class="card">' + body + '</div></section>';
}

function tierTable(rows) {
  const cols = ['id', 'parent', 'surface', 'intent', 'status', 'verdict', 'compare', 'proposer', 'attempts', 'facts sha'];
  return table(cols, rows.map((r) => [
    link(r.id), sha(r.parent), val(r.surface), val(r.intent), badge(r.status), verdict(r.verdict, r.gate_method),
    r.compare ? 'mean ' + num(r.compare.mean) + ' ci [' + num(r.compare.ci[0]) + ', ' + num(r.compare.ci[1]) + '] n_eff ' + val(r.compare.n_eff) + ' mde ' + num(r.compare.mde) + ' cost ' + num(r.compare.cost_ratio, 2) : DASH,
    sha(r.proposer),
    '<span class="tnum">' + esc(r.attempts.n) + '</span> ' + Object.entries(r.attempts.by_status).map(([k, v]) => badge(k) + '<span class="tnum muted">\\u00d7' + esc(v) + '</span>').join(' '),
    r.facts_sha.length === 0 ? DASH : r.facts_sha.map(sha).join(' '),
  ]), 'No challengers on this tier.');
}

function tiersSection(tiers) {
  return ['smoke', 'holdin', 'holdout', 'live'].map((tier) => {
    const rows = tiers[tier] ?? [];
    return '<section>' + eyebrow('Challengers \\u00b7 ' + tier, rows.length) + '<div class="card">' + tierTable(rows) + '</div></section>';
  }).join('');
}

function signoffSection(list) {
  const body = list.length === 0 ? empty('No sign-off pending.') : list.map((p) =>
    callout('warn', 'Sign-off pending: ' + badge(p.action) + ' on ' + link(p.rowId) + ' <span class="muted">\\u00b7 nonce expires ' + val(p.expiresAt) + ' \\u00b7 run this from your shell (never through the page)</span>')
    + codeBlock('samsara-signoff confirm', p.command)).join('<div class="sub"></div>');
  return '<section>' + eyebrow('Pending sign-offs', list.length) + '<div class="card">' + body + '</div></section>';
}

function detailSection(d) {
  const r = d.row;
  const coordKeys = ['id', 'patch_sha', 'harness_sha', 'env_sha', 'skill_sha', 'taskset_sha', 'optimizer_config_sha', 'truth_snapshot_id', 'scorer_version', 'report_rule_version'];
  const coords = '<div class="coords">' + coordKeys.map((k) => '<div class="coord"><div class="k">' + esc(k) + '</div><div class="v">' + sha(r[k]) + '</div></div>').join('')
    + '<div class="coord"><div class="k">route</div><div class="v">' + esc(r.route.loop) + '@' + esc(r.route.loop_adapter_version) + ' / ' + esc(r.route.model_id) + '</div></div></div>';
  const crumbs = '<div class="crumbs">' + d.lineage.map((l) => link(l.id) + ' <span class="muted">' + esc(l.surface) + '</span> ' + badge(l.status) + (l.verdict ? ' ' + badge(l.verdict) : ''))
    .join('<span class="sep">\\u2192</span>') + '</div>';
  const scoresByAttempt = {};
  for (const s of d.scores) { if (s.redacted) continue; (scoresByAttempt[s.attempt_id] ||= []).push(esc(s.metric) + '=' + num(s.value)); }
  const attempts = table(['attempt', 'task', 'sample', 'tier', 'status', 'stop', 'cost usd', 'wall s', 'scores'], d.attempts.map((a) => a.redacted
    ? ['<span class="muted">' + esc(a.tier) + ' aggregate</span>', DASH, DASH, badge(a.tier), Object.entries(a.by_status ?? {}).map(([k, v]) => badge(k) + '<span class="tnum muted">\\u00d7' + esc(v) + '</span>').join(' '), DASH, DASH, DASH, '<span class="tnum">' + esc(a.n) + '</span> attempts']
    : [sha(a.id), val(a.task_id), val(a.sample), badge(a.tier), badge(a.status), val(a.stop_reason), num(a.cost.usd, 4), num(a.cost.wall_s, 1), (scoresByAttempt[a.id] ?? []).join(' ') || DASH]),
    'No attempts recorded.');
  const aggregates = d.scores.filter((s) => s.redacted).map((s) => esc(s.metric) + ' mean ' + num(s.mean) + ' over ' + esc(s.n));
  const compares = table(['vs', 'tier', 'truth', 'mean', 'ci', 'n_eff', 'mde', 'rule', 'verdict', 'method', 'at'], d.compares.map((c) => [
    link(c.vs_id), badge(c.tier), sha(c.truth_snapshot_id), num(c.mean), '[' + num(c.ci[0]) + ', ' + num(c.ci[1]) + ']', val(c.n_eff), num(c.mde),
    val(c.rule_fired), badge(c.verdict.value), val(c.method), val(c.at)]), 'No compare rows yet.');
  const consents = table(['id', 'action', 'who', 'channel', 'at'], d.consents.map((c) => [sha(c.id), badge(c.action), val(c.who), val(c.channel), val(c.at)]), 'No consents recorded.');
  const p = d.prediction_vs_observed;
  const prediction = kv([
    ['predicted', esc(p.predicted.metric) + ' ' + esc(p.predicted.direction) + (p.predicted.magnitude != null ? ' by ' + num(p.predicted.magnitude) : '')],
    ['predicted fixes', val((p.predicted.predicted_fixes ?? []).join(', '))],
    ['at risk', val((p.predicted.at_risk ?? []).join(', '))],
    ['observed', p.observed.length === 0 ? '<span class="muted">no judged compare carries it</span>'
      : p.observed.map((o) => badge(o.tier) + ' fixes hit <span class="tnum">' + esc(o.fixes_hit) + '</span>, at-risk hit <span class="tnum">' + esc(o.at_risk_hit) + '</span>').join('<br>')],
  ]);
  return '<section>' + eyebrow('Challenger') + '<div class="card">'
    + '<div class="crumbs"><a href="' + BASE + '">\\u2190 overview</a><span class="sep">/</span><span class="tnum" title="' + esc(r.id) + '">' + esc(r.id.slice(0, 12)) + '</span> ' + badge(r.status) + ' ' + verdict(r.verdict) + '</div>'
    + '<p class="muted intent">' + val(r.intent) + '</p>'
    + '<h3 class="sub">Coordinates</h3>' + coords
    + '<h3 class="sub">Lineage</h3>' + crumbs
    + '<h3 class="sub">Attempts</h3>' + attempts + (aggregates.length ? '<p class="muted note">held-out aggregates: ' + aggregates.join('; ') + '</p>' : '')
    + '<h3 class="sub">Compares</h3>' + compares
    + '<h3 class="sub">Consents</h3>' + consents
    + '<h3 class="sub">Prediction vs observed</h3>' + prediction
    + '</div></section>';
}

function notFoundSection(id) {
  return '<section>' + eyebrow('Challenger') + '<div class="card">' + callout('risk', 'Unknown challenger <span class="tnum">' + esc(id) + '</span>. <a href="' + BASE + '">Back to the overview</a>.') + '</div></section>';
}

return { esc, val, sha, num, link, badge, eyebrow, callout, table, kv, championSection, settlementSection, tiersSection, signoffSection, detailSection, notFoundSection };
`

/** Evaluates RENDER_SOURCE outside a browser (tests). */
export function loadRenderers(basePath: string): Record<string, (...args: any[]) => string> {
  return new Function('BASE', RENDER_SOURCE)(basePath)
}

export function renderPage(basePath: string, refreshMs: number): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>samsara</title>
<style>${CSS}</style>
</head>
<body>
<header class="hdr"><div class="hdr-in">
  <a class="brand" href="${basePath}"><span class="mark" aria-hidden="true">S</span><span>samsara</span></a>
  <div class="live"><span class="dot" id="dot"></span><span id="status">loading…</span></div>
</div></header>
<main id="app"></main>
<script>
(() => {
  const BASE = ${JSON.stringify(basePath)};
  const REFRESH = ${JSON.stringify(refreshMs)};
  const R = (function (BASE) { ${RENDER_SOURCE} })(BASE);
  const app = document.getElementById('app');
  const status = document.getElementById('status');
  const dot = document.getElementById('dot');
  let refreshedAt = null;

  async function getJson(path) {
    const res = await fetch(BASE + path, { headers: { accept: 'application/json' } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(path + ' \\u2192 ' + res.status);
    return res.json();
  }

  async function refresh() {
    try {
      const id = new URLSearchParams(location.search).get('challenger');
      const s = await getJson('/api/summary');
      if (!s) throw new Error('summary unavailable');
      let html = '';
      if (id) {
        const d = await getJson('/api/challenger/' + encodeURIComponent(id));
        html += d ? R.detailSection(d) : R.notFoundSection(id);
      }
      html += R.championSection(s.champion) + R.settlementSection(s.lastSettlement) + R.tiersSection(s.tiers) + R.signoffSection(s.pendingSignoffs);
      app.innerHTML = html;
      refreshedAt = Date.now();
      dot.className = 'dot ok';
      tick();
    } catch (e) {
      dot.className = 'dot err';
      status.textContent = 'error: ' + (e && e.message ? e.message : e);
    }
  }

  function tick() {
    if (refreshedAt === null || dot.className === 'dot err') return;
    status.textContent = 'refreshed ' + Math.max(0, Math.round((Date.now() - refreshedAt) / 1000)) + 's ago \\u00b7 every ' + (REFRESH / 1000) + 's';
  }

  app.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button.copy');
    if (!btn) return;
    const done = () => { btn.textContent = 'copied'; setTimeout(() => { btn.textContent = 'copy'; }, 1200); };
    if (navigator.clipboard) navigator.clipboard.writeText(btn.dataset.copy).then(done, () => {});
  });

  refresh();
  setInterval(refresh, REFRESH);
  setInterval(tick, 1000);
})();
</script>
</body>
</html>
`
}
