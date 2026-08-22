# samsara — philosophy and boundaries

## Vision

**samsara is the self-improvement substrate for agent harnesses: it lets a running harness keep iterating on itself under evidence that comes from reality, is not contaminated by the optimizer, and can be retroactively overturned.**

The three qualifiers are the three promises:

- **from reality** — truth lives outside the loop; it arrives immediately or late; settlement is an event;
- **not contaminated by the optimizer** — the holdout is a consumable, the judge is machine-isolated, judge-kind scores never reach a verdict;
- **retroactively overturnable** — every adoption carries full coordinates; when the world changes, ancestors are re-scored; the champion is alive.

The name: each candidate is one life; reality judges it; what is kept is reborn into the next generation. The cycle, not any single state, is the system.

## What is improved: the harness, not the weights

A harness is everything mutable around the model. Each mutable layer is a **surface**; a challenger is the champion plus one patch on one surface. The full taxonomy, with evidence and v1 status, is in `architecture.md` ("Surfaces"). In short:

- **v1 challengers**: skill, system-prompt / harness-definition segments, memory files, tool-interface configuration.
- **coordinates first, challengers once the gate is cost-aware**: runtime control (timeouts, step caps, permission mode), route (model, effort, model pool).
- **recorded now, optimized later on a slow timescale**: optimizer configuration — the true entry point of recursion.
- **never surfaces**: evaluation artifacts (task sets, scorers, judges, truth snapshots, reporting rules — versioned coordinates and re-scoring triggers), and the three fixed points.

Skill-level RSI is the starting layer and the one most portable across harnesses. The vision is that **every mutable layer of a harness is a challenger in the same loop, on the same ledger, through the same gate.** In v1 a challenger touches exactly one surface; without that, improvement cannot be attributed.

## How: one loop, three fixed points

propose → run → judge → keep-or-drop → settle.

Outside the loop, unwritable from inside it: the **book** (tasks and truth), the **gate** (verdicts), **sign-off** (a human). Everything else — the optimizer included — can be improved.

**Mechanism is fixed; policy is pluggable.** Invariants the framework enforces: a challenger runs in a disposable scope and leaves nothing when dropped; every score-moving quantity is a ledger coordinate; the judge is isolated by machinery, not convention; the gate's objective includes cost; sign-off cannot be forged from a sandbox. Plugins the user may replace: the statistical method, the optimization algorithm, the evaluation logic, the form of the sign-off channel. Defaults are strict, and the ledger records which policy produced each verdict.

## Where we intend to lead

Three things nobody has implemented, with the prior art named honestly:

1. **Holdout accounting.** Automated, recursive reuse of a holdout across generations learns it away. samsara budgets holdout revelations (Thresholdout / Ladder, Dwork et al. 2015, Blum & Hardt 2015 — theory exists; no agent-optimization system applies it), declares `n / mde / budget` per pack, fails fast when the holdout cannot support the round, and rotates from newly settled tasks when the budget is spent.
2. **An automated loop on delayed truth.** Every RSI and skill-optimization system evaluates on immediate benchmarks. Tasks whose truth arrives next month can still run the loop here — the step from RSI-on-benchmarks to RSI-in-production.
3. **A living champion.** A truth revision, a scorer version bump, a model upgrade, or a task-set change is an event that re-scores the ancestry (append-only) and can demote the champion. Existing tools (Inspect `score --action append`, LangSmith `evaluate(existing)`, Braintrust rewind) offer manual, per-run back-fill; the trigger is new.

