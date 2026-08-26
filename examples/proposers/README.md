# Proposers in any language

A proposer is the optimizer: it reads what the framework lets it see and writes
one `Proposal`. The framework never trusts it and never shows it truth
(`docs/design/proposers.md`). Through the `command` adapter
(`@oldbulb/samsara-proposers/plugin-command`) a proposer is any executable that
follows the directory-in / directory-out contract below. Two SDKs implement the
file handling: `@oldbulb/samsara-proposer-sdk` (TypeScript, `packages/proposer-sdk`)
and `samsara_proposer` (Python, `sdk/py`, standard library only).

## Invocation

```
<command> [args...] --view <viewDir> --out <outDir>
```

- exit `0` on success; anything else rejects the proposal;
- stderr is the log (saved as `<outDir>/proposer.stderr.txt`; stdout as `proposer.stdout.txt`);
- the process starts with `cwd = <outDir>`, an explicit environment (`HOME` and
  `TMPDIR` at `<outDir>`, the parent's credential-shaped variables scrubbed) and,
  where the host enforces (Linux landlock), the view read-only and `<outDir>` the
  only writable root;
- `timeoutMs` (default 600000) terminates the process tree.

## The view directory (input)

| file | shape |
|---|---|
| `view.json` | `{ "view_version": 1, "champion_id": string, "metric": string, "files": [names present] }` |
| `champion.json` | `{ "challenger_id": string, "skill": "champion-skill/", "metric": string }` |
| `champion-skill/` | the champion's skill directory (`SKILL.md` plus whatever it ships) |
| `tasks.jsonl` | held-in task rows, one per line; opaque beyond `task_id`, `entity_key`, `stratum` |
| `champion-attempts.jsonl` | the champion's attempt rows as the proposer view allows |
| `champion-scores.jsonl` | the champion's score rows (`attempt_id`, `task_id`, `metric`, `value`, optional `side_info`) |
| `compares.jsonl` | compare rows the champion is a side of (`challenger_id` or `vs_id`); held-in rows whole, a held-out row redacted to `{redacted: true, challenger_id, vs_id, tier, method, rule_fired, verdict, ladder?}`; shadow rows are never rendered |
| `environment.md` | optional: loop name, harness facts, tool allow/deny, limits, protocol |
| `proposal.schema.json` | optional: the JSON schema of `proposal.json` |

Never present: truth payloads, hidden tests, held-out task rows, other
challengers' scores of the same round.

## The out directory (output)

`proposal.json`:

```json
{
  "surface": "skill",
  "patch": { "surface": "skill", "skill_dir": "skill" },
  "intent": "one paragraph: what the change is and why",
  "prediction": {
    "metric": "<view.metric>",
    "direction": "up",
    "magnitude": 0.05,
    "predicted_fixes": ["<task_id>"],
    "at_risk": ["<task_id>"]
  },
  "parent": "<optional; the host stamps the champion id>"
}
```

- `surface`: one of `skill`, `prompt`, `memory`, `tools`, `runtime`, `route`, `context`; it must equal `patch.surface`;
- `patch` for `skill`: `{ "surface": "skill", "skill_dir": "<path>" }` — relative paths resolve against the out directory and must stay inside it; the directory needs a `SKILL.md`. Conventionally the new skill goes to `<outDir>/skill/`;
- `patch` for any other surface: `{ "surface": "<name>", "rows": [ <object>, ... ] }` (cordis patch rows, at least one);
- `prediction.metric` must be the view's metric; `direction` is `up` or `down`; `magnitude` optional; the task-id lists may name only ids from `tasks.jsonl`;
- no other top-level keys. The host adds `proposer` (`name`, `version`, `config_sha` = sha256 of the command and args) and rejects anything that fails the schema.

## Examples

| file | what |
|---|---|
| `noop.py` | returns the champion skill unchanged (`intent: "no-op conformance proposal"`); the zero-spend wiring check |
| `hillclimb_llm.py` | asks an OpenAI-compatible endpoint (`OPENAI_BASE_URL` / `OPENAI_API_KEY` / `OPENAI_MODEL`, or `--base-url` / `--model` in `args`) to rewrite `SKILL.md` given the failed tasks; spends money, never run in tests |

Both take the SDK from `../../sdk/py` via `sys.path`.

## Dry run

Against a hand-made view, no host at all:

```
mkdir -p /tmp/v /tmp/o && cp -r packs/coding-tasks/skill /tmp/v/champion-skill
printf '{"challenger_id":"ch-x","skill":"champion-skill/","metric":"pass"}' > /tmp/v/champion.json
python3 examples/proposers/noop.py --view /tmp/v --out /tmp/o && cat /tmp/o/proposal.json
```

Through the host (`propose --dry-run` renders the view from the pack's set, runs
the proposer once and prints the validated Proposal without opening a scope or
spending a round; `--metric` names the metric the prediction must cover):

```
dsh --profile host propose --proposer ./examples/proposers/noop.py --pack packs/coding-tasks --set smoke --metric <name> --dry-run
```

## Registering one

One bundle row per proposer, each under its own `name`
(`packages/bundle/cordis.patch.yml` carries a commented example):

```yaml
- id: proposer-hillclimb
  name: '@oldbulb/samsara-proposers/plugin-command'
  inject: [proposers, subprocess, credentials]
  config:
    name: hillclimb
    command: python3
    args: [examples/proposers/hillclimb_llm.py, --model, <model id>]
    timeoutMs: 600000
    credentialRef: OPENAI_KEY       # resolved through ctx.credentials (E5) ...
    credentialVar: OPENAI_API_KEY   # ... and injected as this variable only
```

Then `round --proposer hillclimb ...`.

## Tests

`pnpm exec vitest run packages/proposers/tests/command.test.ts` runs a node
fixture proposer through `CommandAdapter` (success, non-zero exit, malformed
proposal, timeout, abort) and `noop.py` when `python3` is on `PATH`.
`pnpm exec vitest run packages/proposer-sdk/tests` round-trips the TypeScript
SDK on a fixture view and checks its schema against the host's. All offline.
