# P6 — UI and cross-harness certification

## UI: the experiments view

Decision already made: an independent route, not a dsh client-plugin. The host plugin (`packages/ui`, row `samsara-ui`) registers one `prefix` route under `basePath` (default `/samsara`) on `ctx.webServer` through `ctx.effect`; the pages are self-contained HTML in dsh's own design language — no build step, no external assets, no client bundle. Everything is read-only: sign-off never goes through HTTP (E2) — where a consent is pending the page shows the exact `/samsara approve <id>` or `samsara-signoff confirm …` command to copy, socket path filled in, key and signer left as placeholders.

The single `/samsara` page of the first design (four panels and a `?challenger=` drill-down) is now the overview, one page among several. What replaced it is the **experiments view**: the ledger rendered along the lifecycle — experiment → rounds → challengers → servings — so that every verdict can be read next to the pre-registered claim it answers, the gate it was judged under, the noise floor it was measured against and the consent that adopted it. The pages, in the order a reader descends:

1. **Overview** (`/`, `/index`) — status strip (champion, active experiments, open rounds, pending consents, latest noise floor per eval config; onboarding hints when the ledger is empty), then the four original panels: champion, last settlement, challengers by tier, pending sign-offs. `?challenger=<id>` renders the evidence page above them.
2. **Experiments** (`/experiments`, `/experiments/<id>`) — every pre-registered experiment with hypothesis, prediction, gate, rounds, promotions, spent against budget and status; one experiment with its budget bars, the rounds table (the promotion verdict plus one column per shadow gate; n_eff, mde, replicates, status), the lineage curve, predicted vs observed, pending consents.
3. **Round** (`/rounds/<id>`) — the gate pinned as `name@version` with its policy sha, the shadow gates, the noise floor used, the siblings with their compares side by side, the outcome, the next actions per sibling with their costs, and live progress while the round is open.
4. **Challenger** (`/challengers/<id>`) — the evidence page: coordinates (every sha), prediction, lineage to the champion, attempts, per-tier compares with the shadow badge and gate, consents, links to the round and the experiment.
5. **Servings** (`/servings`) — the champion history: from / to, by, consent, profile sha.
6. **Bench** (`/bench`) — the `gate bench --out` results under `data/bench/`, filtered by `?gates=` and `?resamples=`.
7. **Notebook** (`/notebook/<session>`) — one operator session's mirrored events (`packages/workbench`), each linking to the round or experiment it touched.

Three properties hold on every page:

- **A JSON twin.** Each page answers at its path with `.json` appended; the twin carries every number on the page and ends in `sources: [...]`, the ids of the ledger rows the numbers came from. The tests assert that no numeric cell on a page is missing from its twin.
- **One viewer.** Every read is `ctx.ledger.read(view, 'operator')`: the route has no auth and a proposer on the same host can reach loopback, so held-out attempts and scores arrive as per-challenger aggregates and no compare row carries its per-task deltas (S7). The page has no way to ask for another viewer.
- **No statistic.** A page formats what the ledger recorded and what the lifecycle helpers answer (`status`, `nextActions`); it computes nothing.

The `lifecycle` service is optional and looked up per request, so its row may mount after the UI's: with it the round page gains next actions with costs, pending consents and the live stream; without it the pages still render.

**Live progress.** `/rounds/<id>/events` is a `text/event-stream` of every `lifecycle/event` that names the round (`challenger/transition`, `attempt/progress`, `round/closed`, `round/decided`, `campaign` …), with a judged compare's `per_task` stripped before it goes on the wire, a heartbeat comment every `refreshMs`, closed when the client goes away. The round page is complete without it; its few lines of JS only move the sibling status and attempt counters between two refreshes.

**Legacy API** (kept for the first consumers, all GET, JSON): `/api/summary` → `{champion, lastSettlement, tiers: {smoke, holdin, holdout, live}, pendingSignoffs}`; `/api/challenger/:id` → `{row, lineage, attempts, scores, compares, consents, prediction_vs_observed}`; `/api/certify/:skillSha` → the certification table below.

The route table with every path, page and twin, the design-language notes (dsh's `--dsw-*` tokens, the `body[data-ds-dark-theme]` contract, the badge and chart recipes) and the fixture-rendering tool are in [`packages/ui/README.md`](../../packages/ui/README.md).

## Cross-harness certification

A skill is *certified* on a harness when a challenger carrying that skill (same `skill_sha`) has a judged compare row on that harness under the default gate. The certification table for one skill sha has one row per loop:

| loop | adapter version | facts_sha | tasks | `<metric>` mean | utilization | cost mean | verdict | gate |
|---|---|---|---|---|---|---|---|---|

- `utilization` = fraction of attempts in which the skill was actually delivered and read: loops-dsh counts a `skill` tool call or the `samsara:skill` prompt section present (prompt-inline ⇒ 1.0 by construction, reported as `inline`); loops-claude-code reports `inline` the same way; a harness that discovers skills from a directory reports the read fraction. Utilization and the metric are separate columns so "the harness ignored the skill" is never read as "the skill is bad". The metric column carries the pack's primary metric (`--metric`); the API's `valid_rate` is the fraction of attempts with a valid output, not a metric.
- **Facts mismatch refusal**: the gate refuses to compare two rows whose `facts_sha` differ (`invalid`, rule `facts:mismatch`). Certification therefore never pools loops; it lists them.
- A revocation (demote / reversed verdict) shows in the table as `revoked` with the settlement id.

Command: `dsh --profile host certify --pack … --skill-dir … --loops dsh,claude-code --set smoke --limit n` runs the challenger on each loop (champion on each loop too when missing), judges per loop, prints the table, and the API serves the same from the ledger.

## Out of scope for P6

Sign-off through the page; live tier; editing anything from the page.
