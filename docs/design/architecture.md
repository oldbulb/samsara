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
│   └── pricing/         PRIVATE, in-repo for now; delayed-truth pack; vendors legacy code for its commands
├── examples/            minimal host profiles wiring one pack + one loop
├── ops/                 pod deployment: storage layering, bootstrap, restart, archive (see docs/design/migration.md)
├── tests/               framework tests run against packs/coding-tasks and dsh-llm-replay fixtures
├── docs/design/  docs/research/
└── data/ (gitignored)   $SAMSARA_HOME default: ledger sqlite + attempt artifacts, one dir per profile
```

The private pack lives in this repo while the repo is internal. Publishing is a separate migration decided later (split into a submodule, or publish a stripped mirror); until then nothing here is public.

## Plugins and services

| Plugin | Provides | Injects | Notes |
|---|---|---|---|
| `kernel` | typed re-exports of `composeEntries`, `loadProfile`, `renderConfigDump`, loader/include/isolate types | — | the only file that imports dsh internals by path |
| `book` | `tasks(set)`, `splits(policy)`, `settle(truth)`, `visibility(taskId, viewer)`; emits `book/settled` | `pack`, `storageDomain` | truth latency declared by the pack; disjoint-entity holdout enforced here |
| `pack` | `load(dir) → PackDefinition`; `run(cmd, args, stdin) → stdout` via `ctx.subprocess` with own effect | `subprocess` | stdout validated against the command contract; pack never loaded in-process |
| `ledger` | rows/verbs/views; `read(view)` redacts held-out; `@Remote` RPC | `storageDomain`, `webServer` | one ledger, never mirrored; bulk artifacts as files + sha |
| `scope` | `open(challenger) → {ctx, fiber}`; `dispose`; `harnessSha()`, `envSha()` | `kernel`, `loops`, `workdir` | **must** create via `ctx.loader.create(..., null)` into the in-memory root tree (E1); `!!js` forbidden in rows (E3) |
| `champion` | `current()`, `promote(row, consentId)`, `demote()`, `replayCheck()` | `ledger`, `signoff`, `kernel` | writes `profiles/host/cordis.patch.yml`; verifies hot-apply by re-hashing `--dump-config` (E7) |
| `gate` | seam: `compare(a, b, tier, opts)`, `verdict(compare, policy)`; `gate-default` implements it | — | policy is a plugin; `gate_method@version` is a ledger coordinate. Default: paired per-task Δ, both held-in and held-out non-negative and one side above std/√n (Ladder), BCa CI, Holm across the round, futility-only early stop, MDE from the measured noise floor at α=.05/80%, n_eff floors; objective is solve-rate at a cost budget or Pareto; fixed-n tiers use GST, live uses mSPRT/GAVI; judge-kind scores rejected by type; holdout budget debited on promotion-relevant revelations |
| `signoff` | `request(rowId) → pending`, `confirm(proof)`; proof = nonce signed by a key in a 0600 file / unix socket | — | HTTP endpoints are not proofs (E2) |
| `loops` | `register(provider) → disposer`; `start(AttemptSpec) → LoopRun{events, result, cancel}` | — | provider set == enabled plugins |
| `loops-dsh` | in-process child agent with `meta.cwd`, restricted tools, submit tool attached | `loops`, `agents`, `tools` | |
| `loops-claude-code` | Claude SDK `query` under dsh's subprocess projection; per-attempt base_url for cost | `loops`, `subprocess` | credentials injected explicitly (E5); the LLM proxy is external (gateway), reached only via base_url |
| `workdir` | `materialize({attemptId, claims, skill, mode}) → {path, dispose}`; `.task/token.json` 0400; `.agents/skills/<name>/` snapshot; per-attempt `TMPDIR` (E6); `tools/pre-execute` deny patterns | `tools` | |
| `submit` | `submit_<name>` tool; optional one-shot `steer()` on turn-stopping | `tools` | schema is a hint; the host validates with the pack's contract |
| `proposers` | `claude-p`, `codex-exec`, `human-ui`, `gepa` adapters → `Proposal` | `ledger` | external in v1; an in-host optimizer is itself a challenger surface later |
| `ui` | `/samsara` route: champion · last settlement · challengers by tier · pending sign-offs; lineage drill-down | `remote` | |

Dependency direction, made a load-time fact by `inject`: `ui → champion → ledger → {book, gate, signoff, scope} → loops → {workdir, submit, pack}`. The gate and signoff inject nothing from the loop. Nothing below `ledger` can write a verdict; nothing below `champion` can write the profile.

## Surfaces

A surface is one mutable layer of the harness. A challenger touches exactly one (v1). Each surface declares a machine-checkable boundary — file globs, config keys, or marked regions — and the diff scan rejects out-of-boundary patches before any evaluation spend. Evidence and sources: `docs/research/vision-calibration-2026-08-23.md`.

| # | Surface | Contains | Status | Evidence / prior art |
|---|---|---|---|---|
| 1 | `skill` | Agent Skills spec subset: SKILL.md body + `scripts/ references/ assets/`; **whole directory hashed**; harness-private frontmatter (model/effort/hooks/allowed-tools) stripped and recorded under route / tool surfaces | v1 challenger | SkillsBench +16.6pp mean but 16/84 tasks negative; SkillOpt, MetaSkill-Evolve, MUSE, SkillsVote, skill-creator |
| 2 | `prompt` | system-prompt / harness-definition text segments (bootstrap, execution, verification, failure-recovery) | v1 challenger | Self-Harness: text-only edits, 9/9 held-out non-regressing; AHE: prompt alone −2.3pp — must be attributed separately from skill |
| 3 | `memory` | memory files (CLAUDE.md layers, long-term memory) | v1 challenger | AHE component ablation: memory +5.6pp, largest single item |
| 4 | `tools` | tool-interface configuration: allowlist, descriptions, edit/search/viewer parameters, lint guardrails, diff adapter — not tool implementation code | v1 challenger, **requires the cost-aware gate** | SWE-agent ablations 2–8pp per item; adapter minimal vs full 19.1 vs 73.4; tool changes often move cost ±15–25% at flat pass rate |
| 5 | `runtime` | runtime control: per-task timeout, step / message / tool-error caps, stop policy, permission mode | coordinate in v1; challenger once timeout/step are pinned coordinates and the gate is cost-aware | AHE: xhigh 53.9 vs high 63.6 via timeout coupling; HAL: 21/36 no gain from more effort |
| 6 | `route` | model id, reasoning effort, fallback / escalation, pinned model pool (`model_pool_sha`) | coordinate in v1 (model upgrade triggers re-scoring); v1.5 challenger at solve-rate@cost | Ares, CodeRescue, RouteLLM train routers offline, outside any loop; routing plateau |
| 7 | `context` | compaction thresholds / stages, observation truncation, tool-result clearing, sub-agent summary length | v1 only for keys dsh exposes; rest later | SWE-agent last-5 +3pp; HarnessBridge −47% tokens; no per-stage compaction ablation exists |
| 8 | `hooks` | middleware / hooks: pre-completion checklists, loop detection, context injection | later (code; needs marked-region boundaries; must never touch evaluation or logging) | AHE middleware +2.2pp |
| 9 | `subagent` | delegation policy, isolated context, return summaries | later (no isolated delta in evidence) | — |
| 10 | `optimizer` | proposer strategy, sample sizes, reflector model, length caps, budget, meta-skill text, recursion cadence | coordinate in v1 (`optimizer_config_sha`); later a slow-timescale challenger scored by realized child gain in a window, higher n_eff floor, multiple seeds | MetaSkill-Evolve (one level), DGM-H (high variance), Decagon (500 samples overfit) |
| — | ephemeral tools | scripts synthesized inside an attempt | **not a surface**: trajectory fact in the export; a proposer may promote one into a persistent `skill` challenger | Live-SWE-agent: no gate, not persisted |
| — | evaluation artifacts | task-set version (+changelog), scorer version, judge model version, truth snapshot, reporting / aggregation rule version | **not a surface**: immutable coordinates; a version change is a settlement event that re-scores ancestors; changed only at a settlement boundary with sign-off | BIRD 52.8% mislabelled, corrected ranks ρ=0.32; reporting rule alone moves 20.9pp |
| — | fixed points | book, gate, sign-off | never; isolated by machinery (own process, read-only mounts, `env_sha`, diff scan) | DGM App. H objective hacking |

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
  version: 3                                     # bump requires a changelog entry; bump is a settlement event
holdout:
  mde: 0.05                                      # minimum effect the pack cares about (same units as the primary metric)
  rotate_after_promotions: 1                     # promotions served by one holdout before rotation (S7)
  max_rounds: 20                                 # age cap in rounds; framework fails fast if n cannot support mde
surfaces:                                        # machine-checkable boundaries per surface this pack exposes
  skill:  { globs: ["skill/**"] }
  prompt: { globs: ["harness/prompt/*.md"] }
  tools:  { config_keys: ["tools.allowlist", "tools.*.description"] }
commands:
  truth: ./bin/truth          # stdin: tasks.jsonl, args: --as-of <t>  → stdout jsonl {task_id, status: settled|pending, truth, truth_sha}
  score: ./bin/score          # stdin: {truth, outputs} jsonl           → stdout jsonl {task_id, metric, value, kind: mechanical|reality|judge, stratum?, side_info?}
                              # every pack must emit a cost metric (kind: mechanical) per task
  data:  ./bin/data           # optional; runs INSIDE the sandbox; reads .task/token.json; never takes time args
  materialize: ./bin/materialize   # optional; pre-renders per-task files into the workdir (pack mode)
guards:
  deny_patterns: ["--cutoff", "--as-of"]         # pre-tool guard in the sandbox
```

