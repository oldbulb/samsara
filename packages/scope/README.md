# @samsara/scope

`ctx.scopes`: open a challenger — the champion plus one patch on one surface — as a disposable child scope, and close it leaving nothing behind. Binding design: `docs/design/architecture.md` (Plugins table row `scope`, "Surfaces", E1/E3/E8, S5).

## Layout

| module | export | what |
|---|---|---|
| `@samsara/scope` | `ScopeManager` (default export, cordis Service on `ctx.scopes`), `ScopeError`, types | the seam |
| `@samsara/scope/diffscan` | `scan(patch, boundaries, taskIds, forbiddenPaths?, literals?)` | pure boundary / judge-pipeline / task-literal / `!!`js scan |
| `@samsara/scope/sha` | `harnessSha(entries)`, `harnessShaOfLayers(layers)`, `envSha(env?)`, `envFacts`, `canonicalJson` | pure coordinates recorded beside every challenger |
| `@samsara/scope/envlock` | `envLock({ repoRoot, packDir, loops, imageDigest? })`, `findRepoRoot`, `packRuntimeLocks`, `venvListing` | environment fingerprint from lock files (E3; adoptions item 3) |

## Patch shapes

```ts
{ surface: 'skill', skill_dir: string, mount?: string }              // whole-directory snapshot; sha = hashDir(skill_dir)
{ surface: 'prompt'|'memory'|'tools'|'runtime'|'route'|'context',
  rows: PatchOptions[] }                                              // { id, config } or { insert: EntryOptions[] }
```

`mount` is the pack-relative path the snapshot lands at; surface globs are matched against `<mount>/<file>`.

## Diff scan (E8 / S5)

`scan` returns `{ ok, violations[] }` and is run by `open()` before anything is created; a rejection is `ScopeError('PATCH_REJECTED')` carrying the violations.

| code | when |
|---|---|
| `SURFACE_UNDECLARED` | the pack declares no boundary for the patch's surface |
| `FILE_OUT_OF_BOUNDARY` | a snapshot file does not match any surface glob |
| `FORBIDDEN_PATH` | a snapshot file matches `bin/**`, `tasks/**`, `fixtures/**`, `contract.schema.json`, `pack.yaml` (overridable) |
| `CONFIG_KEY_UNDECLARED` | a config leaf is not covered by `config_keys`; an inserted row's id is not declared as a whole row |
| `ROW_FORBIDDEN` | a row id / inserted plugin name matches `*truth*`, `*score*`, `ledger`, `gate*`, `signoff`, `book`, `storage*` |
| `ROW_KEY_NOT_ALLOWED` | a champion row carries anything but `id` + `config` (no `disabled`, `name`, `inject`, `isolate`); an insert entry carries more than `id name config inject group` |
| `ROW_UNTARGETED` | a row has neither `id` nor `insert`; an inserted entry has no id |
| `TASK_LITERAL` | a task id (or an extra literal such as a task file name) appears in snapshot text or in the rows |
| `JS_EXPR` | the YAML js tag or a `__jsExpr` node appears anywhere (E3) |
| `SKILL_DIR_MISSING` | `skill_dir` cannot be read |

`config_keys` are dotted: `<rowId>` admits the whole row (required for inserts), `<rowId>.a.b` admits `a.b` and everything beneath it. A surface with no `globs` admits no file; with no `config_keys` admits no key.

## Opening a scope (E1)

```ts
const scope = await ctx.scopes.open({ id, patch, boundaries: pack.surfaces, taskIds, literals?, isolate? })
// { scopeId, challengerId, ctx, fiber, skillDir, skillSha, harnessSha, envSha, entryIds, unappliedRows, dispose() }
```

With a loader on the context (`ctx.loader`, what `dsh` boots), config rows are created in the **in-memory** tree: one `cordis:group` entry `samsara-scope-<scopeId>` via `loader.create(options, null)` into the root group, holding

- for `{ id, config }`: a copy of the champion's entry with that id (`name`, `inject` kept) whose config is the champion's deep-merged with the patch — only declared keys can differ — under the entry id `samsara-scope-<scopeId>.<id>` so it never collides with the champion's entry in the shared store;
- for `{ insert }`: the entries as given.

`isolate` labels from the challenger go on the group so the scope's rows can provide services in a private realm. Nothing touches the file-backed include: `profiles/host/cordis.patch.yml` has the same sha after any number of open/dispose cycles (tested over 100). `dispose()` is idempotent, removes the group through `EntryTree.remove` (which stops its rows and waits for quiescence) and drops the scope from the registry; unmounting the service disposes every scope still open.

`harnessSha` is the sha256 of the canonical JSON of every loader entry that is not a samsara scope, taken at open time; `envSha` covers `{ node, platform, arch, DSH_PIN, sorted env var names among PATH TMPDIR LANG DSH_* }` — names only, never values.

## Environment lock (`envLock`)

`envLock({ repoRoot, packDir, loops, imageDigest? })` returns `{ inputs, sha }` where `sha = sha256(canonicalJson(inputs))` and `inputs` is:

| field | source |
|---|---|
| `pnpmLock` | sha256 of `<repoRoot>/pnpm-lock.yaml` (`null` when absent; `findRepoRoot(dir)` walks up to it) |
| `packRuntimeLocks` | `<packDir>/runtime/**` → sha256 of every `requirements*.txt`, `uv.lock`, `package-lock.json`, `pnpm-lock.yaml`, `.python-version` (`node_modules` skipped), plus, for every directory holding `pyvenv.cfg`, the sha256 of its sorted `name==version` listing from `lib/python*/site-packages/*.dist-info/METADATA`; keys are pack-relative posix paths |
| `node`, `dshPin` | `process.version`, `DSH_PIN` |
| `claudeVersion` | first line of `claude --version`, read once per process, only when `loops` includes `claude-code` and the binary is on PATH |
| `imageDigest` | the option, else `$SAMSARA_IMAGE_DIGEST`, omitted when empty |
| `envNames` | the allowlisted env var names (`envFacts`) — never values |

The runner calls it once per run (`envLockOf(def, loop)`), writes `<runDir>/env-lock.json` with `{ inputs, sha }`, and folds `sha` with the route and limits into the challenger row's `env_sha`. `envSha()` remains as the legacy names-only coordinate on `Scope.envSha`.

**Fallback without a loader** (a bare `Context` in tests): importing plugins by name is the loader's job, so rows cannot be applied. `open()` still mounts a bare child fiber (a disposable `ctx`), reports the rows in `unappliedRows`, and `entryIds` is empty; `harnessSha` is then the hash of an empty list. Do not run a real challenger in this mode.

## Run

```
pnpm --filter @samsara/scope build     # tsc -b
pnpm --filter @samsara/scope test      # vitest, no network / model
```
