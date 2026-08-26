# synthetic pack (control, immediate truth)

Nothing here is real. The truth is a biased coin: every task carries a
`base_rate`, the skill under optimization carries an `effect`, and `truth`
draws `passed` with probability `base_rate + effect`. It exists so the whole
framework — subprocess seams, workdir, ledger, gate, sign-off, champion — runs
end to end at zero LLM cost with a *known* answer: a challenger whose `effect`
is 0.15 must promote on holdout, and a challenger whose `effect` is 0 (an A/A
rerun of the champion) must not.

## Layout

```
pack.yaml
skill/SKILL.md                       # the skill text (says nothing that matters)
skill/params.json                    # { "effect": 0.0 } — the one thing a challenger changes
contract.schema.json                 # submit_answer.json: { answer: string }
tasks/{smoke,holdin,holdout}.jsonl   # 8 / 48 / 96 tasks, see below
bin/materialize.mjs  bin/truth.mjs  bin/score.mjs  bin/lib.mjs   # Node, stdlib only
tools/gen-tasks.mjs                  # regenerates tasks/
tools/propose-effect.mjs             # the campaign proposer: the champion skill with --effect x
```

A **challenger** is a copy of `skill/` with a different `effect` in
`params.json`. The champion is the pack's own `skill/` (effect 0).

## Task line

```json
{"task_id":"f29/t1","entity_key":"f29","stratum":"s2","base_rate":0.382}
```

- `entity_key` = family; two tasks per family, so the gate's entity clustering
  is exercised. Holdout families (`f29`–`f76`) never appear in smoke or holdin.
- `stratum` ∈ `s1|s2|s3`, round-robin over families.
- `base_rate` ∈ [0.3, 0.7] from a hash of the task id (`tools/gen-tasks.mjs`).

## Commands (jsonl on stdin, jsonl on stdout)

