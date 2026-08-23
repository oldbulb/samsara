// The /samsara page: one self-contained HTML string (no external assets, no
// build step). The script polls the JSON API and renders the four panels in
// the order of docs/design/ui-and-certification.md, plus the drill-down when
// the URL carries ?challenger=<id>. Plain DOM, template literals, read-only.

export function renderPage(basePath: string, refreshMs: number): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>samsara</title>
<style>
  :root { color-scheme: light dark; --fg: #1b1b1b; --bg: #fff; --muted: #666; --line: #ddd; --card: #f6f6f6; --ok: #1a7f37; --bad: #b42318; --warn: #9a6700; }
  @media (prefers-color-scheme: dark) { :root { --fg: #e6e6e6; --bg: #111; --muted: #9a9a9a; --line: #333; --card: #1b1b1b; --ok: #4caf6a; --bad: #f0706a; --warn: #e3b341; } }
  body { margin: 0; padding: 1.5rem; font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; color: var(--fg); background: var(--bg); }
  h1 { font-size: 1.25rem; margin: 0 0 1rem; } h1 small { color: var(--muted); font-weight: normal; margin-left: .75rem; }
  h2 { font-size: 1rem; margin: 1.5rem 0 .5rem; } h3 { font-size: .9rem; margin: 1rem 0 .25rem; color: var(--muted); }
  section { border: 1px solid var(--line); border-radius: 6px; padding: .75rem 1rem; margin-bottom: 1rem; background: var(--card); }
  table { border-collapse: collapse; width: 100%; font-size: 13px; } th, td { text-align: left; padding: .25rem .5rem; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight: 600; } code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  pre { background: var(--bg); border: 1px solid var(--line); padding: .5rem; overflow-x: auto; white-space: pre-wrap; word-break: break-all; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: .2rem 1rem; margin: 0; } dt { color: var(--muted); } dd { margin: 0; }
  .ok { color: var(--ok); } .bad { color: var(--bad); } .warn { color: var(--warn); } .muted { color: var(--muted); }
  a { color: inherit; } .empty { color: var(--muted); font-style: italic; }
</style>
</head>
<body>
<h1>samsara <small id="status">loading…</small></h1>
<div id="app"></div>
<script>
(() => {
  const BASE = ${JSON.stringify(basePath)};
  const REFRESH = ${JSON.stringify(refreshMs)};
  const app = document.getElementById('app');
  const status = document.getElementById('status');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const short = (s) => s ? esc(String(s).slice(0, 12)) : '<span class="muted">—</span>';
  const num = (x, d = 3) => typeof x === 'number' ? x.toFixed(d) : '<span class="muted">—</span>';
  const link = (id) => '<a href="' + BASE + '?challenger=' + encodeURIComponent(id) + '"><code>' + short(id) + '</code></a>';
  const cls = (v) => v === 'promote' || v === 'confirmed' ? 'ok' : v === 'drop' || v === 'invalid' || v === 'reversed' ? 'bad' : v === 'hold' ? 'warn' : '';
  const dl = (pairs) => '<dl>' + pairs.map(([k, v]) => '<dt>' + esc(k) + '</dt><dd>' + v + '</dd>').join('') + '</dl>';
  const table = (cols, rows) => rows.length === 0 ? '<p class="empty">none</p>'
    : '<table><thead><tr>' + cols.map((c) => '<th>' + esc(c) + '</th>').join('') + '</tr></thead><tbody>'
      + rows.map((r) => '<tr>' + r.map((c) => '<td>' + c + '</td>').join('') + '</tr>').join('') + '</tbody></table>';

  function championPanel(c) {
    const replay = c.replay.equal ? '<span class="ok">ok</span>'
      : '<span class="bad">mismatch</span> missing in file: ' + esc(c.replay.missingInFile.join(', ') || '—') + '; extra in file: ' + esc(c.replay.extraInFile.join(', ') || '—');
    return '<section><h2>Champion</h2>' + dl([
      ['state sha', c.state_sha ? '<code>' + esc(c.state_sha) + '</code>' : '<span class="empty">no promotion yet</span>'],
      ['kept rows', c.kept.length === 0 ? '<span class="muted">—</span>' : c.kept.map((k) => esc(k.surface) + ' <code>' + esc(k.ref) + '</code> (' + link(k.challenger_id) + ')').join('<br>')],
      ['skill ref', c.skill_ref ? '<code>' + esc(c.skill_ref) + '</code>' : '<span class="muted">—</span>'],
      ['promoted at', esc(c.promoted_at ?? '—')],
      ['replay check', replay],
      ['route', c.route ? esc(c.route.loop) + ' / ' + esc(c.route.model) : '<span class="muted">—</span>'],
    ]) + '</section>';
  }

  function settlementPanel(s) {
    return '<section><h2>Last settlement</h2>' + (!s ? '<p class="empty">none</p>' : dl([
      ['kind', esc(s.kind)], ['as of', esc(s.as_of)],
      ['settled / pending', esc(s.n_settled) + ' / ' + esc(s.n_pending)],
      ['truth snapshot', '<code>' + esc(s.truth_snapshot_id) + '</code>'],
      ['rows re-scored', s.triggered_rescoring.length === 0 ? '<span class="muted">—</span>' : s.triggered_rescoring.map(link).join(' ')],
      ['demoted', s.demoted.length === 0 ? '<span class="muted">none</span>' : '<span class="bad">' + s.demoted.map(link).join(' ') + '</span>'],
    ])) + '</section>';
  }

  function tiersPanel(tiers) {
    const cols = ['id', 'parent', 'surface', 'intent', 'status', 'verdict', 'compare', 'proposer', 'attempts', 'facts sha'];
    let html = '<section><h2>Challengers by tier</h2>';
    for (const tier of ['smoke', 'holdin', 'holdout', 'live']) {
      const rows = tiers[tier] ?? [];
      html += '<h3>' + tier + ' (' + rows.length + ')</h3>' + table(cols, rows.map((r) => [
        link(r.id), '<code>' + short(r.parent) + '</code>', esc(r.surface), esc(r.intent), esc(r.status),
        r.verdict ? '<span class="' + cls(r.verdict.value) + '">' + esc(r.verdict.value) + '</span> <span class="muted">' + esc(r.verdict.rule) + ' · ' + esc(r.gate_method ?? r.verdict.by) + '</span>' : '<span class="muted">—</span>',
        r.compare ? 'mean ' + num(r.compare.mean) + ' ci [' + num(r.compare.ci[0]) + ', ' + num(r.compare.ci[1]) + '] n_eff ' + esc(r.compare.n_eff) + ' mde ' + num(r.compare.mde) + ' cost ' + num(r.compare.cost_ratio, 2) : '<span class="muted">—</span>',
        '<code>' + esc(r.proposer) + '</code>',
        esc(r.attempts.n) + ' <span class="muted">' + esc(Object.entries(r.attempts.by_status).map(([k, v]) => k + ':' + v).join(' ')) + '</span>',
        r.facts_sha.map((f) => '<code>' + short(f) + '</code>').join(' '),
      ]));
    }
    return html + '</section>';
  }

  function signoffPanel(list) {
    return '<section><h2>Pending sign-offs</h2>' + table(['row', 'action', 'expires', 'confirm command'],
      list.map((p) => [link(p.rowId), esc(p.action), esc(p.expiresAt), '<pre>' + esc(p.command) + '</pre>'])) + '</section>';
  }

  function detailPanel(d) {
    const r = d.row;
    const coords = ['id', 'patch_sha', 'harness_sha', 'env_sha', 'skill_sha', 'taskset_sha', 'optimizer_config_sha', 'truth_snapshot_id', 'scorer_version', 'report_rule_version']
      .map((k) => [k, '<code>' + esc(r[k]) + '</code>']);
    coords.push(['route', '<code>' + esc(JSON.stringify(r.route)) + '</code>'], ['intent', esc(r.intent)], ['status', esc(r.status)],
      ['verdict', r.verdict ? '<span class="' + cls(r.verdict.value) + '">' + esc(r.verdict.value) + '</span> ' + esc(r.verdict.rule) + ' by ' + esc(r.verdict.by) : '—']);
    const scoresByAttempt = {};
    for (const s of d.scores) { if (s.redacted) continue; (scoresByAttempt[s.attempt_id] ||= []).push(s.metric + '=' + s.value); }
    const attempts = table(['attempt', 'task', 'sample', 'tier', 'status', 'stop', 'cost', 'scores'], d.attempts.map((a) => a.redacted
      ? ['<span class="muted">' + esc(a.tier) + ' aggregate</span>', '—', '—', esc(a.tier), esc(JSON.stringify(a.by_status)), '—', '—', esc(a.n) + ' attempts']
      : ['<code>' + short(a.id) + '</code>', esc(a.task_id), esc(a.sample), esc(a.tier), esc(a.status), esc(a.stop_reason),
        esc(JSON.stringify(a.cost)), esc((scoresByAttempt[a.id] ?? []).join(' '))]));
    const aggregates = d.scores.filter((s) => s.redacted).map((s) => esc(s.metric) + ' mean ' + num(s.mean) + ' over ' + esc(s.n));
    const compares = table(['vs', 'tier', 'truth', 'mean', 'ci', 'n_eff', 'mde', 'rule', 'verdict', 'method', 'at'], d.compares.map((c) => [
      link(c.vs_id), esc(c.tier), '<code>' + short(c.truth_snapshot_id) + '</code>', num(c.mean), '[' + num(c.ci[0]) + ', ' + num(c.ci[1]) + ']', esc(c.n_eff), num(c.mde),
      esc(c.rule_fired), '<span class="' + cls(c.verdict.value) + '">' + esc(c.verdict.value) + '</span>', esc(c.method), esc(c.at)]));
    const consents = table(['id', 'action', 'who', 'channel', 'at'], d.consents.map((c) => ['<code>' + short(c.id) + '</code>', esc(c.action), esc(c.who), esc(c.channel), esc(c.at)]));
    const p = d.prediction_vs_observed;
    const prediction = dl([
      ['predicted', esc(p.predicted.metric) + ' ' + esc(p.predicted.direction) + (p.predicted.magnitude != null ? ' by ' + esc(p.predicted.magnitude) : '')],
      ['predicted fixes', esc((p.predicted.predicted_fixes ?? []).join(', ') || '—')],
      ['at risk', esc((p.predicted.at_risk ?? []).join(', ') || '—')],
      ['observed', p.observed.length === 0 ? '<span class="muted">no judged compare carries it</span>'
        : p.observed.map((o) => esc(o.tier) + ': fixes hit ' + esc(o.fixes_hit) + ', at-risk hit ' + esc(o.at_risk_hit)).join('<br>')],
    ]);
    return '<section><h2>Challenger <code>' + short(r.id) + '</code> <a href="' + BASE + '" class="muted">← back</a></h2>' + dl(coords)
      + '<h3>Lineage</h3>' + d.lineage.map((l) => link(l.id) + ' <span class="muted">' + esc(l.surface) + ' ' + esc(l.status) + ' ' + esc(l.verdict ?? '') + '</span>').join(' → ')
      + '<h3>Attempts</h3>' + attempts + (aggregates.length ? '<p class="muted">held-out aggregates: ' + aggregates.join('; ') + '</p>' : '')
      + '<h3>Compares</h3>' + compares + '<h3>Consents</h3>' + consents + '<h3>Prediction vs observed</h3>' + prediction + '</section>';
  }

  async function getJson(path) {
    const res = await fetch(BASE + path, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(path + ' → ' + res.status);
    return res.json();
  }

  async function refresh() {
    try {
      const id = new URLSearchParams(location.search).get('challenger');
      const s = await getJson('/api/summary');
      let html = championPanel(s.champion) + settlementPanel(s.lastSettlement) + tiersPanel(s.tiers) + signoffPanel(s.pendingSignoffs);
      if (id) {
        const d = await getJson('/api/challenger/' + encodeURIComponent(id));
        html = detailPanel(d) + html;
      }
      app.innerHTML = html;
      status.textContent = 'updated ' + new Date().toLocaleTimeString() + ' · every ' + (REFRESH / 1000) + 's';
    } catch (e) {
      status.textContent = 'error: ' + (e && e.message ? e.message : e);
    }
  }

  refresh();
  setInterval(refresh, REFRESH);
})();
</script>
</body>
</html>
`
}
