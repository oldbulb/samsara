# samsara — architecture

dsh snapshot assumed: `b150a551` (0.1.1-rc.2). Source facts are in `docs/research/dsh-host/surveys/s1_dsh_internals.md`; every claim about dsh capability below was verified there or in the critiques unless marked UNVERIFIED.

## Repository layout

```
samsara/
├── CLAUDE.md  README.md  LICENSE
├── package.json  pnpm-workspace.yaml       # cordis + dsh peers pinned to one commit; no npm publish until dsh leaves rc
├── profiles/
│   └── host/  package.json  cordis.patch.yml   # what `dsh --profile host` boots; cordis.patch.yml == champion's kept rows
├── packages/                                # the framework — TS dsh plugins, one concept each
│   ├── kernel/          dsh API shim (types + the few functions we call); re-pin here
│   ├── book/            ctx.book      tasks × time × truth; splits; settlement events; visibility
│   ├── pack/            ctx.pack      loads pack.yaml; runs pack commands as subprocesses; validates stdout
│   ├── ledger/          ctx.ledger    immutable rows, lineage, comparisons, consents; @Remote RPC; redacting reads
│   ├── scope/           ctx.scopes    open a challenger as an in-memory child scope; patch apply; harness_sha + env_sha
│   ├── champion/        ctx.champion  the served config; promote / demote; profile writer; replay check
│   ├── gate/            ctx.gate      pure statistics + verdict(tier, policy); rejects judge-kind scores by type
│   ├── signoff/         ctx.signoff   consent channel unreachable from sandboxes (unix socket / signed nonce)
│   ├── loops/           ctx.loops     seam: AttemptSpec / LoopRun / HarnessFacts + registry
│   ├── loops-dsh/  loops-claude-code/  (later: loops-codex/  loops-pi/)
│   ├── workdir/         ctx.workdir   sealed per-attempt workspace: task token, skill snapshot, TMPDIR, pre-tool guard
│   ├── submit/                        submit_<name> tool → <cwd>/<name>.json; host validates
│   ├── proposers/                     adapters that turn an external optimizer (claude -p, codex exec, gepa, human) into proposals
│   └── ui/                            /samsara SPA route + sidebar/overlay seats
├── packs/
│   ├── coding-tasks/    PUBLIC  immediate-truth pack; CI runs it; doubles as the demo
│   └── pricing/         PRIVATE git submodule (internal remote); delayed-truth pack; vendors legacy code for its commands
├── examples/            minimal host profiles wiring one pack + one loop
├── tests/               framework tests run against packs/coding-tasks and dsh-llm-replay fixtures
├── docs/design/  docs/research/
└── data/ (gitignored)   $SAMSARA_HOME default: ledger sqlite + attempt artifacts, one dir per profile
```

Why the private pack is a submodule: its content must never enter this repo's history, so a public mirror needs no rewrite. The public checkout simply lacks `packs/pricing`.

## Plugins and services

