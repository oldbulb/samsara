# @oldbulb/samsara-gate-catalog

Acceptance rules from the RSI literature, each as a `GatePolicyProvider` for `ctx.gate`, and a bench that measures any gate policy — these, `gate-default`, or your own — on recorded attempts. The catalog exists so that "our gate versus theirs" is a number you can regenerate, not a claim.

Every rule computes the same `Compare` statistics as `gate-default` (pairing by `(taskId, sample)`, entity clusters, `nEff`, `replicates`, MDE, cost ratio, ladder exposure, counts) with the helpers `@oldbulb/samsara-gate` exports, then decides only `verdict`, `ci`, `method`, `holm` and `ruleFired`. Rules without an interval report `ci = [mean, mean]` and `method` = their name; rules without a significance level report `holm.adjustedAlpha` = the request's `policy.alpha`. On the holdout tier every rule answers `promote` or `hold` (never `drop`); the facts and type checks mirror `gate-default`'s rules 0 and 1 (`invalid`). Rules the papers state on binary outcomes are stated on the sign of the paired per-task delta: identical for a binary metric, a sign test otherwise.

A literature rule decides only on holdout. The other tiers get the framework's ladder, applied once around every rule: `smoke` is validity only (`hold`/`drop`, `validity`), `holdin` never promotes (`hold:underpowered` below `nEffFloor`, else the rule with a `promote` screened to `hold`, `screen`), `live` holds (`live:unimplemented`). Whatever the tier, a catalog rule mounted through `--gate-policy` judges as a shadow unless a `gate_change` consent names it (`docs/design/gate.md`).

## Catalog

All are `name@0.1.0`; `CATALOG` holds every rule at its default configuration, `catalogGate(name)` looks one up by name or `name@version`, and the factory takes the configuration.

| name | factory | rule | source | type-I statement |
|---|---|---|---|---|
| `keep-better` | `keepBetter()` | mean paired delta > 0 | the implicit baseline of SICA (Robeyns et al. 2025), RSEA's strict update, DGM with leeway 0, GEA's rank | none: P(promote \| null) -> 0.5 as ties vanish |
| `hillclimb` | `hillclimb({ strict = true })` | mean delta > 0, or >= 0 (`hillclimb:lateral`) | same family, tie rule explicit | none |
| `dgm-keep-better` | `dgmKeepBetter({ leeway = 0.1 })` | unpaired mean of the challenger's rows >= unpaired mean of the champion's rows - leeway | Darwin Gödel Machine (Zhang et al. 2025), `update_archive(method='keep_better')`, `eval_noise = 0.1` | none; the leeway makes it more permissive than keep-better |
| `self-harness` | `selfHarness()` | delta_in >= 0 and delta_out >= 0 and max > 0, each side a sum of per-task deltas | Self-Harness (Zhang et al. 2026) §3.4 | none; two sign rules in conjunction |
| `rsea` | `rsea({ strict = false })` | held-out delta >= 0 (`rsea:lateral`) or > 0 (`rsea:strict`) | RSEA (Nguyen et al. 2026), Algorithm 1 | none for the commit rule |
| `ladder` | `ladder({ variant = 'paper' })` | mean delta > (bestSoFar ?? 0) + step; `paper`: step = sd(deltas)/sqrt(n), `samsara`: sd(entity means)/sqrt(nEff) | Blum & Hardt 2015, parameter-free Ladder (Figure 2) | a leaderboard-error bound O(n^-1/3), not an alpha; per comparison about a one-sided 1-sigma rule |
| `miller` | `miller()` | mean - 1.96 * clustered SE > 0 (95% CI excludes 0 on the favourable side) | Miller 2024, "Adding Error Bars to Evals", §2.2 clustered SE, §4.2 paired | asymptotic one-sided 0.025 per comparison; no multiplicity, no SESOI |
| `normal-one-sided` | `normalOneSided({ alpha = 0.05 })` | mean - z_{1-alpha} * clustered SE > 0 | `gate-default` rule 7 with a normal interval instead of BCa, no Holm, no SESOI | asymptotic one-sided alpha per comparison |
| `mcnemar` | `mcnemar({ alpha = 0.05 })` | exact two-sided McNemar on the discordant paired rows, p < alpha, and more wins than losses | RSEA's post-hoc report, made a gate; the direction conjunct is added so a significant regression is never promoted | alpha under an iid-row null; clustering-blind, so anti-conservative on clustered packs |
| `pace` | `pace({ alpha = 0.05, lambda = 0.5 })` | e-process over the discordant rows in order, E *= 1 + lambda(2w - 1); promote iff E ever reaches 1/alpha | testing by betting (Shafer 2021 / Waudby-Smith & Ramdas 2024) | anytime-valid alpha for one candidate; no Holm, so K siblings carry K * alpha |
| `hcl-commit` | `hclCommit({ deltaMin = 1, tau = Infinity })` | sum of per-task deltas >= deltaMin (task units) and tasks with delta < 0 <= tau | the `minimumCurrentImprovement` / regression-cap commit rule | none: `deltaMin` in task units is a sign rule with a margin |
| `autoscientists` | `autoscientists({ M = 2 })` | mean > M * sd(deltas)/sqrt(n) (`autoscientists:mean`); failing that with >= 2 replicates, every sample index's mean delta > 0 (`autoscientists:replicates`) | the M-sigma-then-every-replicate rule | about a one-sided M-sigma rule, clustering-blind, no multiplicity |

