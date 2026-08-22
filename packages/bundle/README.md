# samsara (dsh bundle)

The dsh bundle that mounts samsara over `@deepseek-ai/dsh-base`. A profile lists it in `dsh.profile.bundles`:

```json
{ "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "samsara"] } } }
```

`cordis.patch.yml` inserts, in order: `loops` (the registry), `loops-null`, `loops-dsh`, `loops-claude-code`, `samsara-run-startup`, `samsara-runner`. Every row is plain YAML (no `!!js`, E3). The runner row injects `samsaraRun`, the service the startup row provides after parsing the command line, so it mounts only when `run` was actually invoked with valid arguments.

Deployment facts that belong to a profile, not this bundle (override them in `profiles/<name>/cordis.patch.yml`):

- `loops-claude-code.config.{baseUrl, credentialRef}` and `samsara-runner.config.{baseUrl, credentialRef, lane}` — the external LLM proxy and the credential *reference* (never a secret; resolved through `ctx.credentials`, E5).
- `agent-default-model` — the route the runner copies into every `AttemptSpec`.

Then:

```
dsh --profile host run --pack packs/<name> --loop null --set smoke --limit 1
dsh --profile host run --pack packs/<name> --loop dsh  --set smoke --limit 2 --repeat 2 --out data/runs
```

Output: `<out>/attempts.jsonl` (one row per attempt) and `<out>/attempts/<attemptId>/` (sealed workdir, kept, plus `events.jsonl`). The summary table goes to stdout; progress to stderr; exit code 0 when the run completed, 1 on a host error.
