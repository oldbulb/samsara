# samsara — philosophy and boundaries

## Vision

**samsara is the self-improvement substrate for agent harnesses: it lets a running harness keep iterating on itself under evidence that comes from reality, is not contaminated by the optimizer, and can be retroactively overturned.**

The three qualifiers are the three promises:

- **from reality** — truth lives outside the loop; it arrives immediately or late; settlement is an event;
- **not contaminated by the optimizer** — the holdout is a consumable, the judge is machine-isolated, judge-kind scores never reach a verdict;
- **retroactively overturnable** — every adoption carries full coordinates; when the world changes, ancestors are re-scored; the champion is alive.

The name: each candidate is one life; reality judges it; what is kept is reborn into the next generation. The cycle, not any single state, is the system.

Because mechanism is fixed and policy is pluggable, the substrate is also **the bench**: any optimizer is a proposer and any acceptance rule is a gate — both in any language, through a directory or a JSON stream, with no dsh in sight — and all of them are judged on one ledger against one measured noise floor. Other people's optimizers are our positive controls; other people's accept rules are rows in our catalog. We do not compete on the algorithm; we compete on whether the verdict can be trusted and whether it can be compared.

The substrate is harness-neutral by construction. dsh is the kernel — scopes,
services, storage, jobs, subprocesses — and it is a deliberate choice we keep.
It is not the identity: a loop is a seam with four intended providers, and the
claim we most want to be able to make, that a harness artifact certified here
holds up in a *different* harness, is one that binding our identity to any
single harness would contradict.

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

2026 moved fast. Held-out splits went from an argument to a default (Evo-Bench
160/448, EvoAgentBench 1006/367, GDPevo 5-in-5-out per group); DarwinX published
a preserve-and-extend accept rule; PACE recast committing as a sequential test
with a bounded per-decision false-commit probability. Restated honestly against
that, in four tiers.

### What we contribute to the field: the record, not the algorithm

Five 2026 systems report a self-improvement run five incompatible ways —
Evo-Bench as Overall + AnytimeVal, DarwinX as proxy-versus-held-out, RSIBench as
peak-versus-final, GDPevo by supervision type, Self-Harness as a double
non-regression. **No two runs can be compared.** The consequence is on record:
across DGM's 192 citations, four reviews and 440 forks, nobody audited its
20→50% curve — not for lack of interest, but because there was no artifact to
audit.

What a framework can define and a paper cannot is the artifact. Three pieces,
all of which are already load-bearing here:

1. **The evidence record** — a challenger's lineage, the one surface it touched,
   paired per-task scores at every tier, the measured noise floor, the gate
   policy and its parameters, holdout spend, cost, settlement events, and
   append-only re-scores. Framework-neutral, harness-neutral, algorithm-neutral.
   Its spine is a **coordinate tuple** (`architecture.md` § Coordinates): every
   quantity that can move a score is a named coordinate, a challenger's id is
   the hash of the tuple, and *comparable* is a rule the gate checks — equal on
   every coordinate but the one under test — not a convention the runner keeps.
2. **The surface taxonomy** — the 13 surfaces in `architecture.md`, and the rule
   that one challenger touches exactly one. Papers say "harness code"; without a
   shared vocabulary for *what changed*, attribution has nothing to attach to.
3. **The fixed-point boundary declaration** — machine-checkable globs, config
   keys and marked regions, plus the diff scan that enforces them before any
   evaluation spend. This is the general answer to DGM Appendix H and to PACE's
   self-p-hacking result.

These are built for our own object and our own tasks. What we take from
elsewhere is technique, not dependency: canonical JSON (RFC 8785 JCS) over
SHA-256 for content addressing, byte-source discipline for artifact identity
(line endings, modes, symlinks), closed schemas with frozen versions, and
cross-language conformance vectors. Those are how a record becomes trustworthy;
adopting them costs us nothing and adopting someone else's object model would
cost us the parts that matter — see "Relation to the community contract".

### What we lead by building: the gate as an arena, not a claim

