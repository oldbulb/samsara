# @oldbulb/samsara-pack

Loads a `pack.yaml`, runs the pack's commands, validates what comes back. The
framework never imports pack code: every command is a child process speaking
jsonl on stdin/stdout (`docs/design/packs.md` is the contract; boundary 2 in
`CLAUDE.md`).

- `loadPack(dir)` → `PackDefinition`: the manifest validated against
  `schema/pack.schema.json`, absolute paths, the contract schema compiled, the
  three task sets parsed (`task_id`, `entity_key` required; `stratum` and
  `environment` typed when present, everything else passed through).
- `runCommand(def, name, lines, opts?)` → the command's stdout as validated
  rows (`truth` and `score` against `schema/*-output.schema.json`,
  `materialize` for `task_id` + `ok`). Errors are `PackError` with a `code`:
  `command-missing`, `spawn`, `exit`, `timeout`, `invalid-line`.
- `commandEnv(def, extra?, source?)`: the environment a host command sees —
  `COMMAND_ENV_ALLOWLIST` plus the names in `runtime.env`, never the host's
  whole environment (E5).
- `validateSubmit(def, obj)`, `surfaceBoundaries(def)`, `protectedPaths(def)`
  (the manifest, the contract, the task sets and every pack file a command
  line names — what the sandbox denies).
- `samsara-pack validate <dir>` is the CLI.

## Commands: on the host or in the environment

A `commands` entry is a shell line, run on the host from the pack dir with
`commandEnv`, or an object:

```yaml
environment:                 # the pack's default; a task row's `environment` column overrides it
  image: example/judge:1     # or dockerfile: <pack-relative dir>
  resources: { cpus: 2, memory_mb: 1024, timeout_s: 90 }
  network: allowlist         # none | allowlist | public
  allowed_hosts: [pypi.org]
commands:
  truth: { run: ./bin/truth, in_environment: true }   # runs inside the attempt's environment
  score: ./bin/score                                  # runs on the host
```

The loader keeps `def.commands[name]` a string either way and adds
`def.commandSpecs[name] = { run, inEnvironment }`. `runCommand` takes
`opts.exec` — the attempt's `Environment.exec`, bound by the caller — and runs
an `in_environment` command through it as `sh -c <run> [args]`, jsonl on
stdin, jsonl on stdout, the same validation as on the host. `opts.cwd` is the
environment's own when absent, `opts.env` layers on the environment's (never
the host's), and the time limit is `opts.timeoutMs`, else the pack's
`environment.resources.timeout_s`, else one hour. An `in_environment` command
with no `exec` is refused with `PackError('spawn')` naming the environment the
pack expects; a command not so marked always runs on the host, `exec` or not.
The `environment` block and a row's `environment` column are the pack's
words for `EnvironmentSpec` (`@oldbulb/samsara-environments`); this package
only carries them.
