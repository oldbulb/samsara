// The design language of every page, inlined: dsh's `--dsw-*` alias tokens
// (light on `body`, dark on `body[data-ds-dark-theme]`), the bootstrap that
// resolves the theme before first paint, the house recipes, and the document
// skeleton with the text wordmark. Reference: docs/design/notes/dsh-design-language-2026-08-26.md.
// Nothing here reads data; pages hand `shell` a finished body.

/** The alias tokens, light on `body` and dark on `body[data-ds-dark-theme]`. */
export function tokensCss(): string {
  return `body {
  --dsw-alias-bg-base: #fff; --dsw-alias-bg-layer-1: #fff; --dsw-alias-bg-layer-2: #fff; --dsw-alias-bg-layer-3: #fff;
  --dsw-alias-bg-module-platform: rgb(245,246,247); --dsw-specific-sidebar-fill: rgb(249,250,251);
  --dsw-alias-border-l1: rgba(0,0,0,.04); --dsw-alias-border-l2: rgba(0,0,0,.10); --dsw-alias-border-l3: rgba(0,0,0,.12);
  --dsw-alias-label-primary: rgb(15,17,21); --dsw-alias-label-secondary: rgb(97,102,107); --dsw-alias-label-tertiary: rgb(129,133,140); --dsw-alias-label-caption: rgb(173,178,184);
  --dsw-alias-interactive-bg-hover: rgba(38,49,72,.06); --dsw-alias-interactive-bg-active: rgba(38,49,72,.10);
  --dsw-alias-state-business-primary: rgb(65,118,230); --dsw-alias-state-business-tertiary: rgb(228,237,253);
  --dsw-alias-state-success-primary: rgb(34,197,94); --dsw-alias-state-success-tertiary: rgb(230,250,237);
  --dsw-alias-state-warn-label: rgb(221,134,41); --dsw-alias-state-warn-tertiary: rgb(254,245,231);
  --dsw-alias-state-error-primary: rgb(236,19,19); --dsw-alias-interactive-bg-hover-danger: rgba(236,19,19,.05);
  --dsw-alias-markdown-code-block: rgb(249,250,251); --dsw-alias-markdown-inline-code: rgb(235,238,242);
  --dsw-shadow-lv1: 0 2px 4px 0 rgba(0,0,0,.05);
  --dsw-shadow-lv3: 0 0 1px 0 rgba(0,0,0,.2), 0 0 4px 0 rgba(0,0,0,.02), 0 12px 32px 0 rgba(0,0,0,.08);
  --ds-ease-in-out: cubic-bezier(.4,0,.2,1); --ds-transition-duration: .2s;
  --dsw-font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif;
  --ds-font-family-code: 'SF Mono', 'JetBrains Mono', 'Fira Code', Consolas, 'Liberation Mono', Menlo, Courier, 'PingFang SC', 'Microsoft YaHei';
}
body[data-ds-dark-theme] {
  --dsw-alias-bg-base: rgb(21,21,23); --dsw-alias-bg-layer-1: rgb(35,35,36); --dsw-alias-bg-layer-2: rgb(44,44,46); --dsw-alias-bg-layer-3: rgb(53,54,56);
  --dsw-alias-bg-module-platform: rgb(53,54,56); --dsw-specific-sidebar-fill: rgb(27,27,28);
  --dsw-alias-border-l1: rgba(255,255,255,.06); --dsw-alias-border-l2: rgba(255,255,255,.12); --dsw-alias-border-l3: rgba(255,255,255,.16);
  --dsw-alias-label-primary: rgb(249,250,251); --dsw-alias-label-secondary: rgb(207,211,214); --dsw-alias-label-tertiary: rgb(173,178,184); --dsw-alias-label-caption: rgb(129,133,140);
  --dsw-alias-interactive-bg-hover: rgba(255,255,255,.08); --dsw-alias-interactive-bg-active: rgba(255,255,255,.14);
  --dsw-alias-state-business-primary: rgb(103,158,254); --dsw-alias-state-business-tertiary: rgb(52,65,91);
  --dsw-alias-state-success-primary: rgb(34,197,94); --dsw-alias-state-success-tertiary: rgb(35,60,44);
  --dsw-alias-state-warn-label: rgb(221,134,41); --dsw-alias-state-warn-tertiary: rgb(39,36,31);
  --dsw-alias-state-error-primary: rgb(242,90,90); --dsw-alias-interactive-bg-hover-danger: rgba(242,90,90,.15);
  --dsw-alias-markdown-code-block: rgb(27,27,28); --dsw-alias-markdown-inline-code: rgb(44,44,46);
}`
}