Mechanism is fixed, policy is pluggable — so every published accept rule is a
plugin here, not a rival. `gate-catalog` ships thirteen of them as policies —
keep-better, hill-climb, DGM's `keep_better`, Self-Harness's double
non-regression, RSEA's held-out selection, the Ladder, Miller's clustered
interval, McNemar, PACE's e-process, HCL's commit rule, AutoScientists'
noise-floor bar, and `gate-default` — and `gate bench` runs any of them, or a
gate you wrote in any language, on recorded reruns of one configuration, where
every acceptance is by construction a false one. On our closed-book data (83
tasks, 43 entities, 3 reruns) that table reads: keep-better 0.51, DGM
0.72–1.00, Self-Harness 0.38, the Ladder 0.12–0.20, `gate-default`'s test 0.06
against a declared 0.05, Miller 0.04. **A paper cannot produce that table; a
framework with a ledger is the only thing that can** — and it is what a
researcher gets ten minutes after plugging in their own rule.

The calibration is stated with its limits: one pack, its held-in tier; at the
held-out tier's 29 entities the bootstrap runs ≈1.5× its nominal α; the
detectable effect on this pack (≈0.14) is above the SESOI the pack declared
(0.05), so `gate-default` has so far answered `hold:underpowered` and has never
issued a promotion on real data. That is the correct answer in kind and an
unfalsified gate in fact; the positive control is the next thing that matters.

### What is still unoccupied: truth that arrives late

Every benchmark surveyed above verifies immediately. Nothing in the 2026
literature poses the case where truth for a task arrives next month and can
later be revised — which is the step from RSI-on-benchmarks to RSI-in-production,
and the reason the champion has to be able to die.

Two capabilities follow, and both are built but currently unexercised:

- **An automated loop on delayed truth.** A book declares truth latency; a
  settlement is an event; a task can be scored long after the round that ran it.
- **A living champion.** A truth revision, a scorer version bump, a model
  upgrade or a task-set change re-scores the ancestry (append-only) and can
  demote the champion. Inspect, LangSmith and Braintrust offer manual per-run
  back-fill; the automatic trigger is new.

Honest status: **no pack in tree drives either.** Until one does, this is a
declared direction with dormant machinery behind it, not a demonstrated
capability, and it is written here as such.

### What we no longer claim

- **Holdout accounting is engineering, not a lead.** The Thresholdout bound
  wants thousands of tasks; at our scale it is infeasible, and `gate-default`
  falls back to a parameter-free Ladder signal and a reveal budget; rotation on
  promotion count is designed, not implemented (`architecture.md` S7).
  Budgeting and rotation still matter — they are just not novel.
- **Retention is HCL's contribution, not ours.** Harness Continual Learning
  (arXiv:2608.19013) named harness-level forgetting and made "no previously
  solved anchor may fail" a commit condition. We intend to adopt the
  requirement as a later gate rule 7b — not in `gate-default@0.2.0`, which
  bounds nothing on retention (`gate.md` § Non-goals) — as a calibrated
  non-inferiority bound rather than a count: their count, at our measured 40%
  task flip-rate, would reject everything.
- **We did not invent sequential testing.** Statsig and Eppo commoditized it,
  and PACE published an anytime-valid form for this exact setting. What we do
  claim is our own method and its calibration: `gate-default` takes paired
  per-task deltas, clusters them by entity for `nEff`, puts a BCa bootstrap
  interval at a Holm-adjusted α around the mean, and compares it against an MDE
  computed from a *measured* noise floor — so it can return `underpowered`
  rather than a verdict. Published policies are absorbed as alternatives, not
  ceded to: the position is a gate that is calibrated, recorded and comparable,
  and ours is one of the policies in it.

Where prior art exists and samsara closes the loop: **surface attribution fed
back to the proposer** (SkillsVote and AHE attribute per edit; nobody aggregates
across surfaces or feeds the optimizer); **revocable cross-harness certification
under a fixed gate** (SkillOpt and SkillsBench measure transfer — a skill
trained in one harness lifting another from 22.1 to 81.8 is the strongest
evidence that harness artifacts are portable; the gate, the adapter version as a
coordinate, and revocability are what we add); **trajectories labelled with
adoption and post-settlement confirmation** as a training export (an untested
hypothesis, and labelled as one).

## Principles

