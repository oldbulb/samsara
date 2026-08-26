# gate — the verdict seam and `gate-default`

The gate turns scores into a verdict. It is a seam (`ctx.gate`) with one shipped policy, `gate-default`; a deployment may mount another policy, and the ledger records `gate_method@version` on every verdict. The numbers below come from the feasibility simulation reproduced in `packages/gate/tests/sim.test.ts`.

## Inputs (all from the ledger; never from the loop)

```ts
interface ScoredAttempt { attemptId; challengerId; taskId; entityKey; stratum?; sample; status; metric: string; value: number; kind: 'mechanical'|'reality'|'judge'; cost: { usd?: number; tokens: number } }

interface CompareRequest {
  challenger: ScoredAttempt[]; champion: ScoredAttempt[]     // same tasks, same tier, paired by (taskId, sample)
  tier: 'smoke' | 'holdin' | 'holdout' | 'live'
  primaryMetric: string                                       // must be kind 'reality' (or 'mechanical' for cost); 'judge' is rejected by type
  noiseFloor: { sdPaired: number; nReruns: number }           // from ≥3 same-config reruns (S1)
  policy: GatePolicy
  round: { k: number; index: number }                         // Holm across the round's K siblings (S4)
}

interface GatePolicy {
  alpha: 0.05; power: 0.80; bootstrap: { B: 2000; method: 'bca' }
  nEffFloor: number                 // S2; entity-clustered
  mde?: number                      // pack-declared minimum effect; computed from noise floor when absent
  costBudget: { metric: 'cost_usd'; maxRatio: number }   // S8: challenger cost / champion cost must be ≤ maxRatio (default 1.25) or dominate on Pareto
  futility: { tier: 'holdin'; zStop: -1.0 }                // S4: early stop is futility-only
  holdout: { rotateAfterPromotions: 1; maxRounds: 20 }     // S7: recorded on the verdict row, consumed by nothing (rotation is not implemented)
}
```

## Outputs

```ts
interface Compare { perTask: Δ[]; mean; ci: [lo, hi]; method: 'bca'; clusterKey: 'entity'; nEff; mde; holm: { adjustedAlpha }; costRatio; ladder: { step: number; beatBest: boolean }; ruleFired: string }
type Verdict = 'invalid' | 'drop' | 'hold' | 'hold:underpowered' | 'promote'
```

## `gate-default` rules, in order

0. **Comparability** (`architecture.md` § Coordinates). The two rows' coordinate tuples must be equal on every coordinate except `parent_ids`, `patch_sha`, `skill_sha` (skill surface) and `optimizer_config_sha`, every attempt pair must have equal `facts_sha`, and the request's noise floor must have been measured under the round's `eval_config_sha`; otherwise `invalid:coordinates:<name>` / `invalid:noise_floor` and nothing below runs.
1. **Type check.** Any `judge`-kind value in `primaryMetric` ⇒ `invalid`. Attempts with status `ABORTED|FAILED` are excluded from statistics (kept in the ledger). Unpaired tasks are dropped from the comparison and counted.
2. **Validity (smoke).** `output.valid` rate ≥ policy floor (default 0.9) else `drop`; no statistics on smoke beyond this.
3. **Power floor (S2).** `nEff` = number of distinct `entityKey` with paired data; if `nEff < nEffFloor` or `mde > pack.holdout.mde` ⇒ `hold:underpowered` (never `promote`). `pack.holdout.mde` is the SESOI — the smallest effect worth a promotion, declared by the pack in the metric's unit and independent of n; a small pack that cannot detect it is told so here rather than asked for a larger effect.
4. **MDE (S1).** `mde = (z_{1-α/2} + z_{1-β}) · sdPaired / √(nEff · replicates)`; `sdPaired` from the noise floor (one paired sample per task), not from the comparison itself; `replicates` = paired samples per task in this comparison, so repeats buy power. The MDE is a power quantity and binds only in rule 3.
5. **Screen (S4).** held-in Δ ≥ 0; on `holdin`, if `z < futility.zStop` ⇒ `drop` (futility-only early stop). Nothing else stops early.
6. **Cost (S8).** `costRatio = mean(challenger cost) / mean(champion cost)`; if `costRatio > maxRatio` and the challenger does not dominate on the (quality, cost) front ⇒ `drop`.
7. **Holdout test (S4).** One pre-registered one-sided test on the paired holdout Δ: BCa bootstrap CI (B=2000, clustered by entity); Holm-adjusted α across the round's K siblings; `promote` iff CI lower bound > 0 after Holm **and** mean ≥ SESOI (`pack.holdout.mde`, 0 when undeclared); else, when the design is powered for a declared SESOI (rule 3 passed with `pack.holdout.mde` set), the interval brackets zero and `costRatio` lies within `[1/maxRatio, maxRatio]`, the challenger is indistinguishable from the champion on both quality and cost ⇒ `drop` (`indistinguishable`, S8); else `hold`. (0.1.0 required mean ≥ the noise-floor MDE instead, which made the effective α ≈ 0.003 and the power at the MDE 0.5 while declaring 0.05 / 0.8, and scaled the bar with 1/√n; 0.2.0 separates detectability from worth.)
8. **Ladder exposure (S7).** What the proposer may see of the holdout is only `ladder.beatBest` (Δ > std/√n over best-so-far) and the rounded best-so-far; raw holdout means stay judge-side.
9. **Live.** Not implemented: a live request returns `hold` (`live:unimplemented`). The design: `hold` rows re-enter on each settlement, `promote` on live requires the delayed truth to confirm, and the test is anytime-valid (mSPRT) when the pack declares live.

