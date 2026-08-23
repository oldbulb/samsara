# @samsara/runner

Two cordis plugins that turn `dsh --profile host run ...` into champion attempts on one pack task set,
`challenge ...` / `round ...` into a judged challenger (the latter through a proposer on `ctx.proposers`),
and `promote` / `demote` into champion changes. When the champion holds a kept skill
(`ctx.champion.current().skill_ref`, under `data/skills/<sha>`), it is the default skill for every command;
the pack's skill is the fallback.

| plugin | entry | inject | does |
|---|---|---|---|
| `samsara-run-startup` | `@samsara/runner/startup` | `cmdlineArgs` | parses the `run` command with commander and `ctx.provide('samsaraRun', values)`; nothing is provided on `--help` or a usage error (modelled on `@deepseek-ai/dsh-headless/startup`) |
| `samsara-runner` | `@samsara/runner` | `samsaraRun`, `loops`, `agentDefaultModel` | waits for the loader, runs the set through a bounded pool (`--parallel`), prints a summary table, exits through `ctx.appExit`; SIGINT cancels in-flight attempts and still writes their rows |

```
dsh --profile host run --pack <dir> --loop <name> --set <smoke|holdin|holdout>
                       [--limit n] [--repeat r] [--parallel n] [--out dir] [--max-turns n] [--max-minutes m] [--allow tools,...]
```

Defaults: `--repeat 1`, `--parallel 1`, `--out data/runs`, `--max-turns 50`, `--max-minutes 20`; no `--allow` means the provider's default tool set (`tools.allow: []`).

`--parallel n` (also on `challenge`, `round`, `certify`) runs up to n attempts at once through a worker pool over the
task × repeat list (`src/pool.ts`). Pack commands (materialize / truth / score) are subprocesses, so they share a
semaphore of `min(n, 8)`. Rows reach `attempts.jsonl` and the ledger through one serialized writer in completion order;
the result rows and the summary table stay in task × sample order. stderr gets one line per completion
(`[done/total done, running, failed]`) and a heartbeat every 10 s while attempts are in flight.

```
dsh --profile host round --pack <dir> --loop <name> --set <smoke|holdin> --proposer <claude-p|human> --metric <name>
                         [--skill-dir <dir> --intent <text>]   # human proposer from the command line
                         [--n-eff-floor n] [--with-champion] [--gate-policy default|permissive] + the run options
```

`round` (`src/round.ts`): renders the proposer view into `<out>/view/` from `ledger.read(view, 'proposer')`
(champion skill copy, the set's tasks, the champion's attempts/scores with held-out rows as aggregates, compare
rows with held-out per-task deltas removed), runs the adapter in `<out>/proposer/`, validates the Proposal
(schema, every named task id held in, skill surface, metric = `--metric`), writes `<out>/proposal.json`, then
runs the `challenge` chain with the proposal's prediction and `optimizer_config_sha`.

## What one attempt does (`src/run.ts`)

1. `loadPack` (@samsara/pack) → `createBook` (@samsara/book) → `book.tasks(set).slice(0, limit)` × `repeat`.
2. `materialize` (@samsara/workdir) into `<out>/attempts/<attemptId>/` with `challengerId: 'champion'` and `extraSkillDirs: ['.claude/skills/<skill>']`; `attemptId = <runId>-<task_id sanitized>-<r>`.
3. Builds the `AttemptSpec` (docs/design/loops.md): route = `agentDefaultModel.currentSelection()` + plugin config `{baseUrl, credentialRef, lane}`; `tools.deny` = pack `guards.deny_patterns`; `submitTool.name = submit_<pack skill.name>` with the pack contract as schema; `limits` from the flags; `tmpdir` from the workdir (E6); an `AbortSignal` tied to the plugin scope.
4. `ctx.loops.start(loop, spec)`, drains `events` to `<out>/attempts/<attemptId>/events.jsonl`, awaits `result`, then `dispose()` (the workdir is kept).
5. Reads `<workdir>/submit_<name>.json` (the @samsara/submit path) and validates it against the pack contract → `output.valid`.
6. Pack `truth` with `{task_id, workdir}`; if settled, pack `score` with `{task_id, truth, output: {usage, cost_usd, tool_calls, submit, valid, status}}`.
7. Appends one line to `<out>/attempts.jsonl`:
   `{attemptId, task_id, loop, facts_sha, status, stopReason, usage, cost, toolCalls, output:{valid,file?,error?}, truth:{status,truth_sha?,error?}, scores[], error?}`.

A provider rejection or a host-side failure (materialize / truth / score) is still one row: `status` reflects the loop (`FAILED/error` when it never published), `error` says which host step failed. The runner never writes truth, scores, or the book; it only forwards pack stdout.

The plugin config is `!!js`-free (E3): the run request comes from the injected `samsaraRun` service, not from config.

## Build / test

```
pnpm --filter @samsara/runner build      # tsc -b (builds kernel, book, pack, loops, submit, workdir first)
pnpm --filter @samsara/runner test       # vitest; fake loop provider + the minipack fixture from packages/pack/tests
```

Tests never start a real agent or touch the network: the loop is a fake `LoopProvider` and the pack commands are the minipack node scripts.
