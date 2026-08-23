# @samsara/sandbox

Filesystem policy for the processes the framework runs on behalf of a
challenger — the attempt's loop subprocess and the proposer — and the wrapper
that enforces it (architecture E8/E9, `docs/design/pod-and-adoptions.md`
adopted practice 2).

Two pure functions and one probe:

- `policyFor({ workdir, packDir, runtimeDirs?, fixturePath?, readOnly?, systemRoots?, ledgerDir?, homeDir?, denied? })`
  → `{ readOnly, readWrite, denied }`. `readWrite` is the workdir (+ `/dev/null`);
  `readOnly` is the OS runtime roots, the pack's `skill/` and `loader/`, the
  runtime roots, the fixture cache entry and any extra roots (the proposer's
  rendered view); `denied` is the pack's `tasks/`, `data/`, `fixtures/`,
  `bin/truth`, `bin/score`, the ledger dir, `~/.config`, `~/.ssh`, `~/.claude`,
  `~/.credentials.yaml` and whatever the caller adds. The composition throws
  (`SandboxError`) if any denied path lies under an allowed root or any
  allowed root lies under a denied path.
- `apply(spec, policy, host?)` → the `SubprocessSpawnSpec` to spawn instead.
  On a host whose launcher probes usable the argv becomes
  `[landlock-run, --ro …, --rw …, --, …argv]` (cwd, env, stdio, grace and
  signal untouched; grants on roots that do not exist are dropped because the
  launcher refuses an unopenable root). Elsewhere the spec is returned as is.
  Fail-closed: an enforcing host with no policy throws rather than running
  unconfined.
- `detectHost()` probes once per process (`landlockProbe` through
  `@samsara/kernel`); `sandboxModeOf(host)` is `'landlock' | 'none'` and is what
  a loop provider writes into `HarnessFacts.sandbox`, so the enforcement mode
  is part of `facts_sha` and a champion judged under one mode never compares
  against a challenger judged under the other.

The launcher is `@deepseek-ai/node-addon-landlock-run` (the same binary dsh's
`dsh-sandbox-local` uses), reached only through the kernel's re-exports
(`landlockLauncherPath`, `landlockProbe`, `landlockGrantArgs`).

## Why an allow-list with a denied list

Landlock rulesets are allow-lists: everything not granted is denied, and a
grant on a directory cannot have a hole carved out of it. `denied` is therefore
not passed to the launcher — it is the invariant `policyFor` checks the grants
against. Two consequences:

- The pack root is never granted; only `skill/` and `loader/` are. A pack that
  needs more at run time puts it under `runtime/` (`@samsara/workdir` lists the
  existing `runtime/*` directories as `policyPaths.runtimeDirs`).
- A fixture entry must live outside the pack's `fixtures/` (a host-side cache
  entry, or files the pack's `materialize` copied into the workdir). Granting
  `fixtures/<task>` would expose its `.meta/` too, so `policyFor` refuses it.

## Threat model

The confined process is the challenger's agent (or the proposer): model output
running with `bypassPermissions`. What the policy denies is read access to the
judge and the answers — the task sets (`tasks/`, including held-out ids), the
truth (`data/`, `fixtures/**/.meta`), the scorer (`bin/truth`, `bin/score`),
the ledger, and the operator's credentials — and write access to anything but
the attempt's own directory. The ruleset is inherited across `execve`, so
every descendant (a shell, an interpreter, a nested agent) is equally confined.

Covered on Linux with a Landlock-enabled kernel (5.13+; `partial` on older
ABIs still denies everything the ABI governs): filesystem reads, writes,
execs, renames, unlinks, and truncation under the negotiated ABI.

Not covered anywhere: network (the LLM proxy is reached by design; so is any
other host), process visibility, signals, environment, and resource limits.
Secrets stay out of the child through the explicit env (E5), not through this
policy.

## What is NOT covered on macOS

Nothing is enforced. `detectHost()` reports `unusable`, `apply` returns the
spec unchanged, and the loop records `sandbox: 'none'`. The policy is still
composed and checked, so a misconfiguration (a fixture entry inside the pack
fixtures, a home directory passed as a runtime root) fails on the developer
machine the same way it would on the pod — but the pack's `tasks/`, `data/`,
`bin/` and the operator's home are reachable by path from a macOS attempt.
E9's stance applies: on macOS treat loop and proposer output as untrusted;
the diff scan and the gate still decide. dsh's own Seatbelt backend is not
used here because its vocabulary is mode-based (see below) and cannot express
a read allow-list.

## The in-process dsh loop

`@samsara/loops-dsh` runs the agent in-process; its `bash` tool goes through
dsh's sandbox seam (`dsh-bash-sandbox` + `dsh-sandbox-local` +
`dsh-sandbox-policy`). That seam's policy is `{ mode: read-only |
workspace-write | danger-full-access, workspaceRoot }` — the Landlock profile
it builds is `--ro /` plus the workspace and `/tmp` writable. It governs
*writes* per session root and cannot take this package's read allow-list, so
the pack's `tasks/`, `data/` and `bin/` stay readable from an in-process
attempt even with those plugins composed. `loops-dsh` therefore records
`sandbox: 'none'`; the subprocess-based loop (`loops-claude-code`) and the
proposer (`claude-p`) are the ones wrapped by `apply`. Getting the in-process
loop under this policy means either a dsh seam that accepts grants per call
or running the dsh agent itself as a confined child process.

## Wiring

```ts
const wd = await materialize(...)                       // @samsara/workdir
const sandbox = policyFor({ ...wd.policyPaths, ledgerDir, homeDir: os.homedir() })
await ctx.loops.start('claude-code', { ...spec, sandbox })
await adapter.propose({ viewDir, workDir, signal, sandbox: policyFor({ workdir: workDir, packDir, runtimeDirs, readOnly: [viewDir] }) })
```

A loop or proposer receiving no `sandbox` runs unconfined on a host that
cannot enforce, and throws on one that can. `runtimeDirs` must include every
root the child executes from besides the system roots (a CLI installed under
`$HOME`, a node under `~/.nvm`, ...): the policy is deliberately unable to
guess them.

## Tests

`pnpm --filter @samsara/sandbox test` — composition (the denied set is never
reachable through a grant, in either direction), refusal of overlapping inputs,
the macOS no-op, and the Linux branch through an injected host (argv/env shape
asserted, no kernel required). Consumers' tests (`loops-claude-code`,
`proposers`) assert the wrapped spawn the same way.
