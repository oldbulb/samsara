# coding-tasks pack (public, immediate truth)

Source: Aider Polyglot benchmark (Exercism exercises, MIT), Python + JavaScript + Rust + Go tracks.
Skill under optimization: `skill/SKILL.md` — implement the exercise from its instructions.

## Protocol: the tests are hidden

The agent sees `INSTRUCTIONS.md`, the solution stub(s) and the support files —
never the tests. Truth restores the pristine tests over the workdir and scores
with them. This is the protocol of the aider benchmark (test files are excluded
from what the model sees and copied in only to score) and of the Darwin Gödel
Machine's Polyglot harness (the agent's checkout is the stub-only commit; the
tests come back at evaluation). Under the open-book variant — tests visible,
unlimited reruns — `deepseek-v4-flash` scores 1.0 on every task of every track
(measured 2026-08-23 and -25: sd_paired 0 across reruns), so `pass_rate` carries
no signal; hidden tests are what give the metric variance and give a skill patch
something to move.

## Layout

```
pack.yaml
skill/SKILL.md
contract.schema.json                 # submit_fix.json: {summary, files_changed[], confidence}
tasks/{smoke,holdin,holdout}.jsonl   # one task per line, see below
fixtures/<lang>/<exercise>/          # verbatim exercise dir from polyglot-benchmark (no node_modules)
runtime/js/                          # one shared jest/babel install symlinked into JS workdirs
runtime/go/ runtime/rust/            # pack-local toolchains (provision.sh), used when nothing is on PATH
runtime/env.sh                       # puts them on the loop's PATH; runtime/provision.sh installs all four
bin/materialize  bin/truth  bin/score
tools/import_polyglot.py             # regenerates fixtures/ and tasks/ from a polyglot-benchmark checkout
```

## Runtimes

The runtimes are installs, not source, so they are gitignored — provision
them once after a fresh clone (CI does the same before it runs the e2e):

```sh
runtime/provision.sh   # py venv + pytest, js jest/babel, Go tarball, rustup + crate cache
```

Go and Rust land under `runtime/go/` and `runtime/rust/` unless a `go` / `cargo`
is already on PATH. `bin/truth` prefers the pack-local toolchains
(`runtime/py/.venv/bin/python`, `runtime/go/go/bin/go`, `runtime/rust/cargo/bin/cargo`;
override with `$CODING_TASKS_PYTHON` / `_GO` / `_CARGO`) and falls back to PATH.
Both compiled tracks run offline (`GOPROXY=off`, `cargo --offline` against the
crates `runtime/rust/deps/Cargo.toml` pre-fetched). The loop's own shell inherits
the host's environment, so `source runtime/env.sh` before a real run puts the same
toolchains on its PATH.

## Task line

```json
{"task_id":"python/pov","entity_key":"pov","stratum":"python","lang":"python","exercise":"pov","fixture":"fixtures/python/pov"}
```

- `task_id` = `<lang>/<exercise>`; `entity_key` = exercise name (the same exercise in several languages is one entity, so holdout is disjoint by exercise); `stratum` = language.
- Split: deterministic by sha256(entity_key): smoke 15 / holdin 83 / holdout 50 over 148 tasks (py 34 + js 48 + rust 30 + go 36; excluded: javascript/ledger, go/ledger, go/markdown — their stubs already pass — and go/counter, which ships no tests).

## Commands (all read jsonl on stdin, write jsonl on stdout, exit 0 unless the pack itself is broken)

- `bin/materialize` — stdin `{task_id, workdir}`: copies the fixture's solution stubs, support files (Go's `editor` files, data directories), `.docs/{introduction,instructions,instructions.append}.md` concatenated as `INSTRUCTIONS.md` (what aider shows the model; 46 exercises keep API / error-message conventions in the append) and language runtime files (JS: package.json, babel.config.js, symlink `node_modules` → `runtime/js/node_modules`) into `workdir`. Never copies `.meta/` (reference solution) nor the tests (the registered `test` files plus every `*_test.go` / `tests/*.rs`). stdout `{task_id, ok, files[]}`.
- `bin/truth` — stdin `{task_id, workdir}`: restores the pristine test files from the fixture over `workdir` (the agent may have edited them) — the registered `test` files, the `editor` support files, every `*_test.go` / `tests/*.rs`, with JS `xtest` and Rust `#[ignore]` un-skipped — then runs `python -m pytest -q` / `npx jest` / `cargo test --offline` (passed/failed summed over test binaries) / `go test -json ./...` (leaf tests) with a 180 s timeout, stdout `{task_id, status:"settled", truth:{passed, failed, total, exit_code}, truth_sha}` where `truth_sha` = sha256 of the pristine test files.
- `bin/score` — stdin `{task_id, truth, output}` where `output` = `{usage:{input_tokens, output_tokens, cost_usd?}, tool_calls, submit}` from the attempt: stdout lines `pass_rate` (kind reality, value passed/total), `solved` (kind reality, 1 iff every hidden test passes — the aider leaderboard's unit, for reporting; `pass_rate` carries less noise and is the gate's default), `cost_usd` (mechanical), `tool_calls` (mechanical); each with `stratum` = lang.

A reference run is the pack's own smoke test (`tools/selfcheck.py`): materialize (no test file may be visible) → truth on the untouched stub must report failures → copy `.meta/example.*` (and `.meta/Cargo-example.toml` when present) over the stub → truth must report all tests passed.
