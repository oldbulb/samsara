# Packs — the consumer

A pack is everything the framework does not know: the tasks, the truth, the
scoring, the skill being optimized. The framework reaches all of it through
`pack.yaml` and command stdout, never through an import, so a pack can be
written in any language and can live outside this repo.

Two packs are in tree: coding-tasks, the real one, and synthetic, the control.

## packs/coding-tasks (public, immediate truth)

- **Task**: an Exercism exercise from Aider Polyglot — the instructions, a stub, and a test suite the agent never sees (closed-book: tests are hidden at `materialize` and restored by `truth`, the protocol aider and DGM both use). 148 tasks: Python 34, JavaScript 48, Rust 30, Go 36; `entity_key` = the exercise name, shared across languages, so the holdout is disjoint by exercise; `stratum` = language.
- **Skill**: a generic "implement from the instructions" SKILL.md — the thing being optimized.
- **Contract**: `{summary, files_changed[], confidence}` submitted via `submit_fix`.
- **truth**: runs the hidden tests on the submitted workdir; settles immediately. `status: settled` always.
- **score**: `pass_rate` (reality), `cost_usd`, `tool_calls` (mechanical). No judge scores.
- **Why it is here**: it exercises every framework plugin with zero secrets, it runs in CI, it is the open-source demo, and it stresses the scope / workdir / dispose path hard — many short attempts over real file trees.
- **Measured noise floor** (2026-08-25, 83 held-in tasks × 3 reruns, deepseek-v4-flash on the dsh loop): mean pass_rate 0.87, solved 0.74; paired sd 0.36 (task) / 0.34 (entity); 40% of tasks flip between reruns. The detectable effect at 3 reruns is ≈0.14 pass_rate against a declared SESOI of 0.05 — so the gate has so far answered `hold:underpowered`, correctly. Reaching the SESOI needs ≈140 entities or ~10 reruns; Polyglot has 100 exercises. A positive control therefore needs either repeats or a second task source.
- **Open bug**: the runners count tests the agent wrote alongside the restored hidden ones, so `pass_rate` is partly self-graded; `solved` is not.

## packs/synthetic (control, immediate truth)

A coin with a known bias: every task carries a `base_rate`, the skill carries
an `effect`, and `truth` draws `passed` with probability `base_rate + effect`,
paired across skills by task and `sample`. It runs the injected-effect control
(effect 0.15 must promote on holdout) and the A/A control (effect 0 must not)
through every framework seam at zero LLM cost; `tests/synthetic.e2e.test.ts`
pins both, `packs/synthetic/README.md` has the noise and power arithmetic.

## The attempt token

Every workdir carries `.task/token.json`, written read-only (0400) by the
framework before the loop starts. It is all a pack command gets to know about
the attempt beyond its stdin line, and its fields are contract:

| field | |
|---|---|
| `attemptId` | the attempt; equal to the workdir's own directory name |
| `taskId` | the task the workdir was materialized for |
| `challengerId` | the challenger under evaluation (`champion` for the champion's own attempts) |
| `sample` | the attempt's replicate index, 0-based; the same task under the same `sample` is the same replicate across skills, so a truth that pairs its draws (common random numbers) pairs on it |
| `skill_path` | workdir-relative posix path of the skill snapshot, `.agents/skills/<skill name>` |
| `issuedAt` | ISO-8601 time the workdir was sealed |

Nothing else about the attempt is contract — not the shape of the attempt id,
not where the runner keeps its own step markers. A pack that needs more reads
it from the token or the token grows a field.

## Environments (planned)

Today every attempt and every pack command runs on the host, in a sealed
directory. The `environments` seam (`architecture.md` § Plugins) puts a
provider between the two — `local` (today's directory, the default), `docker`,
and, planned, `modal` and `harbor` — and a pack says what it needs of it:

```yaml
environment:                    # the pack's default; absent → the host (`local`)
  image: <ref>                  # or `dockerfile: <dir>` — one of the two
  resources: { cpus: 2, memory_mb: 4096, timeout_s: 1800 }   # optional
  network: none                 # optional: none | allowlist | public
commands:
  truth: { run: ./bin/truth, in_environment: true }   # runs through `exec` inside the attempt's environment
  score: ./bin/score                                  # the plain string form runs on the host, as today
```

A task row may carry an `environment` column that overrides the pack's default
(a Harbor task has its own `environment/` directory). `materialize` still
renders the attempt's files locally; the framework then `put`s them — the skill
snapshot at the same relative path, `.task/token.json`, the materialized task —
into the environment's workdir, so `skill_path` in the token still resolves.
When any command is `in_environment`, the pack directory is mounted read-only
at its own absolute path and the command runs from there, so `./bin/truth`
and the pack's own files resolve as they do on the host.
An `in_environment` command reads the same jsonl on stdin and writes the same
jsonl on stdout; the protocol does not change, only where the process runs. A
pack whose truth needs the container (`tests/test.sh` writing
`/logs/verifier/reward.txt|json`) declares it; coding-tasks keeps running its
commands on the host over a mounted runtime until it moves into an image.

Planned with the seam, outside `packages/`: `tools/pack-from-harbor`, a
generator that turns a Harbor dataset directory into a pack (one task row per
task dir, `environment: { dockerfile: <task>/environment }`, `truth` in the
environment, `score` = `reward` plus one metric per key of `reward.json`, the
oracle `solution/solve.sh` as the pack's self-check); `samsara import harbor
<jobs-dir>`, which turns a Harbor job's trials into `attempts` + `scores` rows
so the gate judges two jobs with a noise floor from a repeated one; and, later,
a rollout export in Harbor's format.

## What a second pack would need

`pack.yaml` (with `metrics.primary` and, if the tasks are presented in a particular way, `tasks.protocol`), a skill dir, a contract schema, task sets with an `entity_key`, and
two executables (`truth`, `score`); if its attempts need a container, an
`environment` block. If it needs in-sandbox data access, a `data`
executable that reads `.task/token.json`; if its truth arrives late, `truth`
answers `status: pending` until it settles and the framework re-scores on the
settlement event.

The framework must not have to change to accept it. A change that only makes
sense against coding-tasks is a sign the abstraction is wrong: the test is
whether it still holds for a pack that shares nothing with this one but the
contract — a different language, a different notion of truth, a different clock.

> A private pack with delayed truth lived in this repository until 2026-08-24
> and was moved out — together with its history — when the repo narrowed to the
> coding-agent line. It survives as a standalone checkout; the delayed-truth
> machinery it motivated (pending truth, settlement re-scoring, stratified
> scoring) stays in the framework and is specified in `architecture.md`.
