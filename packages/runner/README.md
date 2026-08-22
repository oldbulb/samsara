# @samsara/runner

Two cordis plugins that turn `dsh --profile host run ...` into champion attempts on one pack task set.

| plugin | entry | inject | does |
|---|---|---|---|
| `samsara-run-startup` | `@samsara/runner/startup` | `cmdlineArgs` | parses the `run` command with commander and `ctx.provide('samsaraRun', values)`; nothing is provided on `--help` or a usage error (modelled on `@deepseek-ai/dsh-headless/startup`) |
| `samsara-runner` | `@samsara/runner` | `samsaraRun`, `loops`, `agentDefaultModel` | waits for the loader, runs the set sequentially, prints a summary table, exits through `ctx.appExit` |

```
dsh --profile host run --pack <dir> --loop <name> --set <smoke|holdin|holdout>
                       [--limit n] [--repeat r] [--out dir] [--max-turns n] [--max-minutes m] [--allow tools,...]
```

Defaults: `--repeat 1`, `--out data/runs`, `--max-turns 50`, `--max-minutes 20`; no `--allow` means the provider's default tool set (`tools.allow: []`).

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