| Plugin | Provides | Injects | Notes |
|---|---|---|---|
| `kernel` | typed re-exports of `composeEntries`, `loadProfile`, `renderConfigDump`, loader/include/isolate types | — | the only file that imports dsh internals by path |
| `book` | `tasks(set)`, `splits(policy)`, `settle(truth)`, `visibility(taskId, viewer)`; emits `book/settled` | `pack`, `storageDomain` | truth latency declared by the pack; disjoint-entity holdout enforced here |
| `pack` | `load(dir) → PackDefinition`; `run(cmd, args, stdin) → stdout` via `ctx.subprocess` with own effect | `subprocess` | stdout validated against the command contract; pack never loaded in-process |
| `ledger` | rows/verbs/views; `read(view)` redacts held-out; `@Remote` RPC | `storageDomain`, `webServer` | one ledger, never mirrored; bulk artifacts as files + sha |
| `scope` | `open(challenger) → {ctx, fiber}`; `dispose`; `harnessSha()`, `envSha()` | `kernel`, `loops`, `workdir` | **must** create via `ctx.loader.create(..., null)` into the in-memory root tree (E1); `!!js` forbidden in rows (E3) |
| `champion` | `current()`, `promote(row, consentId)`, `demote()`, `replayCheck()` | `ledger`, `signoff`, `kernel` | writes `profiles/host/cordis.patch.yml`; verifies hot-apply by re-hashing `--dump-config` (E7) |
| `gate` | `compare(a, b, tier, opts)`, `verdict(compare, policy)` | — | BCa/Wilson CI, Holm across the round, futility-only early stop, MDE at α=.05/80%, n_arm floors |
| `signoff` | `request(rowId) → pending`, `confirm(proof)`; proof = nonce signed by a key in a 0600 file / unix socket | — | HTTP endpoints are not proofs (E2) |
| `loops` | `register(provider) → disposer`; `start(AttemptSpec) → LoopRun{events, result, cancel}` | — | provider set == enabled plugins |
| `loops-dsh` | in-process child agent with `meta.cwd`, restricted tools, submit tool attached | `loops`, `agents`, `tools` | |
| `loops-claude-code` | Claude SDK `query` under dsh's subprocess projection; per-attempt base_url for cost | `loops`, `subprocess` | credentials injected explicitly (E5) |
| `workdir` | `materialize({attemptId, claims, skill, mode}) → {path, dispose}`; `.task/token.json` 0400; `.agents/skills/<name>/` snapshot; per-attempt `TMPDIR` (E6); `tools/pre-execute` deny patterns | `tools` | |
| `submit` | `submit_<name>` tool; optional one-shot `steer()` on turn-stopping | `tools` | schema is a hint; the host validates with the pack's contract |
| `proposers` | `claude-p`, `codex-exec`, `human-ui`, `gepa` adapters → `Proposal` | `ledger` | external in v1; an in-host optimizer is itself a challenger surface later |
| `ui` | `/samsara` route: champion · last settlement · challengers by tier · pending sign-offs; lineage drill-down | `remote` | |

Dependency direction, made a load-time fact by `inject`: `ui → champion → ledger → {book, gate, signoff, scope} → loops → {workdir, submit, pack}`. The gate and signoff inject nothing from the loop. Nothing below `ledger` can write a verdict; nothing below `champion` can write the profile.

## Pack contract

```yaml
# packs/<name>/pack.yaml
name: coding-tasks
truth_latency: immediate | delayed
skill: { dir: skill/, name: fix-tests }          # SKILL.md body only; no harness syntax
contract: contract.schema.json                   # what submit_<name>.json must satisfy
tasks:
  sets: { smoke: tasks/smoke.jsonl, holdin: tasks/holdin.jsonl, holdout: tasks/holdout.jsonl }
  entity_key: repo | customer_id                 # holdout must be disjoint on this key
commands:
  truth: ./bin/truth          # stdin: tasks.jsonl, args: --as-of <t>  → stdout jsonl {task_id, status: settled|pending, truth, truth_sha}
  score: ./bin/score          # stdin: {truth, outputs} jsonl           → stdout jsonl {task_id, metric, value, kind: mechanical|reality|judge, stratum?}
  data:  ./bin/data           # optional; runs INSIDE the sandbox; reads .task/token.json; never takes time args
  materialize: ./bin/materialize   # optional; pre-renders per-task files into the workdir (pack mode)
guards:
  deny_patterns: ["--cutoff", "--as-of"]         # pre-tool guard in the sandbox
```

Rules: commands are subprocesses, never imported; stdout is validated against the contract above; `kind: judge` rows are stored and displayed but rejected by the gate at the type level; a pack may vendor any code it likes (legacy, internal) behind its commands.

## Ledger data model (control plane only)

```
challengers  id = sha(parent_ids, patch_sha, harness_sha, env_sha, skill_sha, taskset_sha, route)
             parent_ids[], lineage main|branch:<n>, surface, patch {cordis?, skill_ref?, before?},
             intent, prediction {metric, direction, magnitude?}, scorer_version, truth_sha,
             route {loop, model, base_url_kind, reasoning}, tasksets {smoke, holdin, holdout}, budget,
             tier_reached, status proposed|running|judged|decided,
             verdict {value invalid|drop|hold|promote|confirmed|reversed, by gate@ver, rule, consent_id?}
attempts     id, challenger_id, task_id, sample, loop, status, stop_reason, facts_sha, usage, cost, output {source, valid}, artifacts[]
compares     challenger_id, vs_id, tier, per_task Δ[], mean, ci, method, cluster_key, holm, n_eff, mde, rule_fired
consents     id, challenger_id, action promote|reject|reopen, who, channel, proof_sha, at
settlements  id, taskset_sha, as_of, truth_sha, n_settled, n_pending, triggered_rescoring[]
```

## Lifecycle