- `bin/materialize.mjs` — `{task_id, workdir}` → writes `task.json` naming the task; stdout `{task_id, ok:true, files:["task.json"]}`.
- `bin/truth.mjs` (`in_environment: true`, "In a container" below) — `{task_id, workdir}` → reads the attempt token (`.task/token.json`: the attempt id, which must be the workdir's own name, the `sample` index and the `skill_path`) and the skill snapshot's `params.json` (at `skill_path`, for `effect`), then `p = clamp(base_rate + effect, 0, 1)` and `passed = 1 iff draw < p`; stdout `{task_id, status:"settled", truth:{passed}, truth_sha}` with `truth_sha` = sha256 of the three task files and the truth code (`bin/lib.mjs`, `bin/truth.mjs`), so a change to `NOISE` or the draw scheme is a new truth snapshot. Deterministic in its inputs.
- `bin/score.mjs` — `{task_id, truth, output}` → `pass_rate` (reality, = `passed`) and `cost_usd` (mechanical, from `output.usage.cost_usd`, 0 for the null loop), each with the task's `stratum`.

### What the loop can reach

`effect` is read from the skill snapshot inside the workdir, which the loop can
write. The framework keeps the snapshot honest, not the pack: a loop that hands
back `.agents/skills/answer/` changed finishes `FAILED` (`@oldbulb/samsara-loops`
rehashes it at finish) and the attempt is ineligible at the gate. The token is
the pack's own check: it must name the workdir it sits in, so a rewritten token
cannot re-roll the jitter. Under the null loop (the recipe below) neither can
happen; `tests/synthetic.e2e.test.ts` runs a tampering loop to pin both.

### What truth reads from the token

Everything `truth` needs about the attempt is in the attempt token
(`docs/design/packs.md`, "The attempt token"): `sample`, the replicate index
the draw is paired on (`--repeat N` counts it up), and `skill_path`, where the
skill snapshot sits. Neither is defaulted: a token without either, or a workdir
without the snapshot at `skill_path`, is an error and the command exits
non-zero. A silent sample 0 would give every replicate the same coin, and the
gate's replicate averaging would then claim power it does not have.

### Noise

The draw is paired by construction (common random numbers): `u = hash(task_id, sample)`
is shared by every attempt of the same task and sample index — `sample` from
the attempt token — so the champion and a challenger see the same coin on the
same task. A per-attempt
jitter (`NOISE = 0.1` in `bin/lib.mjs`, uniform ±0.1, reflected at 0 and 1)
is added so that an A/A rerun is not identical: it disagrees on a task with
probability `2·NOISE/3`, giving the paired delta a sd of about 0.26 around a
mean of 0. With effect 0.15 the paired delta has mean 0.15 exactly.

This is what `calibrate` measures: it reruns the champion on the set at the
*same* sample index and takes the paired difference per entity, so the coin
cancels and only the jitter is left — `sd_paired` ≈ 0.18 for a two-task entity
(0.26 / √2). A floor taken across sample indices would be the coin itself
(≈ 0.5), which no comparison ever sees; `tests/synthetic.e2e.test.ts` pins the
measured value under 0.3.

### Power

`holdout.mde: 0.05` is the SESOI the pack declares (the smallest effect worth a
promotion, gate rule 7). It is *not* what one replicate can detect: with the
calibrated floor (sd_paired ≈ 0.18 per entity) and 48 held-out entities the
design's MDE is `2.8 · sd / sqrt(n_eff · replicates)` (gate rule 3) ≈ 0.073 at
one replicate, so a held-out judgement at `--repeat 1` is `hold:underpowered`
(`power:mde`) whatever the effect. Replicates buy power: R = 3 reaches 0.05 in
expectation, R = 6 reaches it for any floor estimate under 0.30, which is what
the campaigns below use (`--holdout-repeat 6`). Held-in has 24 entities and is
underpowered at one replicate too (MDE ≈ 0.103), and the power floor (rule 3)
comes before the futility screen (rule 5): with a floor pinned, every held-in
judgement of this pack at one replicate is `hold` on `power:mde`, whatever the
effect, and the screen never runs. That is fine for the recipe — a campaign
takes such a `hold` on to holdout (`--auto-holdout`) — but it means the
held-in tier drops nothing here. Reaching the SESOI at held-in would take
R ≥ 5 replicates (8 with the campaign's doubling, `--max-repeat 8`),
more attempts than the held-out test itself, so the recipe does not buy them.

Without a noise floor (a `challenge` before any `calibrate`) the held-out
tier is refused (`invalid:noise_floor`, S1); held-in and smoke judge with MDE
0, so only the entity floor binds and the held-in screen is reachable: the
null diff drops there on `futility` about one time in six (z < −1), the
injected effect survives it (`hold` on `screen`).

### Held-out reveals

`holdout.budget: 24` is the pack's held-out budget (S7): one reveal per
challenger run on the held-out set, counted across the ledger (a restart
re-debits the reveals the ledger holds), refused once spent
(`BUDGET_EXCEEDED`, the campaign stops on `budget`). The recipe below spends
22 — 20 A/A rounds, the injected round, `control aa` — so a rerun of a step
on the same ledger needs a fresh `data/ledger/`, and every held-out compare
row records `holdout_budget_remaining`.

## In a container (`--env docker`)

`pack.yaml` declares where an attempt runs — `environment: { image:
'node:22-slim', network: none }` — and marks `truth` as `{ run:
./bin/truth.mjs, in_environment: true }`; `materialize` and `score` stay on
the host. With the default provider (`--env local`) nothing changes: the image
is not used and an `in_environment` command is a host subprocess from the pack
dir, exactly the run above. With `--env docker` the runner opens one
`node:22-slim` container per attempt (no network), mounts the pack directory
read-only at its own absolute path so `./bin/truth.mjs` and `tasks/*.jsonl`
resolve as on the host, puts the sealed workdir into `/workspace/<attemptId>`
(the token still names the workdir it sits in), runs `truth` inside through
`docker exec` with the same jsonl on stdin and stdout, and records the image
digest, resources and network on the attempt row; champion and challenger rows
carry `environment_sha` (rule 0, `docs/design/notes/environments-harbor-modal-2026-08-26.md`).

The row is off by default; enable it in the profile patch where a daemon is
reachable, then add `--env docker` to any of the commands above:

```yaml
- id: environments-docker
  disabled: false
```

```sh
dsh --profile host calibrate --pack packs/synthetic --loop null --set holdin --reruns 5 \
    --metric pass_rate --parallel 8 --env docker --out data/runs/synthetic-calibrate-docker
```

The loops that exist today are host-side (`packages/loops/README.md`): the
null loop writes its submission into the attempt's workdir on this host, which
under `docker` is a container path, so a CLI run on `docker` ends with the loop
failing until an installed loop lands. What the container path does run is
pinned by `tests/synthetic.e2e.test.ts` ("in a docker environment"): three
smoke attempts, materialize on the host, the sealed workdir put in, `truth`
inside from the mounted pack dir, `score` on the host, the same coin as the
same attempt on `local`, one `environment_sha` across the three. It skips
without a daemon; CI runs it on ubuntu:

```sh
pnpm vitest run tests/synthetic.e2e.test.ts -t docker
```

## The two controls

| control | challenger `effect` | expected verdict on holdout |
|---|---|---|
| injected (positive) | 0.15 | `promote` (rule `holdout`) |
| A/A (negative) | 0 | `hold`; a promotion is a false positive, expected at about the gate's α |

On holdin both end `hold` — rule `power:mde` once a floor is pinned, rule
`screen` without one (the injected effect survives the futility screen); on
smoke every tier ends on validity, which is why the null loop must submit
(below).

## Running it from the CLI

The null loop submits nothing by default, so every attempt is `valid: false`
and smoke drops the challenger. Give the row a canned submission in your
profile patch (`profiles/host/cordis.patch.yml`), and mount the pack's proposer
twice — once per effect, each under its own name (the effect is part of the
proposer's config sha, so the two are two optimizer configurations on the
ledger). `loops-null` is a row the bundle already has, so a bare `- id:`
patches it (a patch replaces the whole config of the row); the proposer rows
are new ids and go under `- insert:` — a bare `- id:` for an id no layer has
is dropped with a `not found` warning and the proposer never registers. The
proposer runs with cwd = its own work directory, so the script path must be
absolute:

```yaml
- id: loops-null
  config:
    submit: { answer: heads }
- insert:
    - id: proposer-effect-15
      name: '@oldbulb/samsara-proposers/plugin-command'
      inject: [proposers, subprocess, credentials]
      config: { name: effect-15, command: node, args: [/abs/path/to/samsara/packs/synthetic/tools/propose-effect.mjs, --effect, '0.15'] }
    - id: proposer-effect-0
      name: '@oldbulb/samsara-proposers/plugin-command'
      inject: [proposers, subprocess, credentials]
      config: { name: effect-0, command: node, args: [/abs/path/to/samsara/packs/synthetic/tools/propose-effect.mjs, --effect, '0'] }
```

`dsh --profile host --dump-config | grep proposer-effect` lists both rows once
the patch is right.

Then, from the repository root (the ledger is `<cwd>/data/ledger/`), the loop
end to end at zero cost — the same sequence `tests/synthetic.e2e.test.ts` runs
in-process: the A/A control first and the injected effect after it, because a
noise floor belongs to one champion row and the promotion replaces that row.

```sh
# 0. the signer's key, before the host boots: only signoff.pub goes to data/signoff/ (a private key beside it
#    makes the host refuse every proof, E2); without the public key the host refuses every confirm
node packages/signoff/lib/cli.js keygen --out ~/.samsara/signoff && mkdir -p data/signoff && cp ~/.samsara/signoff/signoff.pub data/signoff/

# 1. the noise floor: five same-config reruns of the champion (the pack skill, effect 0)
#    on the held-in set — the set the campaign's rounds anchor on — recorded under its row
dsh --profile host calibrate --pack packs/synthetic --loop null --set holdin --reruns 5 \
    --metric pass_rate --parallel 8 --out data/runs/synthetic-calibrate         # → sd_paired ≈ 0.18

# 2. the A/A control, as rounds: the null diff under its own pre-registered claim; every round its own row
dsh --profile host experiment new --pack packs/synthetic --hypothesis "the null diff does not promote" \
    --metric pass_rate --budget-rounds 20
dsh --profile host campaign --pack packs/synthetic --loop null --experiment <id> --proposer effect-0 \
    --metric pass_rate --set holdin --parallel 8 --rounds 20 --holdout-repeat 6 --auto-holdout \
    --out data/runs/synthetic-aa                                                # → hold, 20 rounds, never promote

# 3. the injected effect: pre-register what is claimed, with a budget, before anything is spent (prints the
#    experiment id); then rounds under it — proposer → smoke → holdin (screen) → holdout at six replicates →
#    decide. The promote verdict waits for a sign-off (--wait); answer it from another shell with the private key
dsh --profile host experiment new --pack packs/synthetic --hypothesis "effect 0.15 promotes" \
    --metric pass_rate --direction up --magnitude 0.15 --budget-rounds 3
dsh --profile host campaign --pack packs/synthetic --loop null --experiment <id> --proposer effect-15 \
    --metric pass_rate --set holdin --parallel 8 --rounds 3 --holdout-repeat 6 --auto-holdout \
    --stop-on-promote --wait 600 --out data/runs/synthetic-inject                # → promote, round 1
node packages/signoff/lib/cli.js confirm --socket data/signoff.sock --key ~/.samsara/signoff/signoff.key \
    --row <challengerId> --action promote --who <name>

# 4. the same A/A as one control round at holdout, on the champion's own snapshot — the promoted one now,
#    so this is a fresh floor on the new champion row, on the held-out set (a floor is per row and per set);
#    then the round closes undecided
dsh --profile host calibrate --pack packs/synthetic --loop null --set holdout --reruns 5 \
    --metric pass_rate --parallel 8 --out data/runs/synthetic-calibrate-holdout
dsh --profile host control aa --pack packs/synthetic --loop null --metric pass_rate --repeat 6 \
    --parallel 8 --out data/runs/synthetic-control                              # → hold

dsh --profile host status      # champion, open rounds, pending consents, noise floors, experiments
```

What to expect: in step 2 every round takes the same path (held-in `hold` on
`power:mde` — 24 entities at one replicate cannot see 0.05 — then the held-out
test: no round ends earlier, "Power" above), the held-out mean sits within
±0.1 of 0 and the verdict is `hold`, twenty times, each round one reveal
("Held-out reveals"). A promotion in step 2 is a false positive, expected at
well under the gate's α because the test also asks for the mean to reach the
SESOI. Step 3's held-in judgement is `hold` on `power:mde` and its held-out
one `promote` on `holdout` with a mean near 0.15. The proposer view of every
round carries `history.jsonl` — the earlier rounds' held-in numbers, never a
held-out one.

After step 3 the champion is the promoted skill (effect 0.15) and the floor
from step 1 stays bound to the old row: a further campaign on the held-in set
stops at once with `no_noise_floor` until `calibrate --set holdin` runs again,
and `effect-0` — which writes `effect: 0` over whatever the champion is — is
then a −0.15 challenger, not the null diff. That is why the A/A comes first.

Each campaign round is its own challenger row because `propose-effect.mjs`
stamps a line into `SKILL.md`; `control aa` copies the champion snapshot
verbatim, so a second `control aa` on the same champion lands on the first's
row and its verdict is not re-recorded (first verdict wins) — seeds of the
null diff go through the campaign. `run` and `challenge` still work as before
for one attempt set or one challenger (`challenge … --set holdout` needs the
floor of step 4), and the tampering loop `tests/synthetic.e2e.test.ts` mounts
shows what a loop that rewrites the snapshot gets: `FAILED` attempts that
never pair.

## From the workbench

The same loop from a `dsh --profile workbench` conversation, as walked through
on 2026-08-26 (the profile patch carries the `loops-null` submission and the two
`proposer-effect-*` rows above; the signer's key lives outside the host
directory):

```
you    /samsara status                                  → champion (none), noise floors 0
you    Calibrate the noise floor for the synthetic pack with the null loop on holdin, 5 reruns.
agent  samsara_calibrate … → Allow? "calibrate synthetic/null on holdin x5: cost unknown (240 attempts)"   [允许一次]
agent  sd_paired 0.1966, 5 × 48 = 240 attempts, all valid
you    /samsara predict new "the null diff does not promote" --pack packs/synthetic --metric pass_rate --direction up --budget-rounds 2 --auto-reveal
you    Start the campaign for experiment <id> with proposer effect-0, 2 rounds.
agent  samsara_campaign_start … → Allow? "2 round(s) … by effect-0, held-out x1 …"   → two rounds, hold:underpowered twice, no promotion
you    /samsara predict new "effect 0.15 promotes" --pack packs/synthetic --metric pass_rate --direction up --magnitude 0.15 --budget-rounds 1 --auto-reveal
you    Start the campaign for experiment <id> with proposer effect-15, 1 round, holdout_replicates 6, stop on promote.
agent  … → Allow? "1 round(s) … by effect-15, held-out x6 … (632 attempts)"   → holdout: promote, Δ 0.141 [0.118, 0.165]
agent  the campaign is paused for consent — please type /samsara approve <challenger-id>
you    /samsara approve <challenger-id> --wait 120
shell  node packages/signoff/lib/cli.js confirm --socket data/signoff.sock --key ~/.samsara/signoff/signoff.key --row <challenger-id> --action promote --who <name>
host   promoted <challenger-id> with consent <consent-id> (round <round-id>)   → servings row, champion section in the profile
```

`holdout_replicates` on `samsara_campaign_start` / `samsara_round` is what
powers the held-out test (6 here: MDE 0.032 against SESOI 0.05); at the default
of one replicate every verdict is `hold:underpowered`, as the A/A rounds show.
After the promotion the floor still belongs to the old champion row, so the next
campaign is refused with `NO_NOISE_FLOOR` until the new champion is calibrated —
the agent's error card says so and quotes the calibration.
