# @oldbulb/samsara-environments

`ctx.environments` — the registry of environment providers, and the contract
every provider speaks: where one attempt runs (a directory on this host, a
container, a remote sandbox), what it may see, and what actually ran
(`docs/design/notes/environments-harbor-modal-2026-08-26.md`).

## The seam (`types.ts`)

```ts
interface EnvironmentProvider { name: string; version: string; open(spec: EnvironmentSpec): Promise<Environment> }
interface EnvironmentSpec {
  attemptId: string
  image?: { ref?: string; dockerfileDir?: string }          // absent → the provider's default (local: none)
  resources: { cpus?: number; memoryMb?: number; timeoutS: number }
  network: 'none' | 'allowlist' | 'public'; allowedHosts?: string[]
  env: Record<string, string>                                // E5: explicit, never the host's
  mounts: { from: string; to: string; readOnly: boolean }[]  // the skill snapshot, the pack's runtime dirs
  workdir?: string
}
interface Environment {
  id: string; provider: string; workdir: string
  exec(argv, { cwd?, env?, stdin?, timeoutMs, user?, signal? }): Promise<{ code: number | null; signal?: string; stdout: string; stderr: string }>
  put(localPath, remotePath): Promise<void>
  get(remotePath, localPath): Promise<void>
  snapshot?(): Promise<{ ref: string; digest: string }>
  facts(): EnvironmentFacts                                  // provider@version, image digest, resources, network — what actually ran
  dispose(): Promise<void>                                   // E4: the scope's effect calls this; kills everything inside
}
```

`environmentSha(facts)` is the coordinate an environment contributes (rule 0):
sha256 over `{ image: digest ?? ref ?? null, resources, network, allowedHosts }`
in canonical JSON. The provider is not part of it — the same image on two
providers is one design, two images are two.

The registry (`index.ts`, row `environments`) is a cordis service like
`ctx.loops`: `register(provider)` returns the disposer (a duplicate name throws
`EnvironmentsError` `DUPLICATE_PROVIDER`), `get(name)`, `list()`,
`open(name, spec)` (`UNKNOWN_PROVIDER` when nobody registered `name`). A
provider plugin registers inside its own effect, so the host's provider set
equals its enabled rows. The environment `open` returns is the caller's to
dispose.

## The local provider (`local.ts`, row `environments-local`)

Today's behaviour behind the seam: a directory (`spec.workdir`, else
`<baseDir>/<attemptId>` under `config.baseDir`, default
`<os tmpdir>/samsara-environments`), children spawned through the kernel's
subprocess seam inside the plugin's effect and wrapped with the sandbox policy
where the host enforces one (`@oldbulb/samsara-sandbox`: the system roots and
the read-only mount sources read-only, the workdir writable). `exec` runs with
cwd = the workdir (a relative `cwd` is under it), stdin from `opts.stdin`, and
an explicit environment — `PATH`/`LANG`/`LC_ALL` from the host, `spec.env`,
`HOME`/`TMPDIR` = the workdir, `opts.env` — never the parent's (E5). The
timeout and the abort signal terminate the child (SIGTERM → `graceMs` →
SIGKILL); the result then has `code: null` and the signal. `put`/`get` copy
files or trees (remote paths relative to the workdir). `dispose` terminates
every live child, waits for it, and removes the directory.

Mounts: a read-only mount is a symlink to its source, read-only by the sandbox
policy only (a host that cannot enforce records that in the environment's
`notes`); a source mounted at its own path (the pack dir, so `in_environment`
commands run from it as on the host) is left where it is and granted the same
way; a writable mount is a copy, so writes never reach the source. Not
enforced locally, and recorded in `notes`: the network policy (`facts()`
reports `public`, what actually ran), `cpus`/`memoryMb`, and `user`. The local
provider runs no image: a spec's `image` (a pack's `environment` block under
`--env local`) is noted and ignored, and `facts()` carry none — so the
coordinate of a local run never equals a container's (rule 0).

## The docker provider (`docker.ts`, row `environments-docker`, off by default)

A container per environment through the docker CLI (`config.docker`, a bare
name on PATH or an absolute path; the daemon must be reachable from the host):

| step | docker |
|---|---|
| image | `build -q <dockerfileDir>` or `pull -q <ref>`; the digest is `image inspect --format {{.Id}}` |
| open | `run -d --label samsara.attempt=<id> [--cpus n] [--memory <mb>m] --network none\|bridge [--env-file f] [-v from:to:ro\|rw …] -w <workdir> <image> sleep infinity` |
| exec | `exec -i [-w cwd] [-u user] [--env-file f] <id> <argv…>`, stdin from `opts.stdin`; the timeout and the abort signal terminate the client (`code: null` + signal) |
| put / get | `cp <local> <id>:<remote>` / `cp <id>:<remote> <local>`; a relative remote path is under the workdir |
| snapshot | `commit <id>` → the new image id, then `image inspect` for its digest |
| dispose | `rm -f <id>`, then the env files are removed |

The environment's `env` and an exec's extras reach the container only through
`--env-file` files (mode 0600, under `config.baseDir`), never on the argv (E5).
`network: 'public'` is the bridge; `'none'` and `'allowlist'` both run with no
network — the allowlist is not something the CLI can express, so the
environment's `notes` and `facts().network` say `none`. The default workdir is
`/workspace/<attemptId>` — the pack contract names the workdir after the
attempt, as the local provider does under its `baseDir`; `spec.workdir` sets
another. `resources.timeoutS` is the caller's deadline, not a container
setting; an exec that hits its `timeoutMs` loses its client while the process
inside lives on until dispose. The docker client itself sees `PATH`, `HOME` and
the `DOCKER_*` variables, so it finds its config and its daemon.

Tests run the provider against a fake `docker` script that records every argv
and answers canned output; a describe against a real daemon skips with a
reason when `docker info` fails, as does the synthetic pack's container run
(`pnpm vitest run tests/synthetic.e2e.test.ts -t docker`, the CI step
`synthetic pack in docker`).

## Running attempts in docker (`--env docker`)

The bundle mounts the registry (`environments`) and the local provider
(`environments-local`) on; `environments-docker` is there but `disabled`.
Where a daemon is reachable, enable it in the profile patch — `docker` names
the binary, `baseDir` where the env files go:

```yaml
- id: environments-docker
  disabled: false
  config: { docker: docker }
```

Then `--env docker` on `run`, `challenge`, `round`, `certify`, `calibrate`,
`campaign` and `control` (`@oldbulb/samsara-runner`). Per attempt the runner
opens one environment from the pack's `environment` block (a task row's
column overrides it: image ref or dockerfile dir, resources, network — `none`
unless the pack says), with the pack directory mounted read-only at its own
absolute path when any command is `in_environment`; puts the sealed workdir
into `/workspace/<attemptId>`; runs those commands through `exec` from the
pack dir with the same jsonl on stdin and stdout; hands the submit file back
with `get`; puts `facts()` on the attempt row and into `facts_sha`; and
disposes the environment with the attempt and with the challenger's scope
(E4). Champion and challenger rows carry `environment_sha` (rule 0). The
loops shipped today are host-side (`@oldbulb/samsara-loops` README) and need
`local`; a container provider is for the pack's commands until an installed
loop lands. The synthetic pack is the worked example (`packs/synthetic/README.md`,
"In a container").
