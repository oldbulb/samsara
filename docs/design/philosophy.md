# samsara — philosophy and boundaries

## What it is

samsara is a framework for **recursive self-improvement of agent systems, done as governance rather than magic**. It runs on DeepSeek Harness (dsh) as its kernel. A consumer brings a *pack* (tasks, truth, scorer, skill, contract); samsara supplies the machinery that lets the system change itself safely: every change is a **challenger**, evaluated in a **disposable scope**, promoted to **champion** only by a statistical **gate** against truth that arrives from **outside** the loop, with human **sign-off** that the loop cannot forge.

The name: each candidate is one life; reality judges it; what is kept is reborn into the next generation. The cycle, not any single state, is the system.

## The claim

Self-improvement systems fail in two known ways: the evaluator drifts with the thing it evaluates (self-confirming loop), and changes accumulate until the current state depends on the order of history (rollback becomes archaeology). samsara's answer is structural, not advisory:

- **Three fixed points live outside the evolving loop**: the *book* (tasks and truth), the *gate* (promotion statistics), and *sign-off* (human consent). Nothing inside the loop can write to them.
- **Everything else is mutable — including the optimizer.** The optimizer's own configuration is just another surface a challenger can patch. That is what makes the improvement *recursive*; the fixed points are what keep recursion from collapsing.
- **Host state is a set, not a history.** The served system equals the champion's kept rows applied to an empty profile. Replaying them must reproduce the same hashes. A candidate that is dropped leaves nothing behind.

## Principles

1. **Disposable.** A candidate is a child scope of the host. Running it has no effect on the host; disposing it frees everything it allocated (processes, temp dirs, storage handles, registrations). Keeping it means merging its patch into the champion, nothing more. The framework must never mount a candidate through any path that persists it (see hard constraint E1).
2. **One champion, many challengers.** Exactly one configuration is served. Challengers compete on the same tasks. Promotion happens only through the gate; the proposer is never the acceptor.
3. **Reality settles.** Truth comes from outside the loop — immediately (a test suite) or later (next month's outcome). The framework treats *truth latency* as a first-class property of a book and models *settlement* as an event. Model-judged scores may be recorded but never decide promotion.
4. **Typed action space.** A proposal is a patch on a declared surface (skill text, harness config, route, optimizer config, scorer, task set). Code edits are not a surface. Each surface carries its own gate policy.
5. **Replayable coordinates.** Every quantity that can move a score is a column of the ledger row: patch, harness sha, environment sha, skill sha, task-set sha, truth sha, scorer version, route, harness facts. Two rows equal on all of them define the noise floor.
6. **Exposure asymmetry.** A proposer sees held-in tasks individually, held-out tasks only as aggregates, and never a path to truth or scores. This is enforced by what the ledger returns, not by prompt text.
7. **The framework knows no domain.** It never names a table, a field, a business term, or a metric. Packs supply tasks, truth, scoring, skill and contract through a narrow command contract. Two packs with opposite truth latency (immediate coding tasks; delayed pricing outcomes) are kept in the repo so the abstraction is tested from both sides; a framework change that fits only one of them is a smell.

## What it is not

- Not an experiment tracker. The ledger exists, but it is the substrate; the product surface is the champion, its challengers, and the next settlement.
- Not a prompt-optimizer library. DSPy/GEPA/TextGrad optimize a program in-process; samsara optimizes a *running agent host* (skill + harness + route) with a lifecycle and governance. Those optimizers can be *proposers* inside samsara.
- Not an agent loop. dsh, Claude Code, Codex and pi are loop providers; samsara is the host that spawns, seals, scores, and disposes them.
- Not a chat product. Chat is one way a proposer submits a patch.

## Vocabulary

| Term | Meaning |
|---|---|
| **book** | a pack's tasks × time × truth; knows which tasks are held out and when truth settles |
| **task** | one unit of work the skill is run on (a case at a cutoff; a repo with failing tests) |
| **settlement** | truth arriving for a set of tasks; immediate or delayed; triggers scoring and re-judgement |
| **champion** | the single configuration currently served: skill@sha × harness patch × route |
| **challenger** | a candidate configuration = champion + one patch on one surface |
| **surface** | what a patch may touch: skill, harness, route, optimizer, scorer, taskset |
| **scope** | the disposable dsh child scope a challenger runs in |
| **attempt** | one run of one task under one configuration with one loop |
| **loop** | an agent loop provider: dsh, claude-code, codex, pi |
| **tier** | evaluation stage: smoke → holdin → holdout → live |
| **gate** | the code that turns scores into a verdict: invalid / drop / hold / promote |
| **sign-off** | human consent recorded through a channel the loop cannot reach |
| **ledger** | the immutable record of challengers, attempts, comparisons, consents |
| **pack** | a consumer's bundle: skill dir, contract schema, task sets, and the `truth` / `score` / `data` commands |

## Boundaries

```
dsh (kernel)        scopes, plugins, services, storage, jobs, subprocess, web
  └─ samsara (framework)   book · champion · scope · gate · sign-off · loops · workdir · submit · ledger · ui
        ├─ loops            dsh / claude-code / codex / pi   (replaceable)
        └─ packs            coding-tasks (public) · pricing (private)   (replaceable)
```

- samsara depends on dsh through one shim module; re-pinning dsh is a one-file change.
- samsara talks to a pack only through `pack.yaml` and the pack's commands' stdout. No imports across the line.
- A pack talks to samsara only through the sealed workdir (task token, skill snapshot, submit tool). It never sees the ledger.
- legacy is not a dependency. The pricing pack may *vendor* legacy code to implement its commands; legacy's principles and store are not imported into the framework.
