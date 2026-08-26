# @oldbulb/samsara-ledger

`ctx.ledger` — the one control-plane record: challengers, attempts, scores,
compares, consents, settlements, rounds, noise floors, servings, experiments,
notebook. A cordis `Service` over the dsh storage
domain `samsara_ledger` (version 0). Writes go through the domain tables
(durability first, then memory); reads are synchronous from the domain's
in-memory state. The ledger never mirrors: there is exactly one open domain per
host, routed to whichever backend `storage-domain` is configured with.

Design: `docs/design/architecture.md` → "Ledger data model", "Lifecycle", E6.

## Tables and keys

| table | key | row |
|---|---|---|
| `challengers` | `id = sha256(canonicalJson([parent_ids, patch_sha, harness_sha, env_sha, skill_sha, taskset_sha, route, optimizer_config_sha, environment_sha?]))` — `challengerId(coords)`; `environment_sha` joins the tuple only when present, so ids recorded before it existed are unchanged | coordinates (`environment_sha?`: `environmentSha` of the environment facts — image digest, resources, network, never the provider — rule 0) + `lineage`, `surface`, `patch`, `intent`, `pack`, `prediction`, evaluation-artifact versions, `runtime`, `tasksets`, `budget`, `eval_config_sha?` (derived: `evalConfigSha(row)` = `sha256(canonicalJson({pack, tasksets, task_version, scorer_version, truth_snapshot_id, report_rule_version, judge_model_version}))`, not part of the id), `opened?` (`{harness_sha, env_sha, profile_sha, at}`), `tier_reached?`, `status` (`proposed\|opened\|running\|judged\|decided`), `verdict?` (`{value invalid\|drop\|hold\|hold:superseded\|promote\|confirmed\|reversed, by, rule, round_id?, consent_id?}`), `proposed_at` |
| `attempts` | `id` (the attempt id the runner/loop assigned) | `challenger_id`, `task_id`, `sample`, `loop`, **`tier`** (`smoke\|holdin\|holdout\|live`, drives redaction), `status` (`COMPLETED\|TRUNCATED\|ABORTED\|FAILED`), `stop_reason`, `facts_sha`, `usage`, `cost`, `output`, `artifacts[]`, `ephemeral_tools?`, `skill_utilization?`, `environment?` (`{provider, version, image? {ref?, digest?}, resources {cpus?, memoryMb?, timeoutS}, network none\|allowlist\|public, allowedHosts?}`: where the attempt ran, as the provider reported it — `attemptEnvironmentSchema`, the shape of `EnvironmentFacts` without importing it) |
| `scores` | `sha256([attempt_id, scorer_version, truth_snapshot_id, metric])` — `scoreKey(row)` | `value`, `kind` (`mechanical\|reality\|judge`), `stratum?` |
| `compares` | `sha256([challenger_id, vs_id, tier, truth_snapshot_id, replicates ?? 1])` — `compareKey(row)`; a shadow row keys on its `gate` too | `per_task[]`, `mean`, `ci`, `method`, `cluster_key`, `holm?` (`m`/`rank` real when the round has k > 1), `n_eff`, `mde`, `round_id?`, `replicates?`, `min_effect?`, `sd_source?` (`noise_floor\|comparison`), `cost_budget?`, `rule_fired`, `verdict`, `holdout_budget_remaining?`, `predicted_vs_observed?`, `gate?`, `shadow?`, `ladder?` (`{step, beat_best, best_so_far?}`), `at` |
| `consents` | `id` | `challenger_id`, `action` (`promote\|demote\|reject\|reopen\|eval_config_change\|gate_change\|holdout_reveal`; mirrored by `SIGNOFF_ACTIONS` in `@oldbulb/samsara-signoff`), `who`, `channel`, `proof_sha`, `at`, `round_id?` (a `promote`: the round it decides), `proof?` (`{payload, signature}`, re-verified by `signoff.verifyConsent` before a promotion) |
| `settlements` | `id` | `kind` (`truth\|scorer\|model\|taskset`), `taskset_sha`, `as_of`, `truth_snapshot_id`, `n_settled`, `n_pending`, `triggered_rescoring[]` |
| `rounds` | `id = sha256(canonicalJson({eval_config_sha, champion_id, gate, opened_at, experiment_id?}))` — `roundId(coords)` | `gate` (`{name, version, policy_sha}`), `shadow_gates[]`, `noise_floor_id?`, `k` (= `sibling_ids.length`), `sibling_ids[]`, `best_so_far?`, `profile_sha?` (the champion state sha the round opened against), `experiment_id?`, `operator?` (`{session_id?, provider?, model?}`), `status` (`open\|judged\|decided`), `opened_at`, `closed_at?`, `outcome?` (`{promoted?, superseded[], consent_id?}`) |
| `noise_floors` | `id = sha256(canonicalJson({eval_config_sha, champion_id, loop, metric, measured_at}))` — `noiseFloorId(coords)` | `unit` (`task\|entity`), `sd_paired`, `n_reruns`, `n_tasks`, `tier`, `measured_at` |
| `servings` | `id` | `champion_id`, `from`, `to?`, `by` (`promote\|demote\|reversed`), `consent_id?`, `profile_sha` |
| `experiments` | `id = sha256(canonicalJson({hypothesis, prediction, pack, gate, auto_reveal?, created_by, created_at}))` — `experimentId(coords)`; the budget is not in it | `hypothesis`, `prediction` (`{metric, direction, magnitude?}`), `pack`, `gate`, `auto_reveal?` (pre-registered: the campaign runs the held-out tier without a `holdout_reveal` consent per row), `budget` (`{usd?, attempts?, rounds?, holdout_reveals?}`), `spent` (`{usd, attempts, rounds, holdout_reveals}`), `created_by` (`{who?, session_id?, command_id?, channel}`), `created_at`, `status` (`active\|closed`), `closed_at?`, `round_ids[]`, `budget_changes?[]` (`{at, session_id?, command_id?, budget}`: every budget the row had after the pre-registered one, oldest first) |
| `notebook` | `id` (the caller's; one per session event) | `session_id`, `seq` (position in the session), `at`, `kind` (`tool/call\|tool/result\|approval/asked\|approval/decided\|command/run\|command/done\|job/done`), `name` (the tool, command or job kind), `args_sha`, `result_sha?`, `error?` (a failed result's harness error code, else `ERROR`), `round_id?`, `experiment_id?`, `operator` (`{provider?, model?}`) — the workbench's mirror of an operator session's decision-relevant events, as content addresses |

