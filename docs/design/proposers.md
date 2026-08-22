# proposers — turning an optimizer into proposals

A proposer is anything that emits a `Proposal`. In v1 proposers are external processes (an LLM CLI, a human, GEPA later); the framework never trusts them and never shows them truth. The ledger decides what a proposer may see (principle 8); the gate decides what is kept.

## Proposal

```ts
interface Proposal {
  parent: string                         // challenger id (usually the champion's row id)
  surface: 'skill' | 'prompt' | 'memory' | 'tools' | 'runtime' | 'route' | 'context'   // exactly one (v1)
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

The host validates the proposal (schema), runs the diff scan (E8/S5), computes the challenger id, and only then opens a scope. A proposal that names a held-out task id anywhere is rejected.

## What a proposer is shown (`ledger.read(view, 'proposer')`)

- the champion's current skill / rows (the thing to improve);
- held-in tasks **individually**: task id, prompt/instructions as the sandbox sees them, the champion's per-task outcome (pass/fail, cost, tool calls) and, when the pack emits `side_info` from a judge-kind score, that text;
- held-out tasks only as **aggregates**: pass rate, mean cost, n — plus the Ladder signal of the last round (`beatBest: yes/no`, rounded best-so-far);
- never: truth payloads, hidden tests, scores of other challengers in the same round, anything under `bin/`, `tasks/holdout.jsonl`.

The view is produced by the ledger, not assembled by the proposer adapter; adapters receive a directory of rendered files and cannot reach the ledger.

## Adapters (v1)

| adapter | command | how it proposes |
|---|---|---|
| `claude-p` | `claude -p --output-format json` under `ctx.subprocess` with explicit env (E5) | the prompt = the rendered view + the proposal schema; the model writes `proposal.json` and, for the skill surface, a new skill directory under `<work>/skill/`; the adapter validates and returns the Proposal |
| `human` | `samsara propose --skill-dir … --intent …` | the operator supplies the patch directly |
| `gepa` (later) | library call in a subprocess | same contract |

The `claude-p` adapter's own configuration (model, effort, max turns, prompt template sha) is hashed into `optimizer_config_sha`; the template lives in the adapter package and is itself a future `optimizer` surface.

## Round

`samsara round --pack … --loop … --proposer claude-p --k 1`:
1. render the proposer view into a scratch dir;
2. run the adapter → Proposal (K times for K siblings; v1 default 1);
3. for each proposal: diff scan → propose on the ledger → open scope → smoke → holdin (futility) → holdout → `recordCompare`;
4. print verdicts; `promote` verdicts wait for sign-off.

M5 scope: one proposal, one run through smoke on one loop, a verdict on the ledger. Tiers beyond smoke, K > 1 and scheduling are P4.
