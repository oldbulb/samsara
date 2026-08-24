# /samsara page — visual system (borrowed from Internal)

Borrowed from Internal, an internal design system, whose brief this page follows: "light slate + violet + semantic palette, governed by Linear's restraint: single accent for action/focus only, surface-lift over shadow, progressive negative tracking, 8px radii not pills, quiet / dense / precise / fast". Its tokens are reproduced in full below, so this file is the whole source of truth — nothing private is needed to build or change the page. The samsara page copies the tokens verbatim and the idioms below; it stays a single self-contained HTML file (no build, no external assets; fonts fall back to the system stack when Maple Mono / MiSans are not installed).

## Tokens (`:root`, copy verbatim)

```css
--color-canvas:#f8fafc; --color-surface-1:#ffffff; --color-surface-2:#f8fafc; --color-sunken:#f1f5f9;
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
--ease:cubic-bezier(.2,0,0,1); --dur-fast:.12s; --dur-base:.18s; --page-max:1280px; --header-h:56px;
```

Dark mode: Internal is light-only; the samsara page keeps a `prefers-color-scheme: dark` override that only re-maps the surface/ink/border ladder (canvas `#0b1220`, surface-1 `#0f172a`, sunken `#1e293b`, border `#1f2937`, ink `#e2e8f0`, ink-soft `#cbd5e1`, ink-muted `#94a3b8`) and keeps accent/semantic colors.

## Idioms

- **Body**: mono family at 14px on `canvas`; headings mono, 700, negative tracking (`h1 -0.025em`, `h2 -0.02em`, `h3 600 -0.01em`); numbers/ids/shas use `.tnum` (tabular figures).
- **Eyebrow**: 12px mono, 600, `letter-spacing .06em`, uppercase, `ink-muted` — the kicker above every section ("CHAMPION", "LAST SETTLEMENT", "CHALLENGERS · SMOKE").
- **Header**: sticky 56px, `surface-1`, 1px `border` bottom, brand = 24px rounded-md violet square with a white "S" + "samsara" small semibold; right side: live dot + "refreshed 3s ago" caption.
- **Cards**: `surface-1`, 1px `border`, `radius-lg`, padding 24px, no shadow; hover lifts with `shadow-hover` only on clickable rows/cards.
- **Tables**: header cells 12px mono `ink-muted` on `sunken`, `border-bottom`; body rows 13px, 1px `border` dividers, `surface-2` on hover; monospace tabular numbers; sha columns truncated to 12 chars with full value in `title`.
- **Badges** (verdicts, statuses): pill, 11px mono 600, `*-soft` bg + semantic fg + soft border. Map: `promote`→pos, `drop`→risk, `hold`/`hold:underpowered`→warn, `invalid`→risk, `COMPLETED`→pos, `TRUNCATED`→warn, `ABORTED`/`FAILED`→risk, tiers→neutral, `gate-permissive@test`→warn.
- **Callouts**: left 3px semantic border + `*-soft` bg, `radius-md`, 13px — used for "no champion yet", "sign-off pending: copy this command", errors.
- **Code/commands**: the one dark surface (`code-bg`, `#e2e8f0` text, 12.5px) for the sign-off command block, with a copy button (accent text, no fill).
- **Accent discipline**: violet only for links, the active nav state, focus rings, the brand mark; never as a decorative fill.
- **Density**: page max 1280px, 24px gutters, 32px between sections, 12px inside cards; no empty-state illustrations — a one-line muted sentence.
- **Motion**: 120–180ms `ease` color transitions only.

## Page structure (unchanged from ui-and-certification.md)

Header → Champion card (state sha, kept rows, skill ref, promoted at, replay check badge, route) → Last settlement card → Challengers by tier (four tables, tier eyebrow + count) → Pending sign-offs (command block) → drill-down panel when `?challenger=` (coordinates grid, lineage breadcrumb, attempts table, compares, consents, prediction vs observed).
