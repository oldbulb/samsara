# @oldbulb/samsara-runner

Two cordis plugins that turn `dsh --profile host run ...` into champion attempts on one pack task set,
`challenge ...` / `round ...` into a judged challenger (the latter through a proposer on `ctx.proposers`),
`propose --dry-run` into a validated, diff-scanned proposal that costs nothing, `calibrate` into a noise floor,
`experiment new` / `campaign` / `control` into pre-registered rounds, `status` into one screen of the ledger's
state, `gate bench` into a table of gate acceptance rates on recorded reruns, and `promote` / `demote` into
champion changes. When the champion holds a kept skill (`ctx.champion.current().skill_ref`, under
`data/skills/<sha>`), it is the default skill for every command; the pack's skill is the fallback.

**Commands call `ctx.lifecycle`; they perform no transition.** Every status, verdict, compare row, round,
serving and noise floor is written by `@oldbulb/samsara-lifecycle`; the runner assembles the request (the
champion row for the coordinates, the gate `--gate-policy` names, the run options), mounts `runSet` as
`ctx.executor` — the attempt executor the service runs attempts through — and prints what came back.

| plugin | entry | inject | does |
|---|---|---|---|
| `samsara-run-startup` | `@oldbulb/samsara-runner/startup` | `cmdlineArgs` | parses the `run` command with commander and `ctx.provide('samsaraRun', values)`; nothing is provided on `--help` or a usage error (modelled on `@deepseek-ai/dsh-headless/startup`) |
| `samsara-runner` | `@oldbulb/samsara-runner` | `samsaraRun`, `loops`, `agentDefaultModel`, `ledger`, `lifecycle`, `subprocess`, `environments` | waits for the loader, mounts `ctx.executor`, runs the set through a bounded pool (`--parallel`), one environment per attempt on the provider `--env` names, prints a summary table, exits through `ctx.appExit`; SIGINT cancels in-flight attempts and still writes their rows |
| `gate-presets` | `@oldbulb/samsara-runner/gate-presets` | `gate` | mounts the `--gate-policy` presets (`fast`, `permissive`) and catalog rules named in `config.policies` on `ctx.gate`, in order; optional — without it only `default` resolves |

```
dsh --profile host run --pack <dir> --loop <name> --set <smoke|holdin|holdout>
                       [--limit n] [--stratum s,...] [--repeat r] [--parallel n] [--out dir] [--max-turns n] [--max-minutes m] [--allow tools,...]
                       [--env provider]                  # environment provider the attempts run in (ctx.environments; default local)
                       [--skill-dir dir]                 # run this skill instead of the pack's / the champion's (a baseline to measure against)
dsh --profile host run --resume <runDir>        # re-enter the run recorded in <runDir>/run.json; no other option is read
```

Defaults: `--repeat 1`, `--parallel 1`, `--out data/runs`, `--max-turns 50`, `--max-minutes 20`; no `--allow` means the provider's default tool set (`tools.allow: []`).

### Environments (`--env`; docs/design/architecture.md § Coordinates, `environment_sha`)

Every attempt runs in one environment opened on `ctx.environments` (`@oldbulb/samsara-environments`) by the provider
`--env` names (`local` by default: a directory on this host; `docker` where the row is enabled). The spec comes from
the pack's `environment` block (a task row's `environment` column overrides it): image ref or dockerfile dir, resources
(`timeout_s` else `--max-minutes`), network (`none` unless declared). The sealed workdir is put into it, the loop gets it
as `AttemptSpec.environment` (host-side loops need `local`), the pack's `in_environment` commands run through its `exec`,
the submit file is handed back with `get`, and the environment is disposed with the attempt — and with the challenger's
scope (E4). The provider's facts land on the attempt row (`environment`) and in its `facts_sha`; on a provider other than
`local` the champion and challenger rows carry `environment_sha` (rule 0) computed from the declared image ref, not from
a probe open. `--env` is on `run`, `challenge`, `round`, `certify`, `calibrate`, `campaign`, `control` (and `propose`,
where nothing runs).

### Durable steps and `--resume` (`src/steps.ts`; docs/design/adoptions.md item 1)