Rules: commands are subprocesses, never imported; stdout is validated against the contract above; `kind: judge` rows are stored, displayed, may carry structured `side_info` back to the proposer, and may steer smoke/holdin, but are rejected by the gate at the type level for any verdict; a scorer version bump happens only at a settlement boundary with sign-off and re-scores ancestors; a pack may vendor any code it likes (legacy, internal) behind its commands.

## Ledger data model (control plane only)

```
challengers  id = sha(parent_ids, patch_sha, harness_sha, env_sha, skill_sha, taskset_sha, route, optimizer_config_sha)
             parent_ids[], lineage main|branch:<n>, surface (exactly one), patch {cordis?, skill_ref?, before?},
             intent, prediction {metric, direction, magnitude?, predicted_fixes[]?, at_risk[]?},   # falsifiable contract
             scorer_version, task_version, truth_snapshot_id, report_rule_version, judge_model_version?,
             route {loop, loop_adapter_version, model_id, effort, model_pool_sha, base_url_kind},
             runtime {timeout_s, step_cap}, optimizer_config_sha, tasksets {smoke, holdin, holdout}, budget,
             tier_reached, status proposed|running|judged|decided,
             verdict {value invalid|drop|hold|promote|confirmed|reversed, by gate_method@ver, rule, consent_id?}
attempts     id, challenger_id, task_id, sample, loop, status COMPLETED|TRUNCATED|ABORTED|FAILED, stop_reason,
             facts_sha, usage, cost {tokens, wall_s, usd}, output {source, valid}, artifacts[], ephemeral_tools[]?,
             skill_utilization? (per-harness: was the skill read / invoked)
scores       attempt_id, scorer_version, truth_snapshot_id, metric, value, kind, stratum?   # append-only; re-scores add rows
compares     challenger_id, vs_id, tier, per_task Δ[], mean, ci, method, cluster_key, holm, n_eff, mde, cost_budget, rule_fired,
             holdout_budget_remaining, predicted_vs_observed {fixes_hit, at_risk_hit}
consents     id, challenger_id, action promote|reject|reopen|scorer_bump, who, channel, proof_sha, at
settlements  id, kind truth|scorer|model|taskset, taskset_sha, as_of, truth_snapshot_id, n_settled, n_pending, triggered_rescoring[]
```