/** The house recipes: card, table, badge, pill, stat block, code, focus ring, layout. */
export function recipesCss(): string {
  return `* { box-sizing: border-box; }
html, body { margin: 0; }
body { background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font: 14px/22px var(--dsw-font-family); -webkit-font-smoothing: antialiased; }
h1, h2, h3 { margin: 0; font-weight: 500; }
h1 { font-size: 20px; line-height: 28px; } h2 { font-size: 16px; line-height: 24px; } h3 { font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); }
p { margin: 0; }
a { color: var(--dsw-alias-state-business-primary); text-decoration: none; }
a:hover { text-decoration: underline; }
:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }
code, pre, .tnum { font-family: var(--ds-font-family-code); }
code { font-size: 13px; background: var(--dsw-alias-markdown-inline-code); border-radius: 6px; padding: 0 4px; }
.tnum { font-variant-numeric: tabular-nums; }
.muted { color: var(--dsw-alias-label-tertiary); }
.caption { font-size: 11px; line-height: 14px; color: var(--dsw-alias-label-caption); }
strong, b { font-weight: 500; }

.top { border-bottom: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-specific-sidebar-fill); }
.top-in { max-width: 1200px; margin: 0 auto; padding: 0 20px; height: 44px; display: flex; align-items: center; gap: 16px; }
.wordmark { font-size: 14px; font-weight: 500; letter-spacing: .02em; color: var(--dsw-alias-label-primary); }
.wordmark:hover { text-decoration: none; }
.nav { display: flex; gap: 4px; flex: 1; overflow-x: auto; }
.live { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); white-space: nowrap; }
.page { max-width: 1200px; margin: 0 auto; padding: 16px 20px 48px; display: flex; flex-direction: column; gap: 16px; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; }
section > h2, section > h3 { margin-bottom: 8px; }
.count { font-weight: 400; color: var(--dsw-alias-label-caption); margin-left: 6px; }

.card { border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; background: var(--dsw-alias-bg-layer-3); overflow: hidden; min-width: 0; }
.card-body { padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; }
.card-row { padding: 12px 14px; display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.card-head { padding: 9px 14px; font-size: 13px; line-height: 20px; font-weight: 500; color: var(--dsw-alias-label-secondary); border-bottom: 1px solid var(--dsw-alias-border-l1); }

.tbl { overflow-x: auto; max-width: 100%; }
.card > .tbl { border-top: 1px solid var(--dsw-alias-border-l1); }
table { border-spacing: 0; width: 100%; font-size: 12px; line-height: 18px; background: var(--dsw-alias-bg-layer-1); }
th { height: 30px; padding: 0 8px; text-align: left; font-weight: 500; color: var(--dsw-alias-label-tertiary); background: var(--dsw-specific-sidebar-fill); border-bottom: 1px solid var(--dsw-alias-border-l2); white-space: nowrap; }
td { height: 30px; padding: 0 8px; border-bottom: 1px solid var(--dsw-alias-border-l1); white-space: nowrap; vertical-align: middle; font-variant-numeric: tabular-nums; }
td.wrap { white-space: normal; min-width: 200px; }
tbody tr:last-child td { border-bottom: 0; }
tbody tr:hover td { background: var(--dsw-alias-interactive-bg-hover); }
tbody tr.selected td { background: var(--dsw-alias-interactive-bg-active); }
tbody tr:focus-within td { box-shadow: inset 0 0 0 1px var(--dsw-alias-state-business-primary); }

.badge { display: inline-flex; align-items: center; height: 22px; padding: 0 4px; border-radius: 6px; font-size: 13px; line-height: 20px; font-weight: 500; white-space: nowrap; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-module-platform); }
.badge.ok { color: var(--dsw-alias-state-success-primary); background: var(--dsw-alias-state-success-tertiary); }
.badge.warn { color: var(--dsw-alias-state-warn-label); background: var(--dsw-alias-state-warn-tertiary); }
.badge.danger { color: var(--dsw-alias-state-error-primary); background: var(--dsw-alias-interactive-bg-hover-danger); }
.badge.neutral { color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-module-platform); }
.badge.outline { background: transparent; box-shadow: inset 0 0 0 1px currentColor; }
.badge.shadow { box-shadow: var(--dsw-shadow-lv1); }
.pill { display: inline-flex; align-items: center; height: 24px; padding: 0 8px; border-radius: 12px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); white-space: nowrap; }
a.pill:hover { text-decoration: none; background: var(--dsw-alias-interactive-bg-hover); }
.pill.active { color: var(--dsw-alias-label-primary); box-shadow: inset 0 0 0 1px var(--dsw-alias-border-l3); }
.dot { display: inline-block; width: 7px; height: 7px; border-radius: 999px; background: var(--dsw-alias-label-caption); vertical-align: middle; }
.dot.ok { background: var(--dsw-alias-state-success-primary); } .dot.warn { background: var(--dsw-alias-state-warn-label); } .dot.danger { background: var(--dsw-alias-state-error-primary); }

.stat { display: grid; grid-template-columns: fit-content(180px) minmax(0, 1fr); column-gap: 12px; margin: 0; padding: 0 14px; font-size: 13px; line-height: 20px; }
.stat dt { min-height: 22px; min-width: 94px; padding: 1px 0; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }
.stat dd { min-height: 22px; padding: 1px 0; margin: 0; color: var(--dsw-alias-label-primary); overflow-wrap: anywhere; }

.code { background: var(--dsw-alias-markdown-code-block); border-radius: 12px; margin: 8px 0; overflow: hidden; }
.code-head { display: flex; justify-content: space-between; align-items: center; padding: 9px 14px; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-tertiary); }
.code pre { margin: 0; padding: 16px; font-size: 13px; line-height: 22px; white-space: pre-wrap; word-break: break-all; }
.copy { font: inherit; font-weight: 500; color: var(--dsw-alias-state-business-primary); background: none; border: 0; padding: 0 4px; border-radius: 6px; cursor: pointer; }
.copy:hover { background: var(--dsw-alias-interactive-bg-hover); }

.callout { padding: 10px 14px; border-radius: 10px; font-size: 13px; line-height: 20px; background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-secondary); }
.callout.ok { background: var(--dsw-alias-state-success-tertiary); } .callout.warn { background: var(--dsw-alias-state-warn-tertiary); } .callout.danger { background: var(--dsw-alias-interactive-bg-hover-danger); }
.empty { font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-tertiary); }
.bar { height: 6px; border-radius: 3px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; }
.bar > i { display: block; height: 100%; background: var(--dsw-alias-state-business-primary); }

.chart { overflow-x: auto; max-width: 100%; }
.chart svg { display: block; width: 100%; height: auto; color: var(--dsw-alias-label-secondary); }
.chart .axis { font-size: 10px; fill: var(--dsw-alias-label-caption); }
.chart .band { fill: color-mix(in srgb, var(--dsw-alias-state-business-primary) 22%, var(--dsw-alias-bg-layer-1)); }
.sparkline { display: inline-block; width: 100px; height: 24px; vertical-align: middle; color: var(--dsw-alias-label-secondary); }`
}