Three things where prior art exists and samsara closes the loop: **surface attribution fed back to the proposer** (SkillsVote, AHE's falsifiable per-edit contracts attribute; nobody aggregates across surfaces or feeds the optimizer); **revocable cross-harness skill certification under a fixed gate** (SkillOpt and SkillsBench measure transfer; the gate, the adapter version as a coordinate, and revocability are new); **trajectories labelled with adoption and post-settlement confirmation** as a training export (SWE-Gym / SWE-smith export verified trajectories; the adoption and settlement labels are new — and whether they improve training is an untested hypothesis).

Things that are commoditized and only *unused* for automated promotion: sequential statistical gates (Statsig, Eppo). samsara does not claim them.

## Principles

1. **Disposable.** A candidate is a child scope of the host. Running it has no effect on the host; disposing it frees everything it allocated (processes, temp dirs, storage handles, registrations). Keeping it means merging its patch into the champion, nothing more. The framework must never mount a candidate through any path that persists it (hard constraint E1).
2. **One champion, many challengers.** Exactly one configuration is served. Challengers compete on the same tasks. Promotion happens only through the gate; the proposer is never the acceptor.
3. **Reality settles.** Truth comes from outside the loop — immediately (a test suite) or later (next month's outcome). Truth latency is a first-class property of a book; settlement is an event. Model-judged scores may be recorded, may steer smoke and holdin, but never decide promotion.
4. **The judge is out of reach by machinery, not by agreement.** The book and scorer run in their own process with read-only mounts and an `env_sha`; every surface declares a machine-checkable boundary (file globs, config keys, marked regions); the diff scan rejects, before any evaluation spend, a patch that touches the evaluation, logging, or marker pipeline. (DGM, Appendix H: an agent deleted the hidden hallucination markers and scored perfectly.)
5. **The gate's objective includes cost.** Verdicts are on solve-rate at a cost budget or on a Pareto front; tokens, wall time, and money are ledger columns. Without this, tool, route, and context surfaces are invisible and null patches get promoted on token noise.
6. **Typed action space.** A proposal is a patch on one declared surface. Arbitrary code edits are not a surface. Each surface carries its own gate policy.
7. **Replayable coordinates.** Every quantity that can move a score is a column of the ledger row. Two rows equal on all of them define the noise floor. Re-scores append; they never overwrite.
8. **Exposure asymmetry, with a budget.** A proposer sees held-in tasks individually, held-out tasks only as aggregates, never a path to truth or scores — enforced by what the ledger returns. Every promotion-relevant revelation of a holdout aggregate spends budget.
9. **The framework knows no domain.** It never names a table, a field, a business term, or a metric. Packs supply tasks, truth, scoring, skill and contract through a narrow command contract. Two packs with opposite truth latency are kept in the repo so the abstraction is tested from both sides; a framework change that fits only one of them is a smell.

## Interfaces

Four seams are how anyone plugs in: **pack** (what to evaluate), **proposer** (how to propose), **gate** (how to judge), **loop** (where to run — dsh, Claude Code, Codex, pi).

## What it is not

- Not an optimization algorithm. DSPy / GEPA / DGM-style self-modification / humans are *proposers* inside samsara.
- Not a benchmark. Task sets come from packs.
- Not an LLM gateway. That is gateway, reached only through a base URL.
- Not weight training. samsara's outer loop produces labelled environments for an inner loop; it does not run one.
- Not co-evolution of the judge with the judged (CoEvoSkills, Red Queen GM). A scorer changes only at a settlement boundary, with sign-off, and triggers ancestor re-scoring.
- Not an experiment tracker. The ledger is the substrate; the product surface is the champion, its challengers, and the next settlement.

## How we judge ourselves

- **Leading**: the three items above, built — each would be the first implementation.
- **Done well**: one round on a laptop in ten minutes; a known-good patch gets promoted and a pure-noise task set promotes nothing overnight; the ledger is identical after a restart; a truth revision re-scores automatically and can demote the champion.
- **Valuable**: one record on the pricing pack of a promoted skill confirmed by next month's truth; a second pack costs a tenth of the first to onboard; GEPA runs as a proposer.

## Honest caveats

The first year's value comes from the pricing case; the framework exists to make the second case ten times cheaper. Whether holdout accounting has any power at tens-to-hundreds of tasks (the Thresholdout bound wants thousands) is uncalculated; it is computed in bring-up step 0, and if infeasible v1 falls back to a parameter-free Ladder threshold with promotion-count rotation, keeping Thresholdout as a gate plugin with its scale preconditions documented.

## Vocabulary

| Term | Meaning |
|---|---|
| **book** | a pack's tasks × time × truth; knows which tasks are held out and when truth settles |
| **task** | one unit of work the skill is run on (a case at a cutoff; a repo with failing tests) |
| **settlement** | truth arriving or changing for a set of tasks; immediate or delayed; triggers scoring and re-judgement |
| **champion** | the single configuration currently served — an alias to a content-addressed set of kept rows |
| **challenger** | a candidate configuration = champion + one patch on one surface |
| **surface** | one mutable layer of the harness a patch may touch; see `architecture.md` |
| **scope** | the disposable dsh child scope a challenger runs in |
| **attempt** | one run of one task under one configuration with one loop |
| **loop** | an agent loop provider: dsh, claude-code, codex, pi |
| **tier** | evaluation stage: smoke → holdin → holdout → live |
| **gate** | the pluggable policy that turns scores into a verdict: invalid / drop / hold / promote |
| **sign-off** | human consent recorded through a channel the loop cannot reach |
| **ledger** | the append-only record of challengers, attempts, comparisons, consents, settlements |
| **pack** | a consumer's bundle: skill dir, contract schema, task sets, and the `truth` / `score` / `data` commands |

## Boundaries

```
dsh (kernel)        scopes, plugins, services, storage, jobs, subprocess, web
  └─ samsara (framework)   book · champion · scope · gate · sign-off · loops · workdir · submit · ledger · ui
        ├─ loops            dsh / claude-code / codex / pi   (replaceable)
        ├─ gate policies    default strict / user-supplied   (replaceable)
        ├─ proposers        claude -p / codex exec / gepa / human   (replaceable)
        └─ packs            coding-tasks (public) · pricing (private)   (replaceable)
```

- samsara depends on dsh through one shim module; re-pinning dsh is a one-file change.
- samsara talks to a pack only through `pack.yaml` and the pack's commands' stdout. No imports across the line.
- A pack talks to samsara only through the sealed workdir (task token, skill snapshot, submit tool). It never sees the ledger.
- legacy is not a dependency. The pricing pack may *vendor* legacy code to implement its commands; legacy's principles and store are not imported into the framework.

Evidence for the claims above: `docs/research/vision-calibration-2026-08-23.md`.