Every surface object (skill dir, prompt segment, memory file, tool config, runtime config, route, optimizer config, task set, scorer) is content-addressed (`name:sha`); the champion is an alias to a set of such refs. Error-terminated attempts (`ABORTED|FAILED`) are kept but excluded from gate statistics.

## Lifecycle

1. **propose** — a proposer submits `{parent, surface, patch, intent, prediction}`; ledger computes the id; duplicate id ⇒ new attempt set on the existing row.
2. **open** — `scope.open(row)` mounts a child scope in memory with the patch rows and an isolate label for its loop; `harness_sha`/`env_sha` recorded; profile file sha asserted unchanged.
3. **run** — for each task in the current tier: `workdir.materialize` → `loops.start` → `submit` file → pack `score` on settled truth; attempts appended; a dropped/cancelled scope kills its subprocesses via the provider's own effect.
4. **judge** — `gate.compare` against the champion on the same tasks (paired, clustered by `entity_key` and by time bucket); `verdict` per tier: smoke (validity) → holdin (futility stop only) → holdout (one pre-registered test, Holm across the round) → live (next settlement confirms or reverses).
5. **decide** — `drop` = dispose, nothing remains; `promote` requires `verdict=promote` **and** a `consents` row from `signoff`; `champion.promote` writes the profile, verifies hot-apply, fast-forwards the skill repo ref; `hold` keeps the row open until the next settlement.
6. **settle** — a settlement is any of: truth arriving or being revised, a scorer version bump (with sign-off), a model upgrade in the pinned pool, a task-set version bump. `book.settle` re-scores every `hold`/`live` row on the affected tasks, appends new `scores` rows (never overwrites), walks the ancestry of the champion, flips verdicts, and may demote the champion. Promotion-relevant holdout revelations debit `holdout_budget_remaining`; at zero the book rotates the holdout from newly settled, entity-disjoint tasks.

