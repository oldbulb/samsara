---
"@oldbulb/samsara-lifecycle": minor
---

New package: `ctx.lifecycle`, the one place a challenger row or a round changes state. The six transitions (`propose`, `open`, `run`, `judge`, `decide`, `settle`), `demote`, the round objects (`openRound`, `closeRound`, `abortRound`), pre-registered experiments with a budget that only `setExperimentBudget` moves, the noise-floor calibration, a campaign driver and controls, and the read-only `status` / `nextActions` helpers with their costs. Every consumer — the runner's commands, the workbench tools, the UI — asks the service; none of them writes `status`, `verdict`, `compares`, `rounds`, `servings` or `noise_floors` itself. `openRound` refuses when the proposer's route is the operator's own (`OPERATOR_IS_PROPOSER`), and the attempt executor is read from `ctx.executor` at call time so the runner row may mount after this one.
