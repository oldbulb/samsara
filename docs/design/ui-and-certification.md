# P6 — UI and cross-harness certification

## UI: the `/samsara` page

Decision already made: an independent route, not a dsh client-plugin. The host plugin registers `/samsara` (HTML, self-contained, no build step, no external assets) and `/samsara/api/*` (JSON) on `ctx.webServer`; the page polls the API. The page is read-only: sign-off never goes through HTTP (E2) — the pending sign-offs panel shows the exact `samsara-signoff confirm …` command instead.

First screen, four panels, in this order:

1. **Champion** — state sha, kept rows (surface + content ref), skill ref, promoted_at, replay-check status, route {loop, model} of the last champion attempts.
2. **Last settlement** — kind, as_of, n_settled / n_pending, truth snapshot id, rows re-scored, any demotion it caused.
3. **Challengers by tier** — one table per tier (smoke → holdin → holdout → live): id (short), parent, surface, intent (one line), status, verdict + rule + gate method, compare {mean, ci, n_eff, mde, cost_ratio}, proposer name@version, attempts (n, COMPLETED/TRUNCATED/ABORTED/FAILED), harness facts sha. Held-out per-task numbers are never rendered (the API serves the `human` view; the page has no way to ask for more).
4. **Pending sign-offs** — row id, action, nonce expiry, the confirm command to copy.

Drill-down: `/samsara?challenger=<id>` — the row's coordinates (every sha), lineage chain to the champion, attempts with per-task scores (by tier visibility), compare rows, consents, and the proposal's prediction vs observed (predicted_fixes hit, at_risk hit).

API (all GET, JSON, `human` viewer):
- `/samsara/api/summary` → {champion, lastSettlement, tiers: {smoke: [...], …}, pendingSignoffs}
- `/samsara/api/challenger/:id` → {row, lineage, attempts, scores, compares, consents}
- `/samsara/api/certify/:skillSha` → the certification table below

## Cross-harness certification

A skill is *certified* on a harness when a challenger carrying that skill (same `skill_sha`) has a judged compare row on that harness under the default gate. The certification table for one skill sha has one row per loop:

| loop | adapter version | facts_sha | tasks | pass_rate | utilization | cost mean | verdict | gate |
|---|---|---|---|---|---|---|---|---|

- `utilization` = fraction of attempts in which the skill was actually delivered and read: loops-dsh counts a `skill` tool call or the `samsara:skill` prompt section present (prompt-inline ⇒ 1.0 by construction, reported as `inline`); loops-claude-code reports `inline` the same way; a harness that discovers skills from a directory reports the read fraction. Utilization and pass rate are separate columns so "the harness ignored the skill" is never read as "the skill is bad".
- **Facts mismatch refusal**: the gate refuses to compare two rows whose `facts_sha` differ (`invalid`, rule `facts:mismatch`). Certification therefore never pools loops; it lists them.
- A revocation (demote / reversed verdict) shows in the table as `revoked` with the settlement id.

Command: `dsh --profile host certify --pack … --skill-dir … --loops dsh,claude-code --set smoke --limit n` runs the challenger on each loop (champion on each loop too when missing), judges per loop, prints the table, and the API serves the same from the ledger.

## Out of scope for P6

Sign-off through the page; live tier; editing anything from the page.
