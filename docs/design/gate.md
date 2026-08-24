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
  holdout: { rotateAfterPromotions: 1; maxRounds: 20 }     // S7
}
```

## Outputs

```ts
interface Compare { perTask: Δ[]; mean; ci: [lo, hi]; method: 'bca'; clusterKey: 'entity'; nEff; mde; holm: { adjustedAlpha }; costRatio; ladder: { step: number; beatBest: boolean }; ruleFired: string }
type Verdict = 'invalid' | 'drop' | 'hold' | 'hold:underpowered' | 'promote'
```

## `gate-default` rules, in order

1. **Type check.** Any `judge`-kind value in `primaryMetric` ⇒ `invalid`. Attempts with status `ABORTED|FAILED` are excluded from statistics (kept in the ledger). Unpaired tasks are dropped from the comparison and counted.
2. **Validity (smoke).** `output.valid` rate ≥ policy floor (default 0.9) else `drop`; no statistics on smoke beyond this.
3. **Power floor (S2).** `nEff` = number of distinct `entityKey` with paired data; if `nEff < nEffFloor` or `mde > pack.holdout.mde` ⇒ `hold:underpowered` (never `promote`).
4. **MDE (S1).** `mde = (z_{1-α/2} + z_{1-β}) · sdPaired / √nEff`; `sdPaired` from the noise floor, not from the comparison itself.
5. **Screen (S4).** held-in Δ ≥ 0; on `holdin`, if `z < futility.zStop` ⇒ `drop` (futility-only early stop). Nothing else stops early.
6. **Cost (S8).** `costRatio = mean(challenger cost) / mean(champion cost)`; if `costRatio > maxRatio` and the challenger does not dominate on the (quality, cost) front ⇒ `drop`.
7. **Holdout test (S4).** One pre-registered one-sided test on the paired holdout Δ: BCa bootstrap CI (B=2000, clustered by entity); Holm-adjusted α across the round's K siblings; `promote` iff CI lower bound > 0 after Holm **and** mean ≥ mde; else `hold`.
8. **Ladder exposure (S7).** What the proposer may see of the holdout is only `ladder.beatBest` (Δ > std/√n over best-so-far) and the rounded best-so-far; raw holdout means stay judge-side.
9. **Live.** `hold` rows re-enter on each settlement; `promote` on live requires the delayed truth to confirm; anytime-valid (mSPRT) test when the pack declares live.

Every verdict row carries `ruleFired` (which step decided) and the full `Compare`.

## Tests that define the policy (bring-up step 1 / M3)

The policy simulation, ported to TS with a seeded PRNG (`packages/gate/tests/sim.test.ts`):
- null siblings, K=4, 200 rounds: false-keep per round < α·K;
- a pure-noise task set promotes nothing over 20 rounds;
- a "bigger-budget optimizer" arm (more samples, same null) is not promoted more often;
- a known-good challenger (+mde·1.5) is promoted with power ≥ 0.8 at the declared n;
- judge-kind primary metric ⇒ `invalid`; `nEff` below floor ⇒ `hold:underpowered`; cost ratio 1.5 with equal quality ⇒ `drop`.

## Non-goals

No model-judged promotion; no p-hacking by re-running the comparison (the ledger keeps the first verdict per (challenger, tier, truth_snapshot)); no cross-round maxima.