Every verdict row carries `ruleFired` (which step decided), the round it was judged in, and the full `Compare` — `minEffect` (the SESOI applied), `replicates`, the design `mde` and its `sd_source`, `holm {m, rank, alpha_adj}` — so a reader can see how far a `hold` was from promotion and whether the design could have seen it. The mapping from `Compare` to the row is `compareRowOf` in `packages/champion`, written only by `lifecycle.judge`; no other package builds a compare row.

## Rounds

A round (`architecture.md` § Round) is the unit the multiple comparison runs over: its `k` siblings are the challengers proposed against one champion under one gate `{name, version, policy_sha}` and one noise floor, and `k` is whatever `sibling_ids` holds when a sibling is judged. `gate-default` is asked for every sibling at the most conservative Holm level (`round: {k, index: 0}`, `alpha_adj = α / k`), because it exposes no p-value the round could rank by; the row records `holm {m: k, rank: 0, alpha_adj}`. `lifecycle.decide` then promotes at most one sibling: among the `promote` verdicts, the largest lower CI bound on its held-out compare (ties to the earliest proposed), and only with a `promote` consent; the other `promote` verdicts become `hold:superseded` on the row (verdict `hold:superseded`, the round in `round_id`) and re-enter the next round against the new champion. `hold:underpowered` is a gate verdict, not a row value: the row records `hold` with the rule that fired (`power:nEff`, `power:mde`), and a campaign reads that prefix to escalate replicates. The noise floor a round pins comes from `lifecycle.calibrate`: `n` same-config reruns of the champion at the same sample index, `sd_paired` = the sd of the paired per-entity mean difference between every two reruns; a held-out judgement without one is `invalid:noise_floor`.

## Presets

`gate-default@0.2.0` is the shipped policy (α=0.05 one-sided). `gate-fast@0.1.0` is the same statistics at α=0.10 for exploration; `gate-permissive@test` always promotes and exists for plumbing tests. The name and version of whatever judged a row are ledger coordinates.

## Shadow gates and `gate_change`

The **promotion gate** is the policy mounted on `ctx.gate` when a command runs: `gate-default`, or a `plugin-command` gate the profile mounted after it. Replacing or re-parameterising the gate is a fixed-point change (`architecture.md` § Ledger), so it is a consent action: a mounted policy other than the shipped `gate-default@version` needs a `gate_change` consent whose subject (`challenger_id` on the consent row, the `rowId` the human signed) is its `name@version`, and `challenge` / `round` / `certify` refuse to open anything under a mounted policy that has none. Only the promotion gate's verdict sets a challenger's `verdict`, and `champion.promote` refuses (`FOREIGN_GATE`) a `promote` whose `by` is not the mounted `gate-default` and is not a gate a `gate_change` consent names. `--gate-policy <name>` with another name — a preset (`fast`, `permissive`) or a catalog rule, which the profile must have mounted on `ctx.gate` before the promotion gate — still judges, but as a **shadow**: the compare row records `gate: name@version` and `shadow: true`, is keyed by its gate so it sits beside the promotion verdict for the same (challenger, vs, tier, truth), and feeds no decision; the promotion gate's verdict is always recorded and is the row's verdict. A `gate_change` consent naming that policy lets it judge for real — the row then records it as `gate`, the challenger's verdict names it in `by`, and `promote` accepts it. The consent's subject is the `name@version` only: `architecture.md` also names a `policy_sha`, which the consent row does not carry yet, so a command gate re-parameterised under the same `name@version` is not a new subject. Rows recorded before these fields existed read as the promotion gate's, not shadows.

Catalog rules (`@oldbulb/samsara-gate-catalog`) are literature rules stated on the holdout tier; on smoke they apply rule 2 only, on holdin the power floor and then the rule with `promote` screened to `hold`, on live `hold`. Their bench calls them at tier holdout, so its numbers are the rules' own.

## Tests that define the policy (bring-up step 1 / M3)

The policy simulation, ported to TS with a seeded PRNG (`packages/gate/tests/sim.test.ts`):
- null siblings, K=4, 300 rounds: false-keep per round ≤ α (Holm bounds the family-wise rate; no longer "well inside" α);
- a pure-noise task set with a declared SESOI the design cannot detect promotes nothing over 20 rounds (`hold:underpowered`); without a SESOI, significance alone promotes at about α per round;
- a "bigger-budget optimizer" arm (more samples, same null) is not promoted more often;
- a known-good challenger (+mde·1.5) is promoted with power ≥ 0.8 at the declared n;
- judge-kind primary metric ⇒ `invalid`; `nEff` below floor ⇒ `hold:underpowered`; cost ratio 1.5 with equal quality ⇒ `drop`; equal quality and equal cost under a powered design ⇒ `drop` (`indistinguishable`), `hold` without a declared SESOI or when cheaper by more than the budget ratio.

## Non-goals

No retention rule yet: `gate-default@0.2.0` bounds nothing on the tasks the champion solved (a regression-rate rule is a candidate for a later version, not part of the shipped policy). No stratified scoring (S3): every scored attempt is pooled whatever its `stratum`; the field rides on scores and per-task deltas for the reader, and a stratum-aware primary metric is a policy of its own until then. No model-judged promotion; no p-hacking by re-running the comparison (the ledger keeps the first verdict per (challenger, tier, truth_snapshot)); no cross-round maxima.