`runSet` writes `<out>/run.json` at start (`runId`, the full request minus `out`, the task id list) and, per attempt,
a marker `<out>/attempts/<attemptId>/.steps/<step>.json` (`{step, attemptId, at, ...}`) as each step completes:

| step | marker data | skipped on resume when |
|---|---|---|
| `materialize` | `tmpdir` (relative), `skillSha` | the `loop` marker exists (otherwise the attempt dir is removed and rebuilt) |
| `loop` | the `finished` event, host `error` | it exists — **a finished loop is never re-run** |
| `submit` | the validated submit (`valid`, `file`, `submit`, `error`) | it exists |
| `truth` | `truth` (status, sha), `value` | it exists; a truth error leaves no marker, so resume retries it |
| `score` | `scores` | it exists (written with `[]` when truth is not settled) |
| `record` | `ledger: bool` | never skipped per se: written after the jsonl row + ledger put; an attempt with all six markers and a jsonl row is "done" |

Markers are written atomically (tmp + rename); a torn or unreadable marker reads as missing. A loop the host
cancelled (SIGINT) gets **no** `loop` marker: its row lands as `ABORTED` for the summary, and `--resume` re-runs that
attempt from scratch.

`run --resume <runDir>` reads `run.json`, re-enters `runSet` with the same run id (the book's task list must still
match), compacts `attempts.jsonl` to the rows of done attempts, and runs the rest through the pipeline with the
per-step skips above, so each attempt ends with exactly one row in `attempts.jsonl`. The ledger keys attempts by id
(`recordAttempt` is a put; `appendScores` skips existing keys), so re-recording after a resume overwrites rather than
duplicates — this is how rows lost on SIGINT are recovered. Resuming a completed run is a no-op (no loop started, no
file changed). Library callers set `RunRequest.resume = true` with `out` = the run directory; `challenge` / `round` /
`certify` do not take `--resume` yet (their sub-runs write `run.json` too, so the hook is there).

`--parallel n` (also on `challenge`, `round`, `certify`) runs up to n attempts at once through a worker pool over the
task × repeat list (`src/pool.ts`). Pack commands (materialize / truth / score) are subprocesses, so they share a
semaphore of `min(n, 8)`. Rows reach `attempts.jsonl` and the ledger through one serialized writer in completion order;
the result rows and the summary table stay in task × sample order. stderr gets one line per completion
(`[done/total done, running, failed]`) and a heartbeat every 10 s while attempts are in flight.

```
dsh --profile host challenge --pack <dir> --loop <name> --set <smoke|holdin|holdout> --surface skill --skill-dir <dir> --intent <text> --metric <name>
                             [--n-eff-floor n] [--with-champion] [--gate-policy <name>] [--round <id>] + the run options
dsh --profile host round --pack <dir> --loop <name> --set <smoke|holdin> --proposer <claude-p|human> --metric <name>
                         [--skill-dir <dir> --intent <text>]   # human proposer from the command line
                         [--n-eff-floor n] [--with-champion] [--gate-policy <name>] [--round <id>] + the run options
```

`challenge` (`src/challenge.ts`) is the chain for one challenger through the service: `lifecycle.openRound` for
the champion row of these coordinates (or the round `--round <id>` names, opened again in this process under its
own gate, shadows and experiment — a round can be joined only before its first judgement: Holm's k is the sibling
count at the first statistic computed under the round (S4) and freezes there, so `propose` into a round that
already judged a sibling refuses with `ROUND_CLOSED` and the new sibling needs a new round) → `propose` (rule 0 is the service's) → `open` (diff scan; a rejection is a
decided row) → `run` on the tier (the champion first when the ledger holds nothing on the tasks, or with
`--with-champion`) → `judge` under the round's gate with the shadows beside it → `decide`: a holdout `promote`
verdict from the round's gate leaves the round open for its consent (`promote <id> --wait`), anything else
decides it without a candidate. A row the service will not run — decided before this command, rejected by the
diff scan, invalid on the run invariant — is rendered from the ledger and its round is closed
(`lifecycle.closeRound`), so no rejected challenger leaves a round open. The result carries the round id, the
compare row of the gate `--gate-policy` named, and the decision.