1. **Disposable.** A candidate is a child scope of the host. Running it has no effect on the host; disposing it frees everything it allocated (processes, temp dirs, storage handles, registrations). Keeping it means merging its patch into the champion, nothing more. The framework must never mount a candidate through any path that persists it (hard constraint E1).
2. **One champion, many challengers.** Exactly one configuration is served. Challengers compete on the same tasks. Promotion happens only through the gate; the proposer is never the acceptor.
3. **Reality settles.** Truth comes from outside the loop — immediately (a test suite) or later (next month's outcome). Truth latency is a first-class property of a book; settlement is an event. Model-judged scores may be recorded, may steer smoke and holdin, but never decide promotion.
4. **The judge is out of reach by machinery, not by agreement.** The book and scorer run in their own process with read-only mounts and an `env_sha`; every surface declares a machine-checkable boundary (file globs, config keys, marked regions); the diff scan rejects, before any evaluation spend, a patch that touches the evaluation, logging, or marker pipeline. (DGM, Appendix H: an agent deleted the hidden hallucination markers and scored perfectly.)
5. **The gate's objective includes cost.** Verdicts are on solve-rate at a cost budget or on a Pareto front; tokens, wall time, and money are ledger columns. Without this, tool, route, and context surfaces are invisible and null patches get promoted on token noise.
6. **Typed action space.** A proposal is a patch on one declared surface. Arbitrary code edits are not a surface. Each surface carries its own gate policy.
7. **Replayable coordinates.** Every quantity that can move a score is a column of the ledger row. Two rows equal on all of them define the noise floor. Re-scores append; they never overwrite.
8. **Exposure asymmetry, with a budget.** A proposer sees held-in tasks individually, held-out tasks only as aggregates, never a path to truth or scores — enforced by what the ledger returns. Every promotion-relevant revelation of a holdout aggregate spends budget.
9. **The framework knows no domain.** It never names a table, a field, a business term, or a metric. Packs supply tasks, truth, scoring, skill and contract through a narrow command contract. Two packs are kept in the repo, the second a control that shares nothing with the first but the contract; a framework change that fits only one of them is a smell. Both settle immediately — a delayed-truth pack is the test the abstraction still lacks (§ Honest caveats).

## Interfaces

Four seams are how anyone plugs in: **pack** (what to evaluate), **proposer** (how to propose), **gate** (how to judge), **loop** (where to run — dsh, Claude Code, Codex, pi).

Two of them are for researchers and must cost an afternoon, not a week: a **gate** is a program that reads a compare request on stdin and writes a verdict on stdout; a **proposer** is a program that reads a view directory and writes a proposal directory. Both have SDKs in TypeScript and Python, a zero-spend dry run, and a bench. Loops are ours to write — they require knowing the harness.

## Where this goes

The second consumer of the substrate is not a pack but a place: **dsh as the workbench on which RSI experiments are run.** It is built (`packages/workbench`, the `workbench` profile; `workbench.md`): the researcher talks to dsh; the operator agent drives samsara through the `samsara_*` tools (status, ledger views, a dry run, calibrate, a round, a campaign, a control, the bench); the conversation is the lab notebook, mirrored into the ledger; `/samsara …` human commands are the only place pre-registration and consent happen; the ledger is the record. Three things survived the move, by construction: the tools call the same `lifecycle` service as the CLI (one implementation of the six transitions, two entry points and the UI reading beside them — no package outside `lifecycle` writes a status, a verdict, a compare, a round, a serving or a noise floor); the operator's agent is refused as the proposer of a round it would operate, and sees held-out data only as aggregates; sign-off never leaves the command plane — a spending tool asks for an Allow, a promotion asks for a signature, and no tool opens a sign-off.

Before any of that costs a model call there is a first run at zero cost: `packs/synthetic` is a biased coin with a known answer, and the whole lifecycle — the noise floor, a pre-registered experiment, rounds through smoke, held-in and held-out, the gate, the sign-off, the promotion — runs on the null loop, promoting an injected effect and holding the null diff round after round. It is the positive and the negative control of the framework itself, and `pnpm test` runs it.

A third consumer — the user's own daily harness as the book, git as delayed truth, nightly proposals and morning consent — is designed and parked: it needs the live tier, and a gate that has promoted something on a real pack.

## Relation to the community contract

samsara is not alone at this boundary. dsh discussion #2454 and the reference
gate built around it — `dsh-guarded-hcl`, following arXiv:2608.19013's split of
candidate generation from state commitment — use a vocabulary that maps onto
ours almost one to one: Candidate/challenger, RetentionAnchor/held-in anchor,
EvaluationEvidence/comparison row, CommitDecision/verdict, Harness Recipe/champion.

**We are not implementing it.** We ported its `evaluateCandidate` and measured
it: under a strict null, with the schema's own default policy, it accepts a
behaviourally identical candidate 50–65% of the time, and that rate does not
fall as evaluation grows, because the decision is a threshold on the difference
of two scalars. Its retention anchors do most of the filtering by accident,
which produces a backwards incentive — a more deterministic anchor suite makes
the gate more permissive. The defect is in the object model, not the thresholds:
`currentTask` records two numbers and no record of how many items produced them
or whether they were paired, so the meaning of an acceptance is not recoverable
from a conforming document.

An evidence record whose primary object cannot carry uncertainty is not a
foundation we can extend; the parts we would have to bolt on are the parts that
decide anything. So the relation is peer, not membership:

- **Technique we take**: JCS-over-SHA-256 canonical digests, artifact
  byte-source discipline, closed schemas with frozen versions, conformance
  vectors. Their digest layer is more rigorous than ours and we should say so.
- **Object model we keep**: surfaces (13, one per challenger) over a four-value
  component enum; tiers and a holdout budget where they have no holdout at all;
  paired per-task data and a measured noise floor where they have scalars; a
  fourth verdict for absent evidence where they have a boolean.
- **What we send them**: the measurement, because it is a real finding about a
  real gate and it is useful whether or not they adopt anything.
- **Interop stays cheap**: emitting their format from our ledger is a
  serializer. It is available if it ever buys something; it is not the strategy.

## What it is not

- Not an optimization algorithm. DSPy / GEPA / DGM-style self-modification / humans are *proposers* inside samsara.
- Not a benchmark. Task sets come from packs.
- Not an LLM gateway. That is gateway, reached only through a base URL.
- Not weight training. samsara's outer loop produces labelled environments for an inner loop; it does not run one.
- Not co-evolution of the judge with the judged (CoEvoSkills, Red Queen GM). A scorer changes only at a settlement boundary, with sign-off, and triggers ancestor re-scoring.
- Not an experiment tracker. The ledger is the substrate; the product surface is the champion, its challengers, and the next settlement.
- Not an implementation of someone else's evidence contract. We measured the nearest one and keep our own object model; we take its digest technique, not its schema.
- Not a dsh application. dsh is the kernel; the pack contract, the ledger format and the gate policies are cross-process contracts that carry no dsh types and no dsh requirement.

## How we judge ourselves

- **Working at all** (true on the synthetic coin, not yet on a real pack): a known-good patch is promoted and a pure-noise task set promotes nothing overnight, both on a task set with a non-zero measured noise floor. `packs/synthetic` does both through the full lifecycle at zero cost; until a real pack does, nothing below is claimable.
- **Done well**: one round on a laptop in ten minutes; the ledger is identical after a restart; a truth revision re-scores automatically and can demote the champion.
- **Contributing**: a run from a system that is not ours validates against our evidence record; four gate policies produce one comparable false-commit table; a published self-improvement claim is re-audited with it.
- **Valuable**: one record of a promoted artifact confirmed by truth that only arrived after the promotion; a second pack costs a tenth of the first to onboard; GEPA runs as a proposer.

## Honest caveats

**The gate has never promoted on a real pack.** On the closed-book pack the
effect one round can detect (≈0.14 at three reruns) is above the SESOI it
declares (0.05), so every real comparison has ended `hold:underpowered` — the
right answer in kind, an unfalsified gate in fact. The controls exist only on
the synthetic coin: the injected effect promotes and the null diff holds,
through the same lifecycle and at zero cost. Until a positive control promotes
on a task set where n × R reaches the SESOI, no claim on this page is
demonstrated on real data, only designed and controlled.

**Delayed truth has no consumer.** The pending-truth, settlement and re-scoring
machinery is built and tested, and nothing in tree exercises it. Either a public
pack with genuinely late truth lands, or that machinery is marked dormant with
its revival condition written down. Code that is neither used nor retired rots.

**The second-pack claim is untested.** The framework earns its keep on the
second pack, not the first; the second pack in tree is a control that shares
nothing with the first but the contract, which is what the contract is for —
it is not a second domain.

**Holdout accounting was recalibrated, not achieved.** The Thresholdout bound
wants thousands of tasks; at tens-to-hundreds it is infeasible, so `gate-default`
uses a parameter-free Ladder threshold with rotation on promotion count, and
Thresholdout stays a gate plugin with its scale preconditions documented.

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
| **set** | which tasks: smoke / holdin / holdout, a partition of the book |
| **tier** | which rule: smoke → holdin → holdout → live; a tier is evaluated on the set of the same name, except live, which is production traffic |
| **round** | the unit of multiple comparison and of promotion: K siblings judged against one champion under one gate and one noise floor; at most one is promoted |
| **eval config** | everything on the judge's side that can move a score — task sets, protocol, scorer, truth snapshot, reporting rule, metrics — as one content-addressed identity; a settlement is a change to it |
| **serving** | the interval during which one champion was the served configuration; what a late-arriving truth is attributed to |
| **harness-level forgetting** | previously reliable behaviour lost to a later harness change (HCL); what the retention rule and the living champion guard against |
| **gate** | the pluggable policy that turns scores into a verdict: invalid / drop / hold / promote |
| **sign-off** | human consent recorded through a channel the loop cannot reach |
| **ledger** | the append-only record of challengers, attempts, scores, comparisons, rounds, eval configs, noise floors, servings, consents, settlements |
| **pack** | a consumer's bundle: skill dir, contract schema, task sets, and the `truth` / `score` / `data` commands |

## Boundaries

```
dsh (kernel)        scopes, plugins, services, storage, jobs, subprocess, web
  └─ samsara (framework)   book · champion · scope · gate · sign-off · loops · workdir · submit · ledger · lifecycle · ui · workbench
        ├─ loops            dsh / claude-code / codex / pi   (replaceable)
        ├─ gate policies    default strict / user-supplied   (replaceable)
        ├─ proposers        claude -p / codex exec / gepa / human   (replaceable)
        └─ packs            coding-tasks (public) · synthetic (control)   (replaceable)
```

- samsara depends on dsh through one shim module; re-pinning dsh is a one-file change.
- samsara talks to a pack only through `pack.yaml` and the pack's commands' stdout. No imports across the line.
- A pack talks to samsara only through the sealed workdir (task token, skill snapshot, submit tool). It never sees the ledger.
- The predecessor system is not a dependency. A pack may *vendor* whatever code it likes to implement its commands; nothing from the prior system is imported into the framework.

### Inside and outside the loop, in dsh's terms

dsh already draws three boundaries of increasing strength. samsara's inside/outside is stated on them, not invented beside them.

1. **The fiber tree.** In cordis the system state *is* the set of loaded plugins: every side effect is registered through `ctx.effect` and unwinds when its fiber is disposed. A challenger is a child fiber of the host, created in memory and never through a file. *Inside the loop* is everything that descends from a challenger's fiber — it exists while the challenger runs and is gone, by construction, when it is dropped. This is principle 1 in dsh's own words.
2. **The agent scope.** dsh registers tools, prompt sections, variables, restrictions and listeners either globally or scoped to one agent; a scoped registration shadows its global twin for that agent alone and never inherits down to sub-agents. A challenger's world is the set of scoped registrations made in its agent's setup window; it cannot shadow what it was not handed.
3. **The process.** Filesystem, subprocess and sandbox are seams; what crosses them is bytes on stdout or a socket, never an object.

*Outside the loop* then means: not a descendant of any challenger fiber, not shadowable by a scoped registration, and — for the three fixed points — on the far side of a process boundary. The book's truth is a pack command's stdout; sign-off is a signature on a unix socket; the gate is a service on the host root tree that rejects judge-kind scores by type. The first two levels make a challenger disposable and blind; only the third makes the fixed points unreachable. A cordis scope is a lifetime-and-visibility boundary, not a security boundary — the `inject` guard is a convention a proxy can walk around — which is why E8 asks for machine isolation of the judge, and why the framework never calls a child scope a sandbox.

### What samsara takes from the session log, and what it refuses

dsh's other contract is the session log: model-visible means logged, and every request is a pure function of the log. Each request's envelope — `config`, `system`, `tools` — is a logged event, and the surfaces in `architecture.md` are classified by which envelope field they land in.

samsara reads the log in two places. The loop reports the envelope per attempt: it is the run-time check that a challenger touched one surface, and it prices a model-visible patch in tokens without a model call. The training export is the session log plus ledger coordinates, not a trajectory format of our own. Loops other than dsh report the same envelope with the fidelity they can honestly claim — exact where the harness exposes the text, proxy where only an identifier and a version are visible — and that fidelity is a ledger coordinate, so the gate compares only what both sides actually saw.

What the log cannot give is a counterfactual. dsh's `llm-replay` replays what the model said, indifferent to what the harness showed it; it serves keyless regression tests and never evaluates a challenger. Evaluation always runs.
