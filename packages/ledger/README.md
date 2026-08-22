# @samsara/ledger

`ctx.ledger` — the one control-plane record: challengers, attempts, scores,
compares, consents, settlements. A cordis `Service` over the dsh storage
domain `samsara_ledger` (version 0). Writes go through the domain tables
(durability first, then memory); reads are synchronous from the domain's
in-memory state. The ledger never mirrors: there is exactly one open domain per
host, routed to whichever backend `storage-domain` is configured with.

Design: `docs/design/architecture.md` → "Ledger data model", "Lifecycle", E6.

## Tables and keys

| table | key | row |
|---|---|---|
| `challengers` | `id = sha256(canonicalJson([parent_ids, patch_sha, harness_sha, env_sha, skill_sha, taskset_sha, route, optimizer_config_sha]))` — `challengerId(coords)` | coordinates + `lineage`, `surface`, `patch`, `intent`, `prediction`, evaluation-artifact versions, `runtime`, `tasksets`, `budget`, `tier_reached?`, `status`, `verdict?`, `proposed_at` |
| `attempts` | `id` (the attempt id the runner/loop assigned) | `challenger_id`, `task_id`, `sample`, `loop`, **`tier`** (`smoke\|holdin\|holdout\|live`, drives redaction), `status` (`COMPLETED\|TRUNCATED\|ABORTED\|FAILED`), `stop_reason`, `facts_sha`, `usage`, `cost`, `output`, `artifacts[]`, `ephemeral_tools?`, `skill_utilization?` |
| `scores` | `sha256([attempt_id, scorer_version, truth_snapshot_id, metric])` — `scoreKey(row)` | `value`, `kind` (`mechanical\|reality\|judge`), `stratum?` |
| `compares` | `sha256([challenger_id, vs_id, tier, truth_snapshot_id])` — `compareKey(row)` | `per_task[]`, `mean`, `ci`, `method`, `cluster_key`, `holm?`, `n_eff`, `mde`, `cost_budget?`, `rule_fired`, `verdict`, `holdout_budget_remaining?`, `predicted_vs_observed?`, `at` |
| `consents` | `id` | `challenger_id`, `action` (`promote\|reject\|reopen\|scorer_bump`), `who`, `channel`, `proof_sha`, `at` |
| `settlements` | `id` | `kind` (`truth\|scorer\|model\|taskset`), `taskset_sha`, `as_of`, `truth_snapshot_id`, `n_settled`, `n_pending`, `triggered_rescoring[]` |

Row schemas are zod (`src/spec.ts`); every write parses first, so a malformed
row never reaches the medium, and the domain re-validates every stored row on
open.

## Invariants

- **propose is idempotent.** The id is a function of the coordinate tuple only;
  a second `propose` with the same coordinates returns the existing id and
  writes nothing (non-coordinate fields of the second call are ignored).
- **Challenger rows are immutable except `status`, `tier_reached`, `verdict`**
  (`setStatus`).
- **Scores are append-only.** `appendScores` skips any row whose key already
  exists and never overwrites; a re-score under a new `truth_snapshot_id` or
  `scorer_version` is a new key and therefore a new row. Returns the keys
  actually written.
- **First verdict wins.** `recordCompare` throws `LedgerError('VERDICT_EXISTS')`
  when a row for `(challenger_id, vs_id, tier, truth_snapshot_id)` exists. A new
  tier or a new truth snapshot is a new slot.
- **Consents and settlements are immutable by id** (re-recording an existing id
  is a no-op).
- **Proposer reads are redacted.** `read(view, 'proposer')` replaces every
  `tier: holdout` attempt with one `{redacted, challenger_id, n, by_status}`
  aggregate per challenger, and every score of a holdout attempt (or of an
  attempt the ledger does not know) with one `{redacted, challenger_id, metric,
  scorer_version, truth_snapshot_id, n, mean}` aggregate. `gate` and `human`
  see every row. Redaction is a floor, not the S7 Ladder signal: what the
  proposer should actually be told about holdout is decided above the ledger.
- **Restart-stable.** Close and reopen on the same medium and every view reads
  identical contents (tested with the json backend).

## API

```ts
import Ledger, { challengerId, importAttemptsJsonl, LedgerError } from '@samsara/ledger'

// verbs (all async; writes go through the domain's single write chain)
await ctx.ledger.propose(proposal)            // → id (dedupe by id)
await ctx.ledger.setStatus(id, 'judged', { verdict })
await ctx.ledger.recordAttempt(row)           // → id
await ctx.ledger.appendScores(rows)           // → keys written
await ctx.ledger.recordCompare(row)           // → key; throws VERDICT_EXISTS
await ctx.ledger.recordConsent(row)           // → id
await ctx.ledger.recordSettlement(row)        // → id

// views (synchronous)
ctx.ledger.challenger(id)
ctx.ledger.attemptsOf(challengerId); ctx.ledger.scoresOf(attemptId)
ctx.ledger.comparesOf(challengerId); ctx.ledger.consentsOf(challengerId)
ctx.ledger.lineage(id)                        // [id, parent, grandparent, …] following parent_ids[0]
ctx.ledger.read('scores', 'proposer' | 'gate' | 'human')

// pure helpers
challengerId(coords); scoreKey(row); compareKey(row); keyOf(...coords); canonicalJson(v)

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
  name: '@samsara/ledger'
```

`Ledger` injects `storageDomain`, opens `ledgerDomainSpec` in `[Service.init]`
and closes it in its own effect disposer; the single-open rule of the domain
facility is what makes "one ledger" a load-time fact.

In a bare `Context` (tests): mount `Storage`, register a `JsonStorageBackend`
(also `ctx.provide(storageBackendServiceKey('json'), backend)`), construct a
`DomainFacility({ backend: 'json' })`, `ctx.storage.mount('domain', facility)`,
`ctx.provide('storageDomain', facility)`, then `await ctx.plugin(Ledger)`. All
of these come from `@samsara/kernel`; see `tests/ledger.test.ts`.

```
pnpm --filter @samsara/ledger build
pnpm --filter @samsara/ledger test
```
