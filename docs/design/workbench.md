# samsara — the workbench

dsh as the place where RSI experiments are run: you talk to dsh, the agent
drives samsara through tools, the conversation is the lab notebook, `/samsara …`
commands are the only place consent happens, and the ledger is the record. This
document is the public design of `packages/workbench` and `profiles/workbench`
(milestone W1). Status: *reconciled with the code* — tool and command names,
arguments, refusal codes, row shapes and the notebook kinds below are those of
`packages/workbench/src` and `packages/ledger/src/spec.ts`; where the earlier
specification said otherwise, the
code and this document moved together (startup reconciliation is a command,
the notebook carries approvals, failures and job outcomes).

The workbench adds no new fixed point and moves none. Book, gate and sign-off
stay where `philosophy.md` put them; the workbench is a second consumer of the
same `lifecycle` service the CLI commands call, with a person in the chair.

## Form: two profiles

| profile | boots | for |
|---|---|---|
| `host` | `dsh-base` + `@oldbulb/samsara` | the CLI: `run`, `campaign`, `promote`, `gate bench` …; CI, scripts, cron |
| `workbench` | `dsh-base` + `dsh-web-app` + `@oldbulb/samsara` + `@oldbulb/samsara-workbench` | the web UI: a conversation with an operator agent that holds the `samsara_*` tools, and `/samsara …` commands for the person |

Why two and not one: the samsara CLI is a one-shot argv parser mounted at
startup (`samsara-run-startup`), and dsh's web bundle has its own startup row
under the same seat — the two cannot coexist in one profile (known B4). So the
workbench bundle's patch disables `samsara-run-startup` and `samsara-runner`,
disables the samsara bundle's own webserver, storage hub and domain facility
rows (`samsara-webserver`, `samsara-storage`, `samsara-storage-domain`:
`dsh-web-app` brings all three under `webserver`, `storage`, `storage-domain`,
and the loader rejects a duplicate id before it reads `disabled`, which is why
the samsara rows carry their own ids), routes the ledger domain to the bundle's
`storage-sqlite` row through `dsh-web-app`'s facility (`storage-domain:
{ backend: json, routes: { samsara_ledger: sqlite } }`), sets
`agent-presets.default` to `samsara-operator`, and inserts its own rows.
`dsh-base` is the first bundle, as in dsh's own `web` profile: it holds the
host rows the workbench injects (`agent`, `session`, `tools`, `commands`,
`jobs`, `approval`, `agent-default-model`). Both profiles load the same
`lifecycle`, `ledger`, `gate`, `champion` and `signoff` rows and write the same
sqlite ledger. A campaign left open in one profile is resumed by starting the
campaign again on its experiment from either: the campaign reopens its last
open round and continues its sibling from the tier the ledger left it at.
(`run --resume` is the CLI's attempt-level resume of one run directory, not a
round's.) While a run is live, exactly one process must drive it: the ledger
records no owner on a round, so a workbench started beside a live CLI campaign
sees an open round with a running sibling and cannot tell it from one a dead
process left — which is why reconciliation is a command the person types, not
a side effect of starting the host.

The package (`@oldbulb/samsara-workbench`) has six entry points:

| entry | plane | what |
|---|---|---|
| `./commands` | host, global | the `/samsara …` commands, registered on `ctx.commands` |
| `./tools` | inside the operator preset | the model-facing `samsara_*` tools; only agents on that preset see them |
| `./executor` | host | the attempt executor (`runSet`) `ctx.lifecycle` runs through — the runner row's on the CLI profile, provided here for the life of the host. A per-session row must not own it: a service provided from a preset scope is disposed with the first session that mounted it |
| `./notebook` | host | mirrors decision-relevant session events into the ledger |
| `./presets` | host | the `samsara-operator` preset directory shipped with the package, and its installer |
| `./startup` | host | lists, on start, the rounds left open with a running sibling; `/samsara reconcile <round-id>` closes one |

## Participants and viewers

The ledger already redacts by viewer. The workbench adds one.

| participant | how it acts | viewer | sees |
|---|---|---|---|
| the person | web UI: `/samsara …` commands, Allow/Refuse on approval prompts, the Ed25519 sign-off key | `human` | everything |
| the operator agent | the `samsara-operator` preset; `samsara_*` tools only | `operator` | like `human` for rounds, experiments, servings, consents, noise floors and compare aggregates (no `per_task`); like `proposer` for attempts and scores — held-out per-task rows are never rendered to it |
| the proposer | an external CLI under the runner's diff scan, unchanged | `proposer` | the view directory: champion skill, held-in tasks and outcomes, held-out aggregates |
| the gate | a policy plugin, unchanged | `gate` | paired per-task values for the compare it is asked about |

The operator and the proposer are kept apart by route: the round row records the
operator's `(provider, model)` from the agent session's request context, and
the spending tools refuse (`OPERATOR_IS_PROPOSER`) before a round opens when the
operator's normalized `(provider, model)` equals the proposer's declared route
(the model proposer declares its model in its adapter config, and a provider
when it names one; command and human proposers declare nothing and are
allowed). A check that cannot run is not a pass: a model proposer that leaves
its model to its CLI's default, or an operator session without a request
context, is refused too — configure `model` on the proposer row. Base URL is
not readable at this dsh pin, so route identity is provider + model, and the
ledger says so. `lifecycle.openRound` itself performs no route check yet; the
CLI profile has no operator session.

## Tools

All tools are `defineTool` definitions with JSON-schema parameters, an output
schema and a `render`, mounted in the operator preset under
`inject: [lifecycle, ledger, jobs, approval]`. Every result carries an absolute
link to the evidence page (`/samsara/challengers/<id>`, `/samsara/rounds/<id>`,
`/samsara/experiments/<id>`) in the text and in `presentationMeta` — relative
URLs are stripped by dsh's markdown sanitizer, so the link is
`http://<host>:<port>/…` from `ctx.webServer`.