## Hard constraints (from the adversarial reviews; non-negotiable)

Engineering
- **E1** challengers are never mounted through a file-backed Include tree; `ctx.loader.create(..., null)`; test: profile file sha unchanged after 100 open/dispose cycles.
- **E2** sign-off proof is unreachable from any sandbox (no HTTP-only consent; webserver has no auth, gateway is trusted-host).
- **E3** no `!!js` in challenger rows; `env_sha` recorded beside `harness_sha`.
- **E4** subprocesses in a scope go through `ctx.subprocess.spawn` wrapped in the provider's own `ctx.effect`; `ctx.jobs` is not used inside scopes.
- **E5** credential injection is explicit per loop; transcripts scrubbed before export.
- **E6** per-attempt `TMPDIR`; ledger sqlite single-writer; backups via sqlite backup API.
- **E7** promotion verifies hot-apply by re-hashing the composed config, not by trusting the file watcher.
- **E8** the judge is isolated by machinery: `truth`/`score` run in their own process with read-only mounts and a recorded `env_sha`; every surface has a machine-checkable boundary; the diff scan rejects, before any evaluation spend, a patch that touches the evaluation, logging, or marker pipeline or crosses its surface boundary (DGM App. H).

Science
- **S1** MDE at α=.05 / power .80 from a measured noise floor (≥3 same-config reruns), never `1.28·sd/√n`.
- **S2** holdin/holdout sizes set by the pack's `entity_key` count; the framework refuses to issue `promote` when n_eff is below the policy floor and marks `hold:underpowered`.
- **S3** stratified scoring when truth is assignment-dependent (pack declares `stratum`); primary metric from the unconfounded stratum; constant/LOCF baselines are permanent rows.
- **S4** early stop is futility-only; one pre-registered holdout test; Holm across all proposals in a round; no cross-round maxima.
- **S5** proposal diffs are scanned for task ids and literals; prediction-vs-outcome is a gate input.
- **S6** settlement pins the truth snapshot (`truth_sha` + source partition); revisions re-score ancestors, append-only.
- **S7** holdout accounting (calibrated in `docs/design/notes/holdout-feasibility.md`): the holdout exposes to the proposer only a parameter-free Ladder signal ("beat best-so-far by > std/√n: yes/no" plus the rounded best-so-far); raw per-sibling holdout means live in judge-isolated storage and never reach the proposer. The accounting unit is the **promotion**, not the query: `pack.yaml` declares `holdout.mde`, `holdout.rotate_after_promotions` (default 1) and `holdout.max_rounds` (default 20); the book rotates to entity-disjoint, newly settled tasks never seen by any ancestor of the champion when either limit is hit. Startup fail-fast: `n ≥ ((z_α+z_β)·sd_floor/mde)²` with the measured noise floor, and a rotation pool ≥ n; otherwise the tier is `hold:underpowered` (S2) and does not run. Thresholdout is **not** the default — at tens to hundreds of tasks its bound fails by orders of magnitude and in simulation it inflates false-keep while burning its budget on noise within 3–11 rounds; it remains a documented gate plugin with its scale preconditions.
- **S8** the gate's objective includes cost: verdicts are on solve-rate at a declared cost budget or on a Pareto front; every pack emits a per-task cost metric; a challenger that is not distinguishable from the champion on both quality and cost is `drop`, not `hold`.

