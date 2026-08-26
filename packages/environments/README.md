# @oldbulb/samsara-environments

`ctx.environments` — the registry of environment providers, and the contract
every provider speaks: where one attempt runs (a directory on this host, a
container, a remote sandbox), what it may see, and what actually ran
(`docs/design/architecture.md` § Plugins, the `environments` row, and § Coordinates for `environment_sha`).

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
reason when `docker info` fails, as does the container run of the pack
end-to-end under `tests/` (`-t docker`, the CI step that runs a pack in
docker).

## The modal provider (`modal.ts`, row `environments-modal`, off by default)

A [Modal](https://modal.com) sandbox per environment through the `modal` SDK
(pinned to `0.9.0`, the version `facts().version` reports; the V2
`experimentalCreate` API is not used). The plugin builds the client from
credentials named by environment variable — `config.tokenIdEnv` /
`config.tokenSecretEnv` hold variable *names* (E5), never values — and with
none configured the SDK resolves them itself: `MODAL_TOKEN_ID` /
`MODAL_TOKEN_SECRET`, else the active profile of `~/.modal.toml`
(`MODAL_CONFIG_PATH` moves it, `MODAL_PROFILE` picks one). Sandboxes live in
the Modal App `config.app` (default `samsara`, created when missing):

| step | modal |
|---|---|
| image | `images.fromRegistry(ref)`, built by the first `sandboxes.create` and reused by every environment of the provider |
| open | `sandboxes.create(app, image, { timeoutMs: (2*timeoutS + 600)*1000, workdir, cpu, cpuLimit, memoryMiB, memoryLimitMiB, secrets: [fromObject(env)], blockNetwork \| outboundDomainAllowlist })`, then the workdir is made and the mounts copied in |
| exec | `sandbox.exec(argv, { workdir, timeoutMs, env })`, stdin written and closed; the deadline and the abort signal end the call (`code: null` + `SIGKILL`) |
| put / get | `filesystem.copyFromLocal` / `copyToLocal` per file (directories walked with `makeDirectory` / `listFiles`; `get` makes a symlink again from its `symlinkTarget`); a relative remote path is under the workdir |
| snapshot | `snapshotFilesystem()` → the new image id as `ref` and `digest` |
| dispose | `terminate({ wait: true })` |

The environment's `env` reaches the sandbox as an in-memory `Secret` the SDK
turns into an ephemeral server-side secret; an exec's extras go in the exec
request body. Neither is ever on a command line. `network: 'none'` is the
SDK's `blockNetwork`; `'allowlist'` becomes `outboundDomainAllowlist` (the
spec's `allowedHosts`, wildcard prefixes allowed — empty means nothing
outbound), so `facts().network` and `allowedHosts` are what the spec asked
for; `'public'` opens the sandbox. `cpus` is set as the SDK's `cpu`
reservation and its `cpuLimit` both, `memoryMb` as `memoryMiB` and
`memoryLimitMiB`: the declared numbers bound the sandbox as docker's
`--cpus`/`--memory` bound a container, so one `environment_sha` is one design
on either provider (rule 0). `timeoutS` is the callers' deadline, as it is for
docker (the loop's limit, the bound of an `in_environment` command), not the
sandbox's lifetime: the lifetime is a backstop for a host that never disposes
(E4 is the kill), set to twice `timeoutS` plus ten minutes so the deadlines
inside end an attempt before Modal does — the loop and a command can each run
to `timeoutS`, and open (first contact included), the copies and what follows
take the headroom. The lifetime is in the environment's `notes`; `facts()`
carry the spec's `timeoutS`. The default workdir is `/workspace/<attemptId>`,
as for docker.

The SDK takes an exec's timeout in whole seconds and the worker ends the
process at it, within the second of the caller's deadline; the call then
answers with what the process wrote before the kill (the streams the worker
closed are drained, within a grace, so output still in flight at the deadline
is not dropped). An abort ends the call only — the SDK has no kill for an exec — so the process
inside runs until the sandbox's lifetime or dispose; the environment's
`notes` say so. `put` restores the executable bit with `chmod` (the
filesystem API carries no modes) and follows symlinks (the API cannot make one
in the sandbox); `get` carries a symlink back as a link with the target it has
inside, as docker's `cp` and the local provider do, so a tree fetched back is
whole. A mount is a copy made before `open` returns, and read-only is not
enforced (the sandbox runs as root) — `notes` again. `user` is not honoured. `snapshot` gives a Modal image
id (kept 30 days by default), which a later spec can name as `image.ref`
only through a registry: the provider builds from registries, not from ids.

**Image identity (rule 0).** `facts().image.digest` is the registry digest
when the ref pins one (`repo@sha256:…`) — the identity the docker provider
reports for the same image, so an attempt on Modal and one in local docker
share `environment_sha` and are one design. An unpinned tag gets the Modal
image id instead: stable per workspace and image-builder version, but no
registry identity, so such attempts never pool with docker's. Pin by digest
when arms run on different providers. `image.dockerfileDir` is refused: the
SDK builds from Dockerfile *commands* without a build context (it rejects
`COPY` from local files), which cannot reproduce a directory build — publish
the image and name it with `image.ref`.

`usage()` on a `ModalEnvironment` (not part of the seam) is the wall seconds
since the sandbox was created — what Modal bills, with the resources. The
SDK does not report a charge, so `cost.compute_usd` (S8) needs the account's
price list on top.

**First contact.** A fresh sandbox's command router can stay unreachable
for longer than the SDK's own retry budget (about ten seconds; a proxy in
front of the host stretches the first connection), and the SDK then reports
the sandbox as unavailable — "The Sandbox is unavailable" — while it is
running. The provider retries the first call into it (the workdir's
`makeDirectory`) for up to a minute while `poll` says the sandbox still
runs, noting in the environment's `notes` how many tries it took; a sandbox
that has exited fails at once.

Tests run the provider against a fake client that records every call and
answers canned `ContainerProcess`-like objects. A describe against Modal
itself (it opens `alpine:3.20` in the App `samsara-test` and takes about a
minute) is opt-in, as is the pack end-to-end's modal run under `tests/`
(`-t modal`): it runs only with `SAMSARA_TEST_MODAL=1` *and* credentials the
SDK will resolve (`MODAL_TOKEN_ID`, else `MODAL_CONFIG_PATH` or
`~/.modal.toml`), and skips with a reason otherwise — a config file on the
machine does not by itself put a plain `pnpm test` on the network or spend
sandbox time.

To run attempts on Modal, enable the row in the profile patch and pass
`--env modal`; the pack's `environment` block must name an image by `ref`:

```yaml
- id: environments-modal
  disabled: false
  config: { app: samsara, tokenIdEnv: MODAL_TOKEN_ID, tokenSecretEnv: MODAL_TOKEN_SECRET }
```

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
loop lands. The worked example is the pack under `packs/` whose `truth` is
`in_environment` (its README, "In a container" and "Running on Modal").