**Read-only — no approval, no spend.** (`samsara_propose_dry_run` is below: its
proposer call is a spend.)

| tool | calls | notes |
|---|---|---|
| `samsara_status` | `lifecycle.status()` | champion, open rounds, pending consents, noise floors per eval config, experiments. Empty state is onboarding: no noise floor for the active pack/loop → says so and quotes the calibrate cost; no A/A control run → says so |
| `samsara_packs` | `pack.yaml` under the configured `packsDir` (default `packs`) | name, set sizes, holdout `mde`/`budget`, skill dir |
| `samsara_ledger_view` | `ledger.read(view, 'operator')` | `view ∈ challengers · compares · rounds · experiments · servings · noise_floors · consents`; optional `filter {round_id, experiment_id, challenger_id}` and `limit` |
| `samsara_compare` | `ledger.comparesOf(id)` | promotion and shadow rows of one challenger, side by side |
| `samsara_next_actions` | `lifecycle.nextActions(id)` | for a judged row: replicate, go to holdout, drop — with the numbers the rule used and a cost estimate |
| `samsara_bench_gates` | the runner's bench module | `gate bench` over the champion's recorded attempts; pure |

**Spending — approval inside `execute`.**

| tool | arguments | starts | quotes |
|---|---|---|---|
| `samsara_propose_dry_run` | `{ pack, loop, proposer, set?, metric? }` | `propose --dry-run`: view + proposer + diff scan; no scope, no attempt, no ledger write | `proposer call, cost unknown` — the proposer's own call is the only spend and its cost is unknown to the host. `proposer` is a registered adapter name, never a path: what runs on the host is the profile's decision |
| `samsara_calibrate` | `{ pack, loop, set, reruns }` (`reruns ≥ 3`, S1) | `lifecycle.calibrate` as a job | tasks × reruns attempts at the champion's mean cost per attempt |
| `samsara_campaign_start` | `{ experiment_id, proposer, rounds, stop_on_promote?, shadow_gates? }` | `lifecycle.campaign` as a job; returns `{ job_id, experiment_id, champion_id }` at once | rounds × (smoke + held-in + held-out) attempts; the shadow gates are in the reason the person confirms |
| `samsara_control` | `{ kind: 'aa' \| 'inject', skill_dir? }` — `skill_dir` must be under the pack's directory (a directory the person placed there; a run's output is refused) and is named verbatim in the reason | `lifecycle.control` as a job | one control round at holdout |
| `samsara_round` | one round: propose → open → smoke → held-in [→ held-out once revealed] → judge | as a job | one round's attempts |
| `samsara_campaign_stop` | `{ job_id }` | kills a campaign job the operator owns | — (no approval) |

