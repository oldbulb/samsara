---
"@oldbulb/samsara-pack": minor
"@oldbulb/samsara-workdir": minor
"@oldbulb/samsara-sandbox": minor
"@oldbulb/samsara-scope": minor
---

The framework assumes no pack layout any more: `pack.yaml` declares `runtime.dirs` (the roots granted read-only to attempts), `runtime.locks` (the globs hashed into `env_sha`) and `runtime.env` (the host variables its commands may see), plus `metrics.primary` / `metrics.cost`, `tasks.protocol`, `holdout.budget` (held-out reveals the lifecycle debits), `holdout.retention_tolerance` and `holdout.auto_demote`. `protectedPaths(def)` names what the manifest protects — the judge commands, the task sets, the contract — and `commandEnv` builds the allow-listed environment for `truth` / `score` / `materialize`. The workdir passes both to the sandbox (`policyPaths.runtimeDirs`, `policyPaths.packDenied`), the attempt token records `sample` and `skill_path`, `envLock` takes `packLocks` instead of scanning `runtime/`, and the diff scan refuses an inserted row that injects `lifecycle`, `champion` or a fixed point.
