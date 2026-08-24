# @oldbulb/samsara-gate

The verdict seam (`ctx.gate`) and the shipped policy `gate-default`. Binding design: `docs/design/gate.md`; the numbers come from the policy simulation in `tests/sim.test.ts`.

The gate is a fixed point outside the loop: it reads ledger rows (`ScoredAttempt`), never loop output, and nothing in the loop can write a verdict. The framework does not know what a metric means; every verdict row carries `gateMethod = name@version`, the full `Compare`, and `ruleFired`.

## Layout

| module | export | what |
|---|---|---|
| `@oldbulb/samsara-gate` | `GateRegistry` (default export, cordis Service on `ctx.gate`), types, `gatePolicy`, stats | the seam |
| `@oldbulb/samsara-gate/default` | `gateDefault(req)` | the policy, a pure function |
| `@oldbulb/samsara-gate/plugin-default` | plugin `gate-default` (inject `['gate']`) | mounts `gateDefault` as `gate-default@0.1.0` |

`GateRegistry.register({ name, version, judge })` returns a disposer; `current()` is the most recently registered policy still mounted; `judge(req)` returns `{ compare, verdict, gateMethod }`.

## `gate-default` rules, in order

All statistics are computed once per request and stored in `Compare`; the rules only read them.

1. **Type** — any `judge`-kind row in the primary metric: `invalid` (`type:judge`). `ABORTED|FAILED` attempts are excluded and counted (`counts.excluded`); rows without a partner on `(taskId, sample)` are dropped and counted (`counts.unpaired`). No eligible challenger rows: `invalid` (`type:no-data`).
2. **Validity (smoke)** — `validRate` = share of challenger attempts with `status === 'COMPLETED'` and `valid !== false`; below `validityFloor`: `drop`, otherwise `hold` (`validity`). Nothing else is decided on smoke.
3. **Power floor (S2)** — `nEff` = distinct `entityKey` with paired data. `nEff < nEffFloor`: `hold:underpowered` (`power:nEff`); `mde > policy.mde` when the pack declares one: `hold:underpowered` (`power:mde`).
4. **MDE (S1)** — `mde = (z_{1-alpha/2} + z_{1-power}) * noiseFloor.sdPaired / sqrt(nEff)`; the sd comes from the rerun noise floor, never from the comparison.
5. **Screen (S4)** — on the `futility.tier` (holdin), `z = mean / (sd(entity means) / sqrt(nEff))`; `z < zStop`: `drop` (`futility`). Nothing else stops early. Holdin otherwise ends as `hold` (`screen`); it never promotes.
6. **Cost (S8)** — `costRatio = mean(challenger cost) / mean(champion cost)` over paired attempts, in usd when every row reports it, else tokens. `costRatio > maxRatio` and the challenger is not certified better on quality (rule 7's test): `drop` (`cost`).
7. **Holdout test (S4)** — BCa cluster bootstrap (clusters = entities, jackknife acceleration) at the Holm-adjusted level `alpha / (k - index)`; `promote` iff the lower bound `> 0` **and** `mean >= mde`, else `hold` (`holdout`).
8. **Ladder exposure (S7)** — `ladder.step = sd(entity means) / sqrt(nEff)`, `ladder.beatBest = mean > bestSoFar + step`. These two fields are all the proposer may see of the holdout; the ledger keeps the raw means judge-side.
9. **Live** — not implemented: `hold` with `ruleFired = 'live:unimplemented'`.

`Compare.ci` is `[lower at the adjusted alpha, upper at 1 - alpha]`; the lower bound is the pre-registered one-sided test. `round.index` is this sibling's rank by p-value within the round (0 = most significant, the Bonferroni level); a caller that has not ranked the round passes 0.

## Defaults (`GATE_DEFAULTS`, `gatePolicy({ nEffFloor, ...overrides })`)

| field | default |
|---|---|
| `alpha` | 0.05 |
| `power` | 0.80 |
| `bootstrap` | `{ B: 2000, method: 'bca' }` |
| `validityFloor` | 0.9 |
| `costBudget` | `{ metric: 'cost_usd', maxRatio: 1.25 }` |
| `futility` | `{ tier: 'holdin', zStop: -1.0 }` |
| `holdout` | `{ rotateAfterPromotions: 1, maxRounds: 20 }` |
| `nEffFloor` | **no default** — the pack declares it |
| `mde` | absent — only the noise-floor MDE applies |

`CompareRequest.seed` seeds the bootstrap PRNG (mulberry32); the same ledger rows and seed reproduce the same verdict.

## Mounting another policy

```ts
import type { GatePolicyProvider } from '@oldbulb/samsara-gate'

export const name = 'gate-mine'
export const inject = ['gate']
export function apply(ctx: Context) {
  const policy: GatePolicyProvider = { name: 'gate-mine', version: '0.1.0', judge: req => ({ compare, verdict }) }
  ctx.effect(() => ctx.gate.register(policy), 'gate-mine')
}
```

The policy registered last decides; every verdict records `gateMethod`. E1–E8, S5, S6 are framework invariants a policy cannot disable; S1–S4, S7, S8 are the behaviour of `gate-default` and are what a replacement is replacing.

## Tests

`pnpm --filter @oldbulb/samsara-gate test` (or `npx vitest run packages/gate/tests` from the root; ~4 s, no model, no network). `tests/sim.test.ts` holds the policy-defining simulations from `gate.md`: null siblings K=4 false-keep `< alpha*K`, a pure-noise task set promotes nothing over 20 rounds, a bigger-budget arm is not promoted more often, a known-good challenger at `+1.5*mde` has power `>= 0.8`, judge-kind `invalid`, `nEff` floor `hold:underpowered`, cost ratio 1.5 `drop`; plus unit tests for the normal quantile, MDE, Holm, jackknife acceleration, and BCa coverage.