The sequence inside a spending tool is fixed: check the experiment's remaining
budget on the ledger and refuse with `BUDGET_EXCEEDED` before asking anyone;
then `ctx.approval.request({ agent, toolName, callId, reason })` with the
quoted cost in `reason` (`<what> ≈ $<usd> (<n> attempts)`, or `unknown` when
there is no cost history); `allowed-once` proceeds, anything else returns
`{ refused: true }` with no side effect. The question and the answer are
mirrored to the notebook either way: dsh writes an `approval/asked` /
`approval/decided` audit pair into the session log around the answer, and the
notebook keeps both as rows (the quoted cost's hash, the outcome's hash).

Jobs are owned by the operator agent, hold their own `AbortController` (wired
into every subprocess the job spawns, never `exec.signal`), and expose the
campaign's event lines through `readOutput`. Completion wakes the owner. The
approval request carries the call's signal: a turn cancelled under the question
withdraws it, and a grant that lands after the cancellation starts nothing. A
campaign never obtains consent itself: on `pending consent` it pauses and the
completion notice names the `/samsara approve <challenger-id>` or
`/samsara reveal <challenger-id>` the operator should ask the person to type —
the candidate's id in both cases, the subject the driver reads the consent
under before it runs the held-out tier. No tool takes an `auto_holdout`
argument: a held-out reveal is the person's consent per row, or pre-registered
once by the person with `/samsara predict … --auto-reveal` (`auto_reveal` on
the experiment row) — never an argument of the agent's.

## Commands

Registered on `ctx.commands` under the name `samsara`; arguments are raw text,
hand-parsed. The handler closes over the plugin's ctx
(`inject: ['commands', 'lifecycle', 'ledger', 'signoff', 'champion']`).