`self-harness` and `rsea` need a held-in / held-out split. A `CompareRequest` carries one tier, so the request's tier is the set being judged and the paper's two fixed splits are emulated inside it: the request's entities are sorted, shuffled with `mulberry32(req.seed)`, the first half held-in and the rest held-out. Neither rule reads `tier`. The paper's Self-Harness aggregates two repeats as pass counts; here every paired sample of a task contributes through the task's mean delta.

Also exported: `clusteredSe(deltas, clusters)` (Miller's clustered SE), `mcnemarExactP(b, c)`, `CATALOG_VERSION`.

## Plugin (`@oldbulb/samsara-gate-catalog/plugin`)

A cordis plugin (`name: gate-catalog`, `inject: [gate]`) that registers catalog rules on `ctx.gate` for the lifetime of its row and unregisters them when the row is disposed. `config.policies` lists catalog names (`name` or `name@version`), registered in order; omitted, every rule at its default configuration is mounted. An unknown name throws when the plugin applies. Row order is registration order: mounted before `gate-default` the rules judge as shadows and `--gate-policy <name>` can name them; mounted after it, the last one is the promotion gate and needs a `gate_change` consent (`docs/design/gate.md`). The bundle ships the row commented out (`packages/bundle/cordis.patch.yml`):

```yaml
- id: gate-catalog
  name: '@oldbulb/samsara-gate-catalog/plugin'
  inject: [gate]
  config:
    policies: [keep-better, hillclimb]
```

## Bench (`@oldbulb/samsara-gate-catalog/bench`)

`bench({ attempts, tasks, metric, gates, policy?, resamples = 200, seed = 0, effects?, tier = 'holdout', ceiling = 1 })` takes the parsed rows of a samsara `attempts.jsonl` (`attemptId`, `task_id`, `status`, `cost.usd`, `scores[{metric, value, kind, stratum}]`) and a task list `{ task_id, entity_key, stratum? }` — the entity comes only from the task list, and a task without one is an error. Rows are keyed by `attemptId` as the runner keys the file, the last row per id winning, so a resumed run's re-recorded attempt (or a concatenated file) counts once. The sample index of a row is the trailing integer of its `attemptId` (`…-<n>`, the ledger's convention), else its occurrence order for that `task_id`; `ABORTED`/`FAILED` rows and rows without the metric are dropped; every task needs at least two scored reruns and all are cut to the smallest count. No rows, no tasks, no scored row carrying the metric, a metric of kind `judge` (the gate rejects judge rows), a task without an entity or with fewer than two scored reruns, and `resamples` below 1 are errors, raised before any statistics. Every ordered rerun pair `(a, b)`, `a != b`, becomes champion = rerun a / challenger = rerun b, the pairs cycled over the resamples. Each resample draws entities with replacement (as many as there are entities), each drawn entity its own cluster with a fresh id so duplicates stay distinct, builds one `CompareRequest` per gate with `noiseFloor.sdPaired` = the task-level `sd_paired` measured from the reruns, `round = {k: 1, index: 0}` and a seed derived from `(seed, scenario, resample)`, and tallies verdicts. A cell (gate x scenario) reports the acceptance rate — the fraction of resamples whose verdict is `promote` — with its Monte-Carlo SE `sqrt(r(1 - r)/R)`. The `null` scenario is rerun-vs-rerun; `effects` add scenarios that act on the challenger side: `flip` (each value below the ceiling becomes the ceiling with probability p — the best case, no regressions, sd shrinks), `regress` (fixes at p/(1 - breakPerFix) plus breaks of ceiling values at `breakPerFix` breaks per fix, drawn from the recorded below-ceiling values, so the net delta matches `flip` without shrinking the variance) and `shift` (a constant +delta). The result also carries `sd_paired` at task and entity level, the counts, and the exact decisions of every gate on the real ordered pairs (seed 7). `bench` is async — it awaits every policy's `judge`, so a subprocess gate benches without blocking the host — and resolves to the `BenchResult`; `formatBench(result)` renders it as markdown; `BenchResult` is plain JSON.

**Read the rates as entity-bootstrap acceptance rates on the one pack the rows came from, not as population false-promote rates.** Every resample reuses the same rows, and the independent information under the null is the handful of unordered rerun pairs; the exact decisions on the real ordered pairs are what the pooled rates extrapolate. A rate near a rule's nominal alpha on 40-odd clusters is the expected small-sample behaviour of a normal or bootstrap interval on a skewed, discrete delta, not a coverage guarantee, and a rule that reads a binary metric is judged at a larger standardized effect than one that reads a graded metric under the same injection.

## Tests

`pnpm --filter @oldbulb/samsara-gate-catalog test` (or `pnpm exec vitest run packages/gate-catalog/tests` from the root; no model, no network). `tests/rules.test.ts` judges every rule on a clear win, a symmetric null and a regression; `tests/bench.test.ts` runs the bench on the recorded fixture `tests/fixtures/runs/run-dsh-noise-closed.attempts.jsonl` at 25 resamples and checks the null rates of `keep-better` (about a coin) and `miller` (small), determinism under a seed, and the markdown; `tests/plugin.test.ts` mounts the plugin on a `GateRegistry` and checks registration order, the default of every rule, disposal and the unknown-name error.
