# Packs — the two consumers

The framework is kept honest by two packs that disagree on the one axis that matters most: **when truth arrives**.

## packs/coding-tasks (public, immediate truth)

- **Task**: a small repository snapshot with a failing test suite and a one-line goal. Sets of 20–60 tasks, `entity_key: repo`.
- **Skill**: a generic "fix the failing tests" SKILL.md — the thing being optimized.
- **Contract**: `{summary, files_changed[], confidence}` submitted via `submit_fix`.
- **truth**: runs the hidden tests on the submitted workdir; settles immediately. `status: settled` always.
- **score**: `pass_rate` (reality), `cost_usd`, `tool_calls` (mechanical). No judge scores.
- **Why it is here**: it exercises every framework plugin with zero secrets, runs in CI, and is the open-source demo. It also stresses the scope/workdir/dispose path harder than pricing does (many short attempts, real file trees).
- Source of tasks: synthetic repos generated in-repo plus a small curated public set; no benchmark data with licensing constraints.

## packs/pricing (private, delayed truth)

- **Task**: `(customer_id, cutoff)`; `entity_key: customer_id`; task sets drawn from the cohort so that holdout customers are disjoint from holdin and span ≥2 cutoff months.
- **Skill**: `pricing-standalone` (vendored from internal; body only, no harness syntax).
- **Contract**: the standalone four-key output (`decision_v3`).
- **truth**: next-month outcomes minted from the source tables; `status: pending` until the month settles; `truth_sha` pins the partition.
- **score**: by realized arm — hold-arm Brier/pinball is the primary stratum; cut-arm secondary; `cut_bp`/`cut_propensity` mechanical only. Declared through `stratum` so the framework can apply S3 without knowing what an arm is.
- **data**: the gated query CLI (five projections); reads the task token from the sealed workdir; the server enforces the cutoff from the token; `--cutoff` is a deny pattern.
- **What it vendors from legacy**: `as_of` queries, minting, verifiers, the proxy/server for gated data. **What it does not import**: legacy's store, runner, principles, or CLAUDE.md — those were the previous host's concerns; samsara is the host now.
- **Publishing**: the repo is internal for now; how the private pack is separated at publish time (submodule or stripped mirror) is decided then.

## What a third pack would need

`pack.yaml`, a skill dir, a contract schema, task sets with an `entity_key`, and two executables (`truth`, `score`). If it needs in-sandbox data access, a `data` executable that reads `.task/token.json`. Nothing else — if a new pack needs a framework change, the change must make sense for both existing packs.