/** dsh's boot-theme, copied: resolve `system` before first paint, set colorScheme and the body attribute. */
export function bootstrapScript(): string {
  return `<script>(()=>{const p='system';const d=p==='dark'||(p==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);
document.documentElement.style.colorScheme=d?'dark':'light';document.body.toggleAttribute('data-ds-dark-theme',d)})()</script>`
}

export type NavKey = 'home' | 'experiments' | 'rounds' | 'servings' | 'bench'

export interface NavItem {
  label: string
  href: string
  active?: boolean
}

/** The five entries of the top nav under `base`, `active` marked. Rounds live on the home page (the open ones) and under experiments. */
export function navOf(base: string, active?: NavKey): NavItem[] {
  const items: [NavKey, string, string][] = [
    ['home', 'Home', `${base}/`],
    ['experiments', 'Experiments', `${base}/experiments`],
    ['rounds', 'Rounds', `${base}/#rounds`],
    ['servings', 'Servings', `${base}/servings`],
    ['bench', 'Bench', `${base}/bench`],
  ]
  return items.map(([key, label, href]) => ({ label, href, ...(key === active ? { active: true } : {}) }))
}

export interface ShellInput {
  title: string
  nav: NavItem[]
  /** The finished `<main>` content. */
  body: string
  /** Where the wordmark links; the first nav entry when absent. */
  base?: string
  /** When set, the page swaps its `<main>` for a fresh copy every `refreshMs` (no JS: the page is complete as served). */
  refreshMs?: number
}

