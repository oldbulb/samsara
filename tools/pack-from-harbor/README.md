# pack-from-harbor

A Harbor task directory, or a dataset directory of them, becomes a samsara
pack. The framework stays pack-agnostic: this is a tool outside `packages/`,
and the pack it writes talks to the framework through `pack.yaml` and command
stdout like any other.

```sh
node tools/pack-from-harbor/pack-from-harbor.mjs <harbor dir> packs/<name> [--name <name>] [--holdout-fraction 0.3] [--smoke 4] [--force]
```

Node, stdlib only (`toml.mjs` reads task.toml). Deterministic: the same input
gives the same pack byte for byte.

## What a Harbor task is, and where it lands

A task dir is `task.toml` + `instruction.md` + `environment/Dockerfile` (or
`[environment].docker_image`) + `solution/solve.sh` + `tests/test.sh`. Harbor
runs the agent in the image's working directory, copies `tests/` to `/tests`
after the agent and runs `bash /tests/test.sh` from that working directory
under `[verifier].timeout_sec`, then reads `/logs/verifier/reward.json` (one
number per key) or `reward.txt` (one number); its oracle agent copies
`solution/` to `/solution` and runs `solve.sh` the same way (Harbor
`models/trial/paths.py`, `verifier/verifier.py`, `agents/oracle.py`).

The pack reproduces that:

| pack | from |
|---|---|
| `harbor/<dir>/` | the task dir, copied whole; the runner mounts the pack read-only into the environment at its own path, so it is reachable there |
| task row `task_id` / `entity_key` | `[task].name` (`org/name`) / its short name; the dir name without a `[task]` section |
| task row `stratum` | the first `[task].keywords` entry, else the pack name |
| task row `environment` | `{ dockerfile: harbor/<dir>/environment }` or `{ image }`, `resources` from `[environment].cpus` / `memory_mb`, `network` from `network_mode` (`public` when unset, as Harbor defaults) + `allowed_hosts` |
| task row `workdir` | `[environment].workdir`, else the Dockerfile final stage's last `WORKDIR` (a builder stage's does not count); absent when neither says, refused when it cannot be resolved statically (a variable in it, or only an earlier stage sets one) |
| task row `verifier_timeout_s`, `agent_timeout_s`, `verifier_env`, `solution_env` | `[verifier]`, `[agent]`, `[verifier.env]`, `[solution.env]` |
| `bin/materialize.mjs` (host) | writes `instruction.md` into the workdir, leading canary lines stripped as Harbor does |
| `bin/truth` (`in_environment`, bash) | `/tests` + `bash /tests/test.sh` + the reward files; `truth: { reward }` or `{ rewards }` (reward.json as written); `truth_sha` = sha256 of the task's `tests/` |
| `bin/score.mjs` (host) | `reward` (reality) plus one reality metric per other `reward.json` key; a reward that is not a number is an error |
| `bin/oracle <token>` (bash, not a pack command) | `/solution` + `bash /solution/solve.sh` for the attempt the token names; the pack's self-check, the installed loop's command `[bash, <pack>/bin/oracle, '{attempt}']` |
| `skill/SKILL.md` | what the installed agent reads: complete `instruction.md` in the working directory |
| `contract.schema.json` | `{}` — there is no structured submission, finishing is the submission |

Tiers: `holdout` = the tasks whose entity key hashes below `--holdout-fraction`
(disjoint by entity, stable across runs), `holdin` = the rest, `smoke` = the
first `--smoke` held-in tasks in hash order.

Refused, loudly, rather than silently narrowed: multi-step (`[[steps]]`) and
non-linux tasks; an `[agent]` or `[verifier]` network policy that differs from
the `[environment]` baseline (the environment cannot switch networks per
phase, and Harbor honors those); a separate verifier environment
(`[verifier].environment_mode = "separate"` or `[verifier.environment]` —
truth runs in the agent's environment); `[agent].user` / `[verifier].user`
(everything runs as the image's default user); a `[verifier.env]` /
`[solution.env]` value the in-environment reader cannot carry (see below).

What runs inside the environment (`bin/truth`, `bin/oracle`, `bin/lib.sh`) is
bash on coreutils — what Harbor's own verifier needs of an image, which is
otherwise arbitrary (the examples build on plain `ubuntu`, no node, no
python); the task rows are read there with `sed`, so a `[verifier.env]` or
`[solution.env]` value must be a string without `"`, `\`, `,`, `}` or a
newline — the generator refuses anything else — and a `${VAR}` template,
which Harbor resolves from the host environment, is passed literally. What
runs on the host
(`bin/materialize.mjs`, `bin/score.mjs`) is node. The generated README carries
the recipe for running the pack: the `environments-docker` and
`loops-installed` rows, `run --loop installed --env docker`, `import harbor`.

## Known limitation: the mount exposes tests/ and solution/ (E9)

Harbor copies a task's `tests/` into the environment only after the agent has
run and its `solution/` only for the oracle. This pack instead rides the
runner's whole-pack read-only mount, which is up for the entire attempt: an
agent that goes looking can read `harbor/<task>/tests/`,
`harbor/<task>/solution/` and `tasks/holdout.jsonl` at the pack's own path
while it works. Until the runner delivers `tests/` and `solution/` at command
time (`put` from the host) instead of the mount, treat rewards from an agent
that could have looked accordingly.

## Example

`examples/hello-world/` is Harbor's `examples/tasks/hello-world` (repository
`harbor-framework/harbor`, commit `233e59f0431a2afeb2b407334687b5ce583ea73c`,
Apache-2.0), copied verbatim. `packs/harbor-hello/` is what this tool makes of it:

```sh
node tools/pack-from-harbor/pack-from-harbor.mjs tools/pack-from-harbor/examples/hello-world packs/harbor-hello --name harbor-hello --holdout-fraction 0 --force
```

`tests/pack-from-harbor.test.ts` pins that the committed pack is this output.
