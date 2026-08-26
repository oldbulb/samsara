---
"@oldbulb/samsara-ledger": minor
---

Five tables join the ledger: `rounds`, `noise_floors`, `servings`, `experiments` and `notebook`, with `openRound` / `updateRound`, `recordNoiseFloor`, `recordServing` (immutable except closing `to`), `createExperiment` / `updateExperiment` (the budget is not in the id; a raise lands on `budget_changes` with who raised it), `recordNotebook` (append-only) and their readers. Compare rows key on `replicates` too, and a shadow row on its gate; `recordAttempt` refuses an id already held by another challenger (`ATTEMPT_EXISTS`); the consent actions grow to `demote`, `eval_config_change`, `gate_change` and `holdout_reveal`. A fourth viewer, `operator`, sees compares without per-task deltas and held-out rows as aggregates; the proposer view now reduces holdout compares to verdict plus the Ladder signal and hides shadow rows and every operator table. `backupSqlite` copies the sqlite file with the online backup API while the host runs.