/** Fired on `document` after every swap of `<main>`, for scripts that hold on to its nodes. */
export const REFRESHED_EVENT = 'samsara:refreshed'

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** One inline `<style>` per page: tokens then recipes. */
export function styleTag(): string {
  return `<style>\n${tokensCss()}\n${recipesCss()}\n</style>`
}

/** The document: skeleton, tokens, bootstrap right after `<body>`, the wordmark and nav, `body` inside `<main>`. */
export function shell(input: ShellInput): string {
  const home = input.base || input.nav[0]?.href || '/'
  const nav = input.nav.map((n) => `<a class="pill${n.active ? ' active' : ''}" href="${esc(n.href)}"${n.active ? ' aria-current="page"' : ''}>${esc(n.label)}</a>`).join('')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${esc(input.title)} · samsara</title>
${styleTag()}
</head>
<body>
${bootstrapScript()}
<header class="top"><div class="top-in">
  <a class="wordmark" href="${esc(home)}">samsara</a>
  <nav class="nav" aria-label="Sections">${nav}</nav>
  <span class="live" id="live"></span>
</div></header>
<main class="page" id="main">
${input.body}
</main>
${copyScript()}${input.refreshMs ? refreshScript(input.refreshMs) : ''}</body>
</html>
`
}

/** The copy buttons of the code blocks, on every page (a page without refresh has them too). */
function copyScript(): string {
  return `<script>
document.addEventListener('click', (ev) => {
  const btn = ev.target.closest('button.copy');
  if (!btn) return;
  const done = () => { btn.textContent = 'copied'; setTimeout(() => { btn.textContent = 'copy'; }, 1200); };
  if (navigator.clipboard) navigator.clipboard.writeText(btn.dataset.copy).then(done, () => {});
});
</script>
`
}

/** Re-fetches the page and swaps `<main>`, then fires `REFRESHED_EVENT`. */
function refreshScript(refreshMs: number): string {
  return `<script>
(() => {
  const REFRESH = ${JSON.stringify(refreshMs)};
  const main = document.getElementById('main');
  const live = document.getElementById('live');
  let refreshedAt = Date.now();
  let failed = false;
  async function refresh() {
    try {
      const res = await fetch(location.href, { headers: { accept: 'text/html' } });
      if (!res.ok) throw new Error('\\u2192 ' + res.status);
      const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
      const next = doc.getElementById('main');
      if (next) main.innerHTML = next.innerHTML;
      refreshedAt = Date.now();
      failed = false;
      tick();
      document.dispatchEvent(new Event(${JSON.stringify(REFRESHED_EVENT)}));
    } catch (e) {
      failed = true;
      live.textContent = 'error: ' + (e && e.message ? e.message : e);
    }
  }
  function tick() {
    if (failed) return;
    live.textContent = 'refreshed ' + Math.max(0, Math.round((Date.now() - refreshedAt) / 1000)) + 's ago \\u00b7 every ' + (REFRESH / 1000) + 's';
  }
  tick();
  setInterval(refresh, REFRESH);
  setInterval(tick, 1000);
})();
</script>
`
}