| command | effect | consent |
|---|---|---|
| `/samsara status` | the status tool, rendered as text | — |
| `/samsara predict <experiment-id\|new> "<hypothesis>" --pack <dir> --metric m --direction up\|down [--magnitude x] [--budget-usd u] [--budget-rounds r] [--gate name] [--n-eff-floor n] [--auto-reveal]` | `lifecycle.preregister` with `created_by: { channel: 'command', session_id, command_id }`; prints the experiment id and the exact `samsara_campaign_start` arguments | the pre-registration itself: it is typed by the person, never paraphrased by the agent |
| `/samsara approve <challenger-id> [--wait s]` | opens a `promote` sign-off through `ctx.signoff.request`, waits for the signed confirmation, then `lifecycle.decide(roundId)`; prints the servings row | `promote` |
| `/samsara demote <champion-id> "<reason>"` | the same path with action `demote` | `demote` |
| `/samsara gate <name@version\|./command>` | records a `gate_change` consent via sign-off | `gate_change` |
| `/samsara reveal <challenger-id>` | records a `holdout_reveal` consent via sign-off on the challenger the campaign paused on (the consent subject is a challenger id, as for `promote`) | `holdout_reveal` |
| `/samsara budget <experiment-id> --usd u\|--rounds r` | updates the experiment budget and appends `{at, session_id, command_id, budget}` to the row's `budget_changes`: who raised it to what, when, on the ledger (the id still names the pre-registered budget); the card says the same | — (recorded) |
| `/samsara stop <job-id\|round-id>` | kills the samsara job this session owns: by job id, or by a round id — the job that opened the round, else the campaign charged to the round's experiment. Jobs are matched by a tag the tools keep while the job runs (`experiment_id`, `round_ids` from `round:opened`), never by their label | — |
| `/samsara reconcile [<round-id>]` | without an id, lists the rounds open with a running sibling (writes nothing); with one, judges its running siblings `invalid` under `aborted:restart` and closes the round with outcome `{ superseded: [], aborted: true }` — refused while a job of this host drives the round | — (the person's judgement that nothing drives it) |

Every result is `{ kind: 'success' | 'error', text }` and is rendered by the
UI as a card; it never enters model history. After a consent-producing command
the handler puts a one-line notice in front of the operator
(`agent.followup(createUserMessage(…))`) so its next turn knows what changed.

## The consent / approval split

Two different questions, answered through two different channels, on purpose.

| | approval | consent |
|---|---|---|
| question | "may this tool spend ≈ $x now?" | "is this challenger the champion?" / "judge under this gate" / "reveal held-out" |
| who asks | the tool, from inside `execute` | the person, by typing a command |
| who answers | the person, Allow/Refuse in the UI | the person, with the sign-off key |
| proof | none needed — a refusal costs nothing, an allowance spends bounded money | an Ed25519 signature over a nonce on a `0600` unix socket (E2) |
| where recorded | notebook rows `approval/asked` (the quoted cost) and `approval/decided` (the answer) | `consents` row, `proof_sha` |
| can the agent trigger it | yes — that is what it is for | no — there is no tool that opens a sign-off |

A command is a UI-authenticated human action, not a key-signed one; that is why
`/samsara approve` still routes through `ctx.signoff` rather than accepting the
web session as the proof. The command handler holds no signing material.

## The notebook

`ctx.on('session/event')` is post-commit and live. For `tool/call` and
`tool/result` whose tool name starts with `samsara_`, for the `approval/asked`
/ `approval/decided` pair dsh logs around a spending tool's question, and for
`command/run` / `command/done` whose command is `samsara`, the notebook appends
a `notebook` row to the ledger; the tools append one more, `job/done`, when a
job they started settles:

```
notebook  id, session_id, seq, at,
          kind tool/call|tool/result|approval/asked|approval/decided|command/run|command/done|job/done,
          name, args_sha, result_sha?, error?, round_id?, experiment_id?, operator {provider, model}
```

- `tool/result` carries `error` when the result failed: dsh's error code
  (`UNKNOWN_TOOL` for a `samsara_*` name no tool answers to — a hallucinated
  call is recorded as one; `TOOL_ABORTED_BEFORE_DISPATCH`), else `ERROR` for a
  tool that threw. A row without `error` is a result the tool returned.
- `approval/asked` hashes the quoted cost (`reason`) under the tool name and
  the calling round/experiment; `approval/decided` adds the outcome's hash.
- `job/done` is written by `startJob` when the job settles — `name` is the job
  kind (`samsara-calibrate`, `samsara-campaign`, `samsara-round`,
  `samsara-control`), `args_sha` the label (the quote the person confirmed),
  `result_sha` the outcome `{ status, detail }` whose `detail` is the
  completion notice the agent reads (a floor's `sd_paired`, a campaign's
  verdicts and the `/samsara approve <id>` to ask for), `round_id` the last
  round the job opened, `seq` the session's next position at that moment. The
  notice reaches the agent through the jobs service (`job_output`, the
  completion wake), not a `samsara_*` result; this row is what binds it.
- The id is `keyOf(session_id, seq, kind, args_sha, result_sha ?? '')` —
  content-bound, not position-bound. The feed runs ahead of the session log's
  flush, so a crash can lose the tail of the log after its rows were written;
  on resume dsh reuses those `seq` values, and a reused position with other
  content is a new row beside the orphan rather than the orphan renamed.

Append-only, never rendered to the proposer. The operator route comes from the
session's request context. Pre-registration and consent are not session
events: dsh's session event catalog is a closed set at this pin (an
out-of-repo kind makes the log unresumable), so those are ledger rows keyed by
session id and command id — the conversation is the notebook, the ledger is
the record.

## Startup reconciliation

Jobs live in memory; nothing survives a host restart. On apply, `./startup`
reads `lifecycle.status()` and logs one warning per round still `open` with a
`running` sibling, naming the command that closes it. It writes nothing: a
round row carries no owner (pid, host, heartbeat), so the host cannot tell a
round its own previous process left from one a CLI campaign or a second
workbench on the same ledger is driving right now — and closing a live round
would judge a paid-for challenger invalid under the driver, which then fails
at judge time with `ROUND_CLOSED`.

The person closes a stale round with `/samsara reconcile <round-id>` (after
`/samsara reconcile` listed it): its running siblings are marked `judged` with
verdict `invalid`, rule `aborted:restart`, and the round is closed with outcome
`{ superseded: [], aborted: true }` — the ledger's round schema keeps
`aborted`, so an aborted round is never mistaken for a clean no-promotion
decision. The command refuses while a job of this host is tagged with the
round (`/samsara stop` it first). Nothing about an aborted round is resumed: a
campaign left open is resumed instead by starting it again on its experiment,
which reopens the last open round; `run --resume` is the CLI's and is
attempt-level.