Row schemas are zod (`src/spec.ts`); every write parses first, so a malformed
row never reaches the medium, and the domain re-validates every stored row on
open.

## Invariants

- **propose is idempotent.** The id is a function of the coordinate tuple only;
  a second `propose` with the same coordinates returns the existing id and
  writes nothing (non-coordinate fields of the second call are ignored).
  `propose` derives `eval_config_sha` from the row's evaluation fields and its
  `pack`; a proposal without `pack` lands as `pack: ''` (the lifecycle service
  is what requires it).
- **Challenger rows are immutable except `status`, `tier_reached`, `verdict`,
  `opened`** (`setStatus`).
- **An attempt id belongs to one challenger.** `recordAttempt` throws
  `LedgerError('ATTEMPT_EXISTS')` when the id is held by another
  `challenger_id`; the same challenger's row replaces the earlier one.
- **Scores are append-only.** `appendScores` skips any row whose key already
  exists and never overwrites; a re-score under a new `truth_snapshot_id` or
  `scorer_version` is a new key and therefore a new row. Returns the keys
  actually written.
- **First verdict wins.** `recordCompare` throws `LedgerError('VERDICT_EXISTS')`
  when a row for `(challenger_id, vs_id, tier, truth_snapshot_id, replicates)`
  exists (a row without `replicates` counts as 1). A new tier, a new truth
  snapshot or a re-judgement over more replicates is a new slot.
- **Consents, settlements, noise floors and notebook rows are immutable by id**
  (re-recording an existing id is a no-op; the notebook is append-only). **A
  serving is immutable except `to`**: recording an existing id with a `to`
  closes it once; nothing reopens it.
- **Rounds and experiments dedupe by id** (`openRound` / `createExperiment`
  return the stored row); their mutable fields go through `updateRound`
  (`status`, `sibling_ids` — `k` follows —, `noise_floor_id`, `best_so_far`,
  `closed_at`, `outcome`) and `updateExperiment` (`spent`, `round_ids`,
  `status`, `closed_at`, `budget` with `budget_changes`). The pre-registered
  content of an experiment (its id's coordinates: hypothesis, prediction,
  pack, gate, `auto_reveal`, `created_by`, `created_at`) and the coordinates
  of a round never change; the budget is not in the id, so a raise keeps it,
  with who raised it to what when appended to `budget_changes`.