1. **propose** — a proposer submits `{parent, surface, patch, intent, prediction}`; ledger computes the id; duplicate id ⇒ new attempt set on the existing row.
2. **open** — `scope.open(row)` mounts a child scope in memory with the patch rows and an isolate label for its loop; `harness_sha`/`env_sha` recorded; profile file sha asserted unchanged.
3. **run** — for each task in the current tier: `workdir.materialize` → `loops.start` → `submit` file → pack `score` on settled truth; attempts appended; a dropped/cancelled scope kills its subprocesses via the provider's own effect.
4. **judge** — `gate.compare` against the champion on the same tasks (paired, clustered by `entity_key` and by time bucket); `verdict` per tier: smoke (validity) → holdin (futility stop only) → holdout (one pre-registered test, Holm across the round) → live (next settlement confirms or reverses).
5. **decide** — `drop` = dispose, nothing remains; `promote` requires `verdict=promote` **and** a `consents` row from `signoff`; `champion.promote` writes the profile, verifies hot-apply, fast-forwards the skill repo ref; `hold` keeps the row open until the next settlement.
6. **settle** — `book.settle` on truth arrival re-scores every `hold`/`live` row on the newly settled tasks and flips verdicts; a truth revision triggers ancestor rescoring.

## Hard constraints (from the adversarial reviews; non-negotiable)

Engineering
- **E1** challengers are never mounted through a file-backed Include tree; `ctx.loader.create(..., null)`; test: profile file sha unchanged after 100 open/dispose cycles.
- **E2** sign-off proof is unreachable from any sandbox (no HTTP-only consent; webserver has no auth, gateway is trusted-host).
- **E3** no `!!js` in challenger rows; `env_sha` recorded beside `harness_sha`.
- **E4** subprocesses in a scope go through `ctx.subprocess.spawn` wrapped in the provider's own `ctx.effect`; `ctx.jobs` is not used inside scopes.
- **E5** credential injection is explicit per loop; transcripts scrubbed before export.
- **E6** per-attempt `TMPDIR`; ledger sqlite single-writer; backups via sqlite backup API.
- **E7** promotion verifies hot-apply by re-hashing the composed config, not by trusting the file watcher.

Science
- **S1** MDE at α=.05 / power .80 from a measured noise floor (≥3 same-config reruns), never `1.28·sd/√n`.
- **S2** holdin/holdout sizes set by the pack's `entity_key` count; the framework refuses to issue `promote` when n_eff is below the policy floor and marks `hold:underpowered`.
- **S3** stratified scoring when truth is assignment-dependent (pack declares `stratum`); primary metric from the unconfounded stratum; constant/LOCF baselines are permanent rows.
- **S4** early stop is futility-only; one pre-registered holdout test; Holm across all proposals in a round; no cross-round maxima.
- **S5** proposal diffs are scanned for task ids and literals; prediction-vs-outcome is a gate input.
- **S6** settlement pins the truth snapshot (`truth_sha` + source partition); revisions re-score ancestors.

## Bring-up

| Step | Build | Observable gate |
|---|---|---|
| 0 | skeleton, contract docs, `packs/coding-tasks` skeleton | first commit |
| 1 | `pack` + `book` + `gate` as pure TS against coding-tasks fixtures, no dsh runtime | truth/score stdout validated; noise floor from 3 reruns; correct MDE; disjoint holdout enforced |
| 2 | `kernel` + `scope` + `workdir` + `submit` + `loops-dsh` on a null skill | 20/20 valid submits; dispose leaves zero processes, registry size restored, profile sha unchanged (E1); token guard denies deny_patterns |
| 3 | `ledger` + `champion` + `signoff` round trip | restart ⇒ identical ledger; promote without consent refused; consent via socket only; hot-apply verified by sha; replay check passes |
| 4 | coding-tasks end to end with `claude -p` proposer; tiers; CI green on the public pack | a real skill diff runs smoke→holdin→holdout; `|Δ|<MDE` refused; overnight K=4 run promotes nothing without sign-off |
| 5 | `packs/pricing` submodule: delayed-truth book, `data` command with token, stratified scoring | settlement event re-scores held rows; `data --cutoff` denied; gated query 403 from the sandbox; framework unchanged except through declared pack fields |
| 6 | `loops-claude-code` + `ui` | two loops as two rows; A/B refused when facts differ; UI first screen = champion · settlement · challengers · sign-offs |

Then: historical replay tier, codex/pi loops, optimizer-as-surface, training export.
