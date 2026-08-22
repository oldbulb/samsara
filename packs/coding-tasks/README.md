# coding-tasks pack (public, immediate truth)

Source: Aider Polyglot benchmark (Exercism exercises, MIT), Python + JavaScript tracks.
Skill under optimization: `skill/SKILL.md` — "fix the failing tests".

## Layout

```
pack.yaml
skill/SKILL.md
contract.schema.json                 # submit_fix.json: {summary, files_changed[], confidence}
tasks/{smoke,holdin,holdout}.jsonl   # one task per line, see below
fixtures/<lang>/<exercise>/          # verbatim exercise dir from polyglot-benchmark (no node_modules)
runtime/js/                          # one shared jest/babel install symlinked into JS workdirs
bin/materialize  bin/truth  bin/score
tools/import_polyglot.py             # regenerates fixtures/ and tasks/ from a polyglot-benchmark checkout
```

## Task line

```json
{"task_id":"python/pov","entity_key":"pov","stratum":"python","lang":"python","exercise":"pov","fixture":"fixtures/python/pov"}
```

- `task_id` = `<lang>/<exercise>`; `entity_key` = exercise name (the same exercise in two languages is one entity, so holdout is disjoint by exercise); `stratum` = language.
- Split: deterministic by sha256(entity_key): smoke 8 / holdin ~45 / holdout ~30 over 82 tasks (py 34 + js 48; javascript/ledger excluded: its stub already passes).

## Commands (all read jsonl on stdin, write jsonl on stdout, exit 0 unless the pack itself is broken)

- `bin/materialize` — stdin `{task_id, workdir}`: copies the fixture's solution stubs, test files, `.docs/instructions.md` (as `INSTRUCTIONS.md`) and language runtime files (JS: package.json, babel.config.js, symlink `node_modules` → `runtime/js/node_modules`) into `workdir`. Never copies `.meta/` (reference solution). stdout `{task_id, ok, files[]}`.
- `bin/truth` — stdin `{task_id, workdir}`: restores the pristine test files from the fixture over `workdir` (the agent may have edited them), runs `python -m pytest -q` / `npx jest` with a 180 s timeout, stdout `{task_id, status:"settled", truth:{passed, failed, total, exit_code}, truth_sha}` where `truth_sha` = sha256 of the pristine test files.
- `bin/score` — stdin `{task_id, truth, output}` where `output` = `{usage:{input_tokens, output_tokens, cost_usd?}, tool_calls, submit}` from the attempt: stdout lines `pass_rate` (kind reality, value passed/total), `cost_usd` (mechanical), `tool_calls` (mechanical); each with `stratum` = lang.

A reference run is the pack's own smoke test: materialize → copy `.meta/example.*` over the stub → truth must report all tests passed; the untouched stub must report failures.
