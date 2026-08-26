# samsara (dsh bundle)

The dsh bundle that mounts samsara over `@deepseek-ai/dsh-base`. A profile lists it in `dsh.profile.bundles`:

```json
{ "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@oldbulb/samsara"] } } }
```

`cordis.patch.yml` inserts, in order: `samsara-storage`, `storage-sqlite`, `samsara-storage-domain` (the hub, the sqlite backend and the `samsara_ledger` domain — dsh-base mounts no storage), `ledger`, `gate`, `gate-default`, `loops` (the registry), `loops-null`, `loops-dsh`, `loops-claude-code` (`disabled: true`: the Claude Agent SDK is an optional peer), `proposers`, `proposer-human`, `proposer-claude-p`, `scopes`, `signoff`, `champion`, `lifecycle`, `samsara-webserver`, `samsara-ui`, `samsara-run-startup`, `samsara-runner`. Every row is plain YAML (no `!!js`, E3). The runner row injects `samsaraRun`, the service the startup row provides after parsing the command line, so it mounts only when `run` was actually invoked with valid arguments.

Deployment facts that belong to a profile, not this bundle (override them in `profiles/<name>/cordis.patch.yml`):

- `loops-claude-code.config.{baseUrl, credentialRef}` and `samsara-runner.config.{baseUrl, credentialRef, lane}` — the external LLM proxy and the credential *reference* (never a secret; resolved through `ctx.credentials`, E5).
- `proposer-claude-p.config.{command, model, baseUrl, credentialRef}` — the `claude -p` proposer's route; a patch replaces the whole config, so the profile restates `command` too.
- `agent-default-model` — the route the runner copies into every `AttemptSpec`.
- `storage-sqlite.config.path` — where the ledger lands (`data/ledger/samsara_ledger.sqlite`, resolved against the launch cwd); pin an absolute path per deployment.
- `signoff.config.{socketPath, publicKeyPath}` — the consent socket and the signer's public key (`signoff.pub` only; a `signoff.key` beside it makes the service refuse every proof, E2).
- `champion.config.{profileDir, skillStore}` — the profile whose generated section the champion owns and where kept skill snapshots live.
- `samsara-webserver.config.port` — `0` here so one-shot commands never collide; pin a port for `serve`.

Then:

```
dsh --profile host run --pack packs/<name> --loop null --set smoke --limit 1
dsh --profile host run --pack packs/<name> --loop dsh  --set smoke --limit 2 --repeat 2 --out data/runs
```

Output: `<out>/attempts.jsonl` (one row per attempt) and `<out>/attempts/<attemptId>/` (sealed workdir, kept, plus `events.jsonl`). The summary table goes to stdout; progress to stderr; exit code 0 when the run completed, 1 on a host error.