- **Proposer reads are redacted.** `read(view, 'proposer')` replaces every
  `tier: holdout` attempt with one `{redacted, challenger_id, n, by_status}`
  aggregate per challenger, every score of a holdout attempt (or of an
  attempt the ledger does not know) with one `{redacted, challenger_id, metric,
  scorer_version, truth_snapshot_id, n, mean}` aggregate (`mean` rounded to
  two decimals), and every holdout compare row with `{redacted, challenger_id,
  vs_id, tier, method, rule_fired, verdict, ladder?}` where `ladder` is the
  row's `{beat_best, best_so_far}` with `best_so_far` rounded to two decimals
  (S7: the Ladder signal, never the row's own mean or task count). Shadow
  compare rows are not shown to a proposer at all. `rounds`, `noise_floors`,
  `experiments` and `notebook` are operator objects: the proposer view of them
  is `[]`. `gate` and `human` see every row.
- **Operator reads sit on the human's side of the line, minus per-task
  deltas.** `read(view, 'operator')` (the workbench session) returns attempts
  and scores exactly as `'proposer'` does (held-out per-task rows never
  rendered), compares as `'human'` does but with `per_task` stripped from every
  row on every tier (shadow rows and unrounded figures stay), and every other
  table whole.
- **Restart-stable.** Close and reopen on the same medium and every view reads
  identical contents (tested with the json backend).

## API

```ts
import Ledger, { challengerId, importAttemptsJsonl, LedgerError } from '@oldbulb/samsara-ledger'

// verbs (all async; writes go through the domain's single write chain)
await ctx.ledger.propose(proposal)            // → id (dedupe by id)
await ctx.ledger.setStatus(id, 'judged', { verdict })
await ctx.ledger.recordAttempt(row)           // → id; throws ATTEMPT_EXISTS under another challenger
await ctx.ledger.appendScores(rows)           // → keys written
await ctx.ledger.recordCompare(row)           // → key; throws VERDICT_EXISTS
await ctx.ledger.recordConsent(row)           // → id
await ctx.ledger.recordSettlement(row)        // → id
await ctx.ledger.openRound(input)             // → RoundRow (dedupe by id; k = sibling_ids.length)
await ctx.ledger.updateRound(id, { sibling_ids, status, outcome, … })   // throws UNKNOWN_ROUND
await ctx.ledger.recordNoiseFloor(input)      // → id (immutable by id)
await ctx.ledger.recordServing(row)           // → id (immutable except closing `to`)
await ctx.ledger.createExperiment(input)      // → ExperimentRow (dedupe by id; spent starts at zero)
await ctx.ledger.updateExperiment(id, { spent, round_ids, status, closed_at, budget, budget_changes })   // throws UNKNOWN_EXPERIMENT
await ctx.ledger.recordNotebook(row)          // → id (append-only, immutable by id)

// views (synchronous)
ctx.ledger.challenger(id)
ctx.ledger.attemptsOf(challengerId); ctx.ledger.scoresOf(attemptId)
ctx.ledger.comparesOf(challengerId); ctx.ledger.consentsOf(challengerId)
ctx.ledger.lineage(id)                        // [id, parent, grandparent, …] following parent_ids[0]
ctx.ledger.round(id); ctx.ledger.roundsOf(championId)                       // oldest first
ctx.ledger.noiseFloorFor(eval_config_sha, champion_id, loop, metric)       // latest by measured_at
ctx.ledger.servings(); ctx.ledger.experiment(id); ctx.ledger.experiments()  // oldest first
ctx.ledger.notebookOf(sessionId)              // one session's rows in `seq` order
ctx.ledger.read('scores', 'proposer' | 'gate' | 'human' | 'operator')

// pure helpers
challengerId(coords); evalConfigSha(row); roundId(coords); noiseFloorId(coords); experimentId(coords)
scoreKey(row); compareKey(row); keyOf(...coords); canonicalJson(v)

// runner bridge: attempts.jsonl (packages/runner) → attempts + scores
await importAttemptsJsonl(ctx.ledger, 'out/attempts.jsonl', { challengerId, loop: 'dsh', tier: 'holdin', scorerVersion: '1' })
```

`importAttemptsJsonl` maps one runner line to one attempt (`sample` parsed from
the trailing `-<n>` of `attemptId`; `tier` from the options, default `holdin`
because the line does not carry it) and one score row per `scores[]` entry
(`truth_snapshot_id` = options value, else the line's `truth.truth_sha`, else
`'unsettled'`). Unparseable lines are counted in `skipped`.

## How to open

In a host profile the ledger is one row after the storage rows:

```yaml
- id: storage
  name: '@deepseek-ai/dsh-storage'
- id: storage-json            # or storage-sqlite
  name: '@deepseek-ai/dsh-storage-json'
  config: { root: <SAMSARA_HOME>/<profile>/storages }
- id: storage-domain
  name: '@deepseek-ai/dsh-storage-domain'
  config: { backend: json, routes: { samsara_ledger: json } }
- id: ledger
  name: '@oldbulb/samsara-ledger'
```

`Ledger` injects `storageDomain`, opens `ledgerDomainSpec` in `[Service.init]`
and closes it in its own effect disposer; the single-open rule of the domain
facility is what makes "one ledger" a load-time fact.

In a bare `Context` (tests): mount `Storage`, register a `JsonStorageBackend`
(also `ctx.provide(storageBackendServiceKey('json'), backend)`), construct a
`DomainFacility({ backend: 'json' })`, `ctx.storage.mount('domain', facility)`,
`ctx.provide('storageDomain', facility)`, then `await ctx.plugin(Ledger)`. All
of these come from `@oldbulb/samsara-kernel`; see `tests/ledger.test.ts`.

```
pnpm --filter @oldbulb/samsara-ledger build
pnpm --filter @oldbulb/samsara-ledger test
```