S1–S4, S7, S8 are the behaviour of `gate-default`; a user-supplied gate policy may replace them, and the ledger records which policy produced each verdict. E1–E8, S5, S6 are framework invariants no policy can disable.

## Bring-up

| Step | Build | Observable gate |
|---|---|---|
| 0 | skeleton, contract docs, workspace + host profile wired to gateway; **holdout feasibility calculation** (Thresholdout / Ladder at the two packs' real `n`); **inventory of the config keys dsh exposes** (compaction, hooks, sub-agent, runtime control) = the v1 surface denominator; a per-round cost model (repeats × tasks × K) | `dsh --profile host --dump-config` shows the gateway route; one headless completion succeeds; feasibility numbers written into S7 |
| 1 | `pack` + `book` + `gate-default` as pure TS against coding-tasks fixtures (Aider Polyglot, Python + JS), no dsh runtime; cost metric in the score contract | truth/score stdout validated; noise floor from 3 reruns; correct MDE; disjoint holdout enforced; `gate_sim` ported: null siblings false-keep < α·K, a pure-noise task set promotes nothing, a "bigger-budget optimizer" arm does not get promoted, a known-good patch is promoted |
| 2 | `kernel` + `scope` + `workdir` + `submit` + `loops-dsh` on a null skill; surface boundaries and diff scan (E8); single-surface constraint | 20/20 valid submits; dispose leaves zero processes, registry size restored, profile sha unchanged (E1); token guard denies deny_patterns; a patch touching `bin/truth` or crossing its surface glob is rejected before any run |
| 3 | `ledger` + `champion` + `signoff` round trip; append-only re-scoring; champion as content-addressed alias; model-upgrade settlement event | restart ⇒ identical ledger; promote without consent refused; consent via socket only; hot-apply verified by sha; replay check passes; a model-pool change re-scores the ancestry |
| 4 | coding-tasks end to end with `claude -p` proposer; tiers; holdout budget live; CI green on the public pack | a real skill diff runs smoke→holdin→holdout; `|Δ|<MDE` refused; overnight K=4 run promotes nothing without sign-off; budget exhaustion rotates the holdout; a truth revision re-scores and demotes |
| 5 | `packs/pricing`: delayed-truth book, `data` command with token, stratified scoring | settlement event re-scores held rows; `data --cutoff` denied; gated query 403 from the sandbox; framework unchanged except through declared pack fields |
| 6 | `loops-claude-code` + `ui`; cross-harness certification output | two loops as two rows; A/B refused when facts differ; `skill_utilization` and pass rate reported separately per harness; adapter version on the row; UI first screen = champion · settlement · challengers · sign-offs |

Then: historical replay tier, codex/pi loops, optimizer-as-surface, training export.
