# Gates in any language

A gate turns scores into a verdict. The framework ships one policy in TypeScript (`gate-default`), and lets a deployment mount another one written in any language as a subprocess: the host writes a `CompareRequest` as JSON on the gate's stdin, the gate prints a `GateJudgement` as JSON on stdout, and the ledger records the verdict under the gate's `name@version`. This directory holds the contract and one worked example, `keep_better.py`.

## Mounting

One row in the profile's `cordis.patch.yml`, after `gate-default`:

```yaml
- id: gate-mine
  name: '@oldbulb/samsara-gate/plugin-command'
  inject: [gate]
  config:
    command: ./my_gate.py     # anything the OS can execute; resolved against the host's cwd
    args: []                  # optional
    name: mine                # gateMethod = name@version on every verdict row
    version: 0.1.0
    timeoutMs: 60000          # optional
```

The most recently registered policy is the one that judges, so this row replaces `gate-default`. Replacing or re-parameterising the gate is a fixed-point change: running rounds under it needs a signed `gate_change` consent (`docs/design/architecture.md` § Ledger), and every verdict row names the gate that decided.

## Process contract

- **stdin**: one `CompareRequest` document, UTF-8 JSON. Read to EOF.
- **stdout**: one `GateJudgement` document, UTF-8 JSON. Nothing else may be printed on stdout; anything not parseable as a complete `GateJudgement` is a `BAD_OUTPUT` error naming the offending field (`compare.ci[1]: expected number, received string`).
- **stderr**: free-form; kept on the error if the gate fails.
- **exit code**: `0` on a judgement (including `invalid`). Any other code is an `EXIT` error; the verdict is not "drop", it is "the gate did not answer". Exceeding `timeoutMs` is a `TIMEOUT` error (the child is killed with `SIGKILL`); so is writing more than 64 MiB on stdout or stderr (`EXIT`).
- **concurrency**: the host spawns the child asynchronously and awaits it; a slow gate holds up its own judgement, never the host's event loop (the web UI, other sessions).
- **environment**: the child sees only `PATH`, `HOME`, `LANG` (when set on the host) plus whatever the mounting code adds explicitly. Nothing else from the host reaches it: no credentials, no working-tree paths, no seed.
- **determinism**: the same request must yield the same output. Every input the verdict depends on is in the request, including `seed` for any randomised procedure; a gate that reads a clock, the environment or the network is not reproducible from the ledger.
- **numbers**: JSON has no `NaN`/`Infinity`; every number in the judgement must be finite.

## `CompareRequest` (stdin)

```jsonc
{
  "challenger": [ScoredAttempt, ...],    // the challenger's scored attempts
  "champion":   [ScoredAttempt, ...],    // the champion's, on the same tasks and tier
  "tier": "holdin",                      // "smoke" | "holdin" | "holdout" | "live"
  "primaryMetric": "score",              // the metric name the verdict is about; rows of other metrics are ignored
  "noiseFloor": { "sdPaired": 0.2, "nReruns": 3 },   // paired sd from >= 3 same-config reruns (S1)
  "policy": GatePolicy,                  // the pack-declared thresholds (below)
  "round": { "k": 4, "index": 0 },       // K siblings judged this round; this one's rank by p-value (0 = most significant)
  "bestSoFar": 0.05,                     // optional: best acknowledged holdout delta so far (ladder, S7)
  "seed": 7,                             // optional: PRNG seed; the same seed must give the same verdict
  "factsSha": { "challenger": "…", "champion": "…" }   // optional: harness facts sha of each side; when both are present and differ the gate must refuse
}
```

`ScoredAttempt`:

```jsonc
{
  "attemptId": "a1",        // unique per attempt
  "challengerId": "c1",     // which side produced it
  "taskId": "t1",           // pairing key, with sample
  "entityKey": "e1",        // cluster key: attempts on the same entity are not independent
  "stratum": "s1",          // optional: stratum label for stratified reporting
  "sample": 0,              // replicate index; pairs are (taskId, sample)
  "status": "COMPLETED",    // "COMPLETED" | "TRUNCATED" | "ABORTED" | "FAILED"; ABORTED/FAILED are excluded before pairing
  "metric": "score",        // metric name; opaque to the framework
  "value": 0.75,            // the score
  "kind": "reality",        // "mechanical" | "reality" | "judge"; a judge-kind primary metric never promotes
  "cost": { "usd": 0.01, "tokens": 1200 },   // usd optional
  "valid": true             // optional: output validity; absent means valid when COMPLETED
}
```

`GatePolicy`:

```jsonc
{
  "alpha": 0.05,                                      // one-sided significance level
  "power": 0.8,                                       // target power for the MDE
  "bootstrap": { "B": 2000, "method": "bca" },        // resampling budget (advisory for a foreign gate)
  "nEffFloor": 8,                                     // minimum distinct entities with paired data (S2)
  "mde": 0.03,                                        // optional: SESOI, the smallest effect worth a promotion
  "validityFloor": 0.9,                               // smoke: minimum output-valid rate
  "costBudget": { "metric": "cost_usd", "maxRatio": 1.25 },   // challenger/champion cost must be <= maxRatio ("cost_usd" | "tokens")
  "futility": { "tier": "holdin", "zStop": -1.0 },    // early stop is futility-only, on holdin, when z < zStop
  "holdout": { "rotateAfterPromotions": 1, "maxRounds": 20 }   // holdout accounting (carried for the ledger)
}
```

## `GateJudgement` (stdout)

```jsonc
{
  "compare": {
    "perTask": [ { "taskId": "t1", "entityKey": "e1", "sample": 0, "stratum": "s1", "delta": 0.1 }, ... ],   // challenger - champion per pair; stratum optional
    "mean": 0.04,                        // mean paired delta
    "ci": [0.01, 0.07],                  // [lower bound at the adjusted alpha, upper bound at 1 - alpha]; [mean, mean] if you computed none
    "method": "bca",                     // how the ci was produced; any string, name your procedure honestly
    "clusterKey": "entity",              // always "entity"
    "nEff": 12,                          // distinct entityKey with paired data
    "mde": 0.05,                         // what this design could detect: (z_{1-a/2} + z_{1-b}) * sdPaired / sqrt(nEff * replicates)
    "replicates": 1,                     // paired samples per task (paired / distinct tasks)
    "minEffect": 0.03,                   // the SESOI applied (policy.mde, 0 when none)
    "holm": { "adjustedAlpha": 0.0125 }, // alpha / (round.k - round.index)
    "costRatio": 1.02,                   // mean challenger cost / mean champion cost over the pairs
    "ladder": { "step": 0.01, "beatBest": true },   // step = sd(entity means) / sqrt(nEff); beatBest = mean > bestSoFar + step
    "counts": { "paired": 12, "unpaired": 0, "excluded": 1, "validRate": 1 },   // pairing accounting; validRate over challenger rows
    "ruleFired": "keep-better:mean>0"    // which rule decided; free text, shown in the UI and the ledger
  },
  "verdict": "promote"
}
```

`verdict` values:

| value | meaning |
| --- | --- |
| `invalid` | the request cannot be judged (judge-kind metric, no data, facts mismatch); nothing is decided |
| `drop` | the challenger is disposed: failed validity, cost or futility |
| `hold` | stays open until the next settlement or more data |
| `hold:underpowered` | the design cannot detect the declared effect; never a promotion |
| `promote` | eligible for promotion, still subject to the round's one-winner rule and a signed consent |

`gate-default`'s rules 0–8 (`docs/design/gate.md`) are the reference semantics; a foreign gate may implement fewer, but every field above must be filled from what it actually computed, not copied.

## Example

`keep_better.py` (Python, standard library only) pairs by `(taskId, sample)`, takes the mean delta and promotes iff it is positive. It fills every `Compare` field honestly: `ci` is `[mean, mean]`, `method` is `keep-better`, `mde` is computed from the noise floor, `nEff` is the number of distinct entities. It is the contract made concrete, not a recommended policy.

```sh
python3 examples/gates/keep_better.py < request.json
```
