# Packs — the consumer

A pack is everything the framework does not know: the tasks, the truth, the
scoring, the skill being optimized. The framework reaches all of it through
`pack.yaml` and command stdout, never through an import, so a pack can be
written in any language and can live outside this repo.

There is one pack in tree.

## packs/coding-tasks (public, immediate truth)

- **Task**: an Exercism exercise from Aider Polyglot — a stub file, a hidden test suite and a one-line goal. 82 tasks, Python 34 + JavaScript 48; `entity_key: task`.
- **Skill**: a generic "fix the failing tests" SKILL.md — the thing being optimized.
- **Contract**: `{summary, files_changed[], confidence}` submitted via `submit_fix`.
- **truth**: runs the hidden tests on the submitted workdir; settles immediately. `status: settled` always.
- **score**: `pass_rate` (reality), `cost_usd`, `tool_calls` (mechanical). No judge scores.
- **Why it is here**: it exercises every framework plugin with zero secrets, it runs in CI, it is the open-source demo, and it stresses the scope / workdir / dispose path hard — many short attempts over real file trees.
- **Known limit**: the model at hand solves Python/JS Exercism at ceiling, so the noise floor is zero and no positive control can promote. A harder set (more Polyglot languages, SWE-smith-style synthetic bugs) is what the statistical gate still needs to be falsified against.

## What a second pack would need

`pack.yaml`, a skill dir, a contract schema, task sets with an `entity_key`, and
two executables (`truth`, `score`). If it needs in-sandbox data access, a `data`
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
