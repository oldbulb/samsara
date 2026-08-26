# proposers — turning an optimizer into proposals

A proposer is anything that emits a `Proposal`. In v1 proposers are external processes (an LLM CLI, a human, GEPA later); the framework never trusts them and never shows them truth. The ledger decides what a proposer may see (principle 8); the gate decides what is kept.

## Proposal

```ts
interface Proposal {
  parent: string                         // challenger id (usually the champion's row id)
  surface: string                        // exactly one (v1); must name a surface the pack declares in pack.yaml `surfaces:` (architecture.md § Surfaces); only `skill` opens today
  patch:
    | { surface: 'skill'; skill_dir: string }          // a full replacement skill directory (content-addressed by the framework)
    | { surface: Exclude<Surface, 'skill'>; rows: PatchOptions[] }   // cordis patch rows, !!js-free, within the pack's declared boundary
  intent: string                         // one paragraph: what the change is and why
  prediction: {                          // the falsifiable contract (AHE-style); the gate compares it with observed per-task Δ
    metric: string                       // the pack's primary metric
    direction: 'up' | 'down'
    magnitude?: number
    predicted_fixes?: string[]           // task ids the proposer expects to flip to pass
    at_risk?: string[]                   // task ids the proposer expects might regress
  }
  proposer: { name: string; version: string; config_sha: string }   // → optimizer_config_sha on the row
}
```

`lifecycle.propose` validates the proposal (schema, surface ∈ the pack's declared surfaces), runs the diff scan (E8/S5), computes the challenger id from the coordinate tuple, and only then opens a scope. A proposal that names a held-out task id anywhere is rejected.

## What a proposer is shown (`ledger.read(view, 'proposer')`)

- the champion's current skill / rows (the thing to improve);
- held-in tasks **individually**: task id, prompt/instructions as the sandbox sees them, the champion's per-task outcome (pass/fail, cost, tool calls) and, when the pack emits `side_info` from a judge-kind score, that text;
- held-out tasks only as **aggregates**: pass rate, mean cost, n — plus the Ladder signal of the last round (`beatBest: yes/no`, rounded best-so-far);
- never: truth payloads, hidden tests, scores of other challengers in the same round, anything under `bin/`, `tasks/holdout.jsonl`.

Of the `compares` table a proposer sees only the rows the champion is a side of (`challenger_id` or `vs_id` is the champion: the champion's own promotion and the verdicts of earlier challengers against it; rows of other lineages are not rendered). Shadow rows (a gate other than the promotion gate, no `gate_change` consent) are never shown: they feed no decision, and each would be one more verdict computed on the same held-out tasks. Held-in rows are shown whole. A held-out row is redacted by the ledger itself (`read('compares', 'proposer')`, type `CompareAggregate`) to `{redacted: true, challenger_id, vs_id, tier, method, rule_fired, verdict, ladder?}` where `ladder` is `{beat_best, best_so_far}` copied from the row's Ladder output with `best_so_far` rounded to two decimals — the S7 signal, and the rounding S7 leaves open is fixed here; the row's own `mean` and task count, `per_task`, `ci`, `mde`, `n_eff`, `holm`, `predicted_vs_observed` and `holdout_budget_remaining` are dropped (a per-sibling mean with its `n` would hand back the exact delta count of a pass/fail metric). A row recorded without a Ladder output shows the verdict alone. The held-out score aggregate's `mean` is rounded the same way; its `n` ships because it is the held-out set's size, which the attempt aggregate and the pack's task sets fix anyway. `gate` and `human` reads return the row whole.

The view is produced by the ledger, not assembled by the proposer adapter; adapters receive a directory of rendered files and cannot reach the ledger.

## Adapters (v1)

| adapter | command | how it proposes |
|---|---|---|
| `claude-p` | `claude -p --output-format json` under `ctx.subprocess` with explicit env (E5) | the prompt = the rendered view + the proposal schema; the model writes `proposal.json` and, for the skill surface, a new skill directory under `<work>/skill/`; the adapter validates and returns the Proposal |
| `human` | `samsara round --proposer human --skill-dir … --intent …` (`samsara propose --proposer human --skill-dir … --intent … --dry-run` validates and diff-scans the same patch without spending) | the operator supplies the patch directly |
| `gepa` (later) | library call in a subprocess | same contract |

The `claude-p` adapter's own configuration (model, effort, max turns, prompt template sha) is hashed into `optimizer_config_sha`; the template lives in the adapter package and is itself a future `optimizer` surface.

## Round

`samsara round --pack … --loop … --set <smoke|holdin> --proposer claude-p --metric …` (`packages/runner/README.md`, `round`):
1. open the round and render the proposer view into `<out>/view/`;
2. run the adapter → one Proposal (a round's `k` is the number of siblings it holds when a sibling is judged, `architecture.md` § Round; another `round --round <id>` adds a sibling before the first judgement);
3. diff scan → propose on the ledger → open scope → run the tier `--set` names → judge → the compare row;
4. print the verdict; a holdout `promote` waits for sign-off (`lifecycle.decide`).

The held-out tier and the escalation of replicates belong to `samsara campaign` (`packages/lifecycle/README.md` § Campaign, `packages/runner/README.md`): rounds under a pre-registered experiment through smoke → holdin → holdout, doubling the held-in replicates while the gate answers `hold:underpowered`, with the held-out reveal behind a consent per row or the experiment's pre-registered `auto_reveal`.