`round` (`src/round.ts`): opens the round first, renders the proposer view into `<out>/view/` from `ledger.read(view, 'proposer')`
(champion skill copy, the set's tasks, the champion's attempts/scores with held-out rows as aggregates, the compare
rows the champion is a side of with held-out rows reduced to verdict + Ladder signal and shadow rows left out), runs the adapter in `<out>/proposer/`, validates the Proposal
(schema, every named task id held in, skill surface, metric = `--metric`), writes `<out>/proposal.json`, then
runs the `challenge` chain in that round with the proposal's prediction and `optimizer_config_sha`.

The view directory also carries `view.json` (`{view_version: 1, champion_id, metric, files}`), `proposal.schema.json`
(the draft schema the host validates with) and `environment.md`: the loop's name and harness facts (including the
envelope fidelity triple), the attempt limits and tool allow/deny the runner would use, the pack's name and task
version, and the out-directory protocol. Nothing in `environment.md` comes from the ledger; the redaction of the
ledger files is unchanged. `examples/proposers/README.md` is the contract as a proposer sees it.

`--gate-policy <name>` (on `challenge`, `round`, `certify`) takes `default` (the policy mounted last on `ctx.gate`:
gate-default, or a `plugin-command` gate the profile mounted after it), the presets `fast` (alpha 0.10,
`gate-fast@0.1.0`) and `permissive` (TEST ONLY, `gate-permissive@test`), or any rule of
`@oldbulb/samsara-gate-catalog` by name (`keep-better`, `miller`, `pace`, … — `--help` lists them; `name@version` works
too). The named policy must be **mounted** on `ctx.gate` by the profile (a policy a command registered would become
the promotion gate, the one mounted last) — a `@oldbulb/samsara-runner/gate-presets` row with
`config: { policies: [fast, keep-better] }` does that, placed before the `gate-default` row: mounted before the
promotion gate it judges beside it as a **shadow**
(the round pins it in `shadow_gates`; its compare row records `gate: name@version` and `shadow: true` beside the
promotion verdict, which alone sets the challenger's verdict; the output says so) unless the ledger holds a
`gate_change` consent whose subject is that policy's `name@version` (`samsara-signoff confirm --row <name@version>
--action gate_change`), in which case the round pins it as its gate and it judges for real. A mounted promotion
gate other than gate-default needs such a consent before anything opens under it. An unknown name is a usage
error; an unmounted one refuses before anything opens.

A challenger whose row the ledger already holds as `decided` (diff-scan rejected, dropped, invalid, or reversed)
is not run again: `challenge` / `round` / `certify` print the recorded verdict (with its compare row when a gate
set it), decide the round they opened, and exit 0. A rejection or a `coordinates:facts` invalid on a fresh row
decides the round the same way, so no round is left open behind it.

```
dsh --profile host propose --pack <dir> --proposer <name|./command> --set <smoke|holdin> --metric <name> --dry-run
                           [--loop <name>] [--limit n] [--out <dir>] [--skill-dir <dir> --intent <text>] + the run options
```

`propose --dry-run` (`src/propose.ts`): everything `round` does before it costs anything, and nothing after. It renders
the same view (the champion id is computed from its coordinates, not proposed on the ledger; `--loop` defaults to
`null` and only describes the environment), runs the proposer once — a registered adapter by name, or a path
(anything containing `/`) wrapped in the `command` adapter of `@oldbulb/samsara-proposers` under the
`--view/--out` contract — validates the Proposal exactly as `round` does, runs the same diff scan `scopes.open`
would run (E8/S5, against the selected task ids), writes `<out>/proposal.json`, and prints one screen: proposer
`name@version`, champion id, surface, patch sha, intent, prediction, scan result. Exit 0 when the scan passes, 1
when it rejects (the violations are listed) or the proposal is invalid. No scope is opened, no attempt runs, no
ledger row is written. Without `--dry-run` the command refuses and points at `round`, which is the full path.

```
dsh --profile host calibrate --pack <dir> --loop <name> --metric <name> [--set <smoke|holdin|holdout>] [--reruns n] + the run options (no --repeat)
dsh --profile host experiment new --pack <dir> --hypothesis "…" --metric <name> [--direction up|down] [--magnitude x]
                                  [--budget-usd x] [--budget-rounds n] [--budget-attempts n] [--budget-holdout-reveals n] [--n-eff-floor n] [--who name]
dsh --profile host campaign --pack <dir> --loop <name> --experiment <id> --proposer <name> --metric <name> [--set <smoke|holdin>]
                            [--rounds N] [--auto-holdout] [--stop-on-promote] [--max-consecutive-holds n] [--max-repeat r] [--holdout-repeat r]
                            [--budget-usd x] [--shadow-gates a,b] [--n-eff-floor n] [--wait <seconds>] + the run options
dsh --profile host control aa|inject --pack <dir> --loop <name> --metric <name> [--skill-dir <dir>] [--experiment <id>] [--shadow-gates a,b] + the run options (no --set)
dsh --profile host status
dsh --profile host promote <challengerId> [--wait <seconds>] [--round <id>]
dsh --profile host demote <challengerId> --reason <text> [--wait <seconds>]
```

`calibrate` (`src/calibrate.ts`): `lifecycle.calibrate` — the champion rerun `--reruns` times (>= 3, default 3) on
the set with the null diff, its attempts recorded under the champion row, and a `noise_floors` row (S1: `sd_paired`
of the per-entity mean between every two reruns, `n_reruns`, `n_tasks`, the tier). Rounds pin the latest floor for
their champion row, and a holdout judgement needs one. The champion row a round anchors on carries the set's
taskset sha, so calibrate on the set the rounds use (`--set holdin` for a campaign).

`experiment new` (`src/experiment.ts`): `lifecycle.preregister` — the hypothesis, the prediction (`--metric`,
`--direction`, `--magnitude`), the pack, the gate the rounds will open under (the promotion gate at the policy
`openRound` computes for the pack's `holdout.mde` and `--n-eff-floor`) and the budget, before any spend. Prints the
experiment id; rounds join it through `campaign --experiment` and `control --experiment`, and the service refuses a
round whose gate differs from the pre-registered one.

`campaign` (`src/campaign.ts`): `lifecycle.campaign` — rounds under the experiment until `--rounds`,
`--max-consecutive-holds` (default `--rounds`), `--budget-usd` or `--stop-on-promote` stops them. Per round the
driver opens the round, this package renders the proposer view (with `history.jsonl` beside it: the prior siblings'
held-in numbers, never a held-out one), runs the proposer from `ctx.proposers` under the E9 sandbox policy, then
`propose → open → run(smoke) → run(holdin) → judge`, doubling the held-in replicates while underpowered (up to
`--max-repeat`), escalating a hold to holdout with `--auto-holdout` or a `holdout_reveal` consent, and `decide`. A
`promote` candidate needs its consent: with `--wait` a sign-off is opened for it (and for `holdout_reveal`) and
waited for; without one, or on timeout, the campaign pauses and prints the candidate — rerunning with the same
`--experiment` resumes from the open round. Events go to stderr; the champion is re-read from `ctx.champion`
before every round.

`control aa|inject` (`src/control.ts`): `lifecycle.control` — one round judged at holdout whose challenger is a
copy of the champion's own skill (`aa`: the null diff must not promote) or `--skill-dir` (`inject`: a known effect
must), intent `control:aa` / `control:inject`; the round closes without a decision. Needs the noise floor of a
`calibrate --set holdout`.

`status` (`src/status.ts`): `lifecycle.status()` — the champion, the rounds not yet decided, the promote consents
pending (with the `promote … --wait` line that answers each), the latest noise floor per evaluation
configuration, the experiments with what they spent of their budget.

`promote <id>` finds the promote consent on the ledger (with `--wait`, opens a sign-off and waits for the proof),
then `lifecycle.decide` on the row's open round (`--round <id>` names it): the service promotes the round's
candidate — the largest lower CI bound among its promote verdicts — which must be this row, writes the serving row
and supersedes the other promotes. `demote <id> --reason …` needs a `demote` consent the same way (`--wait`), then
`lifecycle.demote`.

```
dsh --profile host gate bench --attempts <attempts.jsonl> --tasks <tasks.jsonl> --metric <name>
                              [--gates <names,...>] [--gate-command <path>] [--resamples N] [--seed N]
                              [--sesoi x] [--n-eff-floor n] [--out <json>]
dsh --profile host gate change <name@version> [--wait <seconds>]   # a gate_change sign-off naming the policy; prints the consents row id
```

`gate bench` (`src/bench.ts`): measures gate policies on recorded attempts through `bench` of
`@oldbulb/samsara-gate-catalog/bench`. `--attempts` is a runner `attempts.jsonl` of >= 2 same-config reruns of one
champion (the per-task rerun pairs are the null); `--tasks` supplies `entity_key` (and `stratum`) per `task_id`,
which is what the bootstrap clusters by. `--gates` names presets (`default`, `fast`) and catalog rules; the default
list is `default` plus every catalog rule; `--gate-command` adds a gate written in any language, run as a
subprocess per judgement (`CommandGatePolicy`, `examples/gates/README.md`), labelled `<basename>@command`. `--sesoi`
and `--n-eff-floor` go into the policy every request carries. The markdown table (`formatBench`) goes to stdout;
`--out` also writes the full `BenchResult` as JSON. No ledger, no pack command, no model: the same two files and
seed always print the same table. The rates are bootstrap acceptance rates on that one pack, not population error
rates — see the catalog README.

## What one attempt does (`src/run.ts`)

1. `loadPack` (@oldbulb/samsara-pack) → `createBook` (@oldbulb/samsara-book) → `book.tasks(set).slice(0, limit)` × `repeat`.
2. `materialize` (@oldbulb/samsara-workdir) into `<out>/attempts/<attemptId>/` with `challengerId: 'champion'` and `extraSkillDirs: ['.claude/skills/<skill>']`; `attemptId = <runId>-<task_id sanitized>-<r>`.
3. Builds the `AttemptSpec` (docs/design/loops.md): route = `agentDefaultModel.currentSelection()` + plugin config `{baseUrl, credentialRef, lane}`; `tools.deny` = pack `guards.deny_patterns`; `submitTool.name = submit_<pack skill.name>` with the pack contract as schema; `limits` from the flags; `tmpdir` from the workdir (E6); an `AbortSignal` tied to the plugin scope.
4. `ctx.loops.start(loop, spec)`, drains `events` to `<out>/attempts/<attemptId>/events.jsonl`, awaits `result`, then `dispose()` (the workdir is kept).
5. Reads `<workdir>/submit_<name>.json` (the @oldbulb/samsara-submit path) and validates it against the pack contract → `output.valid`.
6. Pack `truth` with `{task_id, workdir}`; if settled, pack `score` with `{task_id, truth, output: {usage, cost_usd, tool_calls, submit, valid, status}}`.
7. Appends one line to `<out>/attempts.jsonl`:
   `{attemptId, task_id, loop, facts_sha, status, stopReason, usage, cost, toolCalls, output:{valid,file?,error?}, truth:{status,truth_sha?,error?}, scores[], error?}`.

A provider rejection or a host-side failure (materialize / truth / score) is still one row: `status` reflects the loop (`FAILED/error` when it never published), `error` says which host step failed. The runner never writes truth, scores, or the book; it only forwards pack stdout.

The plugin config is `!!js`-free (E3): the run request comes from the injected `samsaraRun` service, not from config.

## Build / test

```
pnpm --filter @oldbulb/samsara-runner build      # tsc -b (builds kernel, book, pack, loops, submit, workdir first)
pnpm --filter @oldbulb/samsara-runner test       # vitest; fake loop provider + the minipack fixture from packages/pack/tests
```

Tests never start a real agent or touch the network: the loop is a fake `LoopProvider` (or the built-in null
loop) and the pack commands are the minipack node scripts. The command tests (`challenge`, `round`, `calibrate`,
`control`, `campaign`, `experiment`, `promote`) run a real `Lifecycle` over the lifecycle package's fakes
(`tests/harness.ts`, built the way `packages/lifecycle/tests` builds the service) with this package's `runSet` as
the executor — `campaign` with the lifecycle's scripted executor and fixture pack. `tests/propose.test.ts` runs
`tests/fixtures/proposer.mjs` through the command adapter; `tests/bench.test.ts` benches three gates on the
249-row fixture `tests/fixtures/runs/run-dsh-noise-closed.attempts.jsonl` with 25 resamples.