The preset installer runs at the same time: it copies the shipped
`samsara-operator` directory into dsh's user preset root
(`$DSH_HOME/.agent-presets/samsara-operator`) when it is absent or when the
`.samsara-preset-sha` marker differs from the shipped directory's hash, and
never overwrites a directory without the marker — that one is a person's own.

## What is deliberately impossible for the agent

- **Sign anything.** No tool opens a sign-off; consent is a command the person
  types, proven by a key the host process never holds.
- **Spend without a quote.** Every spending tool quotes a cost and asks; a
  refusal returns before any side effect. Budget is checked on the ledger
  before the question is asked.
- **Read held-out per-task rows.** The `operator` viewer renders compare
  aggregates only, and attempts/scores as the proposer sees them.
- **Change the gate, the budget, or the prediction.** Those are commands with
  consent or a recorded who/when; the agent can ask the person to type them
  and its persona says so.
- **Reveal the held-out set.** No tool argument waives the `holdout_reveal`
  consent; a control's injected directory must sit under the pack and is
  named in the approval the person confirms.
- **Be the proposer.** A round whose operator route equals the proposer's
  declared route, or whose either side is unknown, is refused by the spending
  tools before it opens.
- **Run a program of its choosing.** The dry run takes a registered adapter
  name, never a path; the proposer set is the profile's.
- **Touch files.** The preset mounts no shell, filesystem or web tool; the
  operator reads ledger views.
- **Invent a number.** The persona binds every reported verdict, cost and
  promotion to a tool result or a job's completion notice; the notebook makes
  the binding checkable — `tool/result` rows for what the tools returned
  (failed results marked), `job/done` rows for what the jobs reported.
- **Survive a restart unnoticed.** A round left running is listed on the next
  start and closed aborted by the person's `/samsara reconcile`, recorded as
  such (`outcome.aborted`, verdict rule `aborted:restart`).

## dsh capabilities relied on

Verified against the pinned dsh source (`b150a551`). All of them enter the
framework through `@oldbulb/samsara-kernel`.

| need | dsh package | what it gives | what it does not |
|---|---|---|---|
| human commands | `@deepseek-ai/dsh-commands` (interaction) | `ctx.commands.register({ name, description, handler })`; results rendered by the UI, never in model history; `command/run` and `command/done` are durable session events | raw text arguments; web UI dispatch only |
| preset-scoped tools | `@deepseek-ai/dsh-tools` (core), `@deepseek-ai/dsh-agent-presets` | `defineTool` with typed args and a required `output`; a plugin mounted inside a preset's `cordis.yml` registers tools only that preset's agents see | no declarative read-only / needs-approval flag on a tool |
| spend confirmation | `@deepseek-ai/dsh-user-approval` | `ctx.approval.request({ agent, toolName, callId, reason })` → `allowed-once \| rejected \| cancelled \| unavailable` | plain-text reason; only from the live root agent in an open turn |
| runs that outlive a turn | `@deepseek-ai/dsh-jobs` | `ctx.jobs.start({ kind, label, owner, run })`; `job_list` / `job_output` / `job_kill` for the model; completion wakes the owner | nothing survives restart; pull-only progress; no abort signal handed in |
| operator route | `@deepseek-ai/dsh-session` (core), `@deepseek-ai/dsh-llm` | `agent.session.requestContext()` → `{ provider, model }`; `agent.id` is the session id | base URL not readable |
| the notebook feed | `@deepseek-ai/dsh-session` | `ctx.on('session/event')` post-commit; `ctx.sessionQuery.readSession(id)` across sessions | custom event kinds cannot be persisted |
| the evidence link | `@deepseek-ai/dsh-web` (host webserver) | `ctx.webServer.host/port`; prefix routes for `/samsara/…` | relative URLs are stripped; no client router |
| the preset root | `@deepseek-ai/dsh-app-boot` | `dshHomePath(...)` (fallback `$DSH_HOME`, `~/.dsh`) | — |
| the UI halves | `@deepseek-ai/dsh-web-app` bundle | commands, jobs, approval and user-question UI | not in `dsh-base`, which is why the workbench is its own profile |

Not available and therefore not designed around: scheduled runs (use OS cron
with the `host` profile), plugin-added host frames (progress is jobs rows or an
own SSE route), a user-side kill button for jobs (`/samsara stop`).
