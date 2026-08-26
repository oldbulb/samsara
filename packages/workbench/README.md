# @oldbulb/samsara-workbench

dsh as the place where RSI experiments are run. This package is the host-plane rows and the operator preset that turn a `dsh-web-app` conversation into a samsara workbench: the agent drives samsara through `samsara_*` tools, `/samsara …` commands are the only place consent happens, the ledger is the record. Design: `docs/design/workbench.md`.

## Layout

| module | what |
|---|---|
| `@oldbulb/samsara-workbench` | the bundle: a `cordis.patch.yml` that disables the CLI startup rows and inserts the rows below |
| `@oldbulb/samsara-workbench/commands` | the `/samsara …` commands on `ctx.commands` (global) |
| `@oldbulb/samsara-workbench/tools` | the `samsara_*` tools; mounted inside the operator preset, so only its agents see them |
| `@oldbulb/samsara-workbench/executor` | the attempt executor `ctx.lifecycle` runs through (the runner's `runSet`), for the life of the host |
| `@oldbulb/samsara-workbench/notebook` | mirrors `samsara_*` tool calls and results (failures marked), the approvals they asked, and `samsara` commands into the ledger's `notebook` table; the tools add a `job/done` row when a job settles |
| `@oldbulb/samsara-workbench/presets` | the `samsara-operator` preset directory and its installer |
| `@oldbulb/samsara-workbench/startup` | lists rounds left `open` + `running` on start; `/samsara reconcile <round-id>` closes one aborted (never automatic: the round may be another host's live one) |
| `@oldbulb/samsara-workbench/errors` | every `LifecycleError` code and every `LedgerError` code as a sentence and a next action (`NO_NOISE_FLOOR` → "calibrate first: samsara_calibrate … ≈ $x"); every tool throws through it, every refusal and error card renders through it, so no bare code reaches the agent or the person |

## Install

The workbench is a second profile beside `host`: the samsara CLI's startup row and dsh's web bundle cannot share one profile, so the CLI stays in `host` and the conversation lives in `workbench`. Both write the same ledger.

```sh
# the dsh CLI and its sqlite storage, as for `host` (see the repository README).
# The packages are not on npm yet, so the profile is the checkout's own
# profiles/workbench, linked into dsh's profile directory ($DSH_HOME, default
# ~/.dsh). Its package.json lists dsh-base first (it holds the host rows the
# workbench injects: agent, session, tools, commands, jobs, approval,
# agent-default-model), dsh-web-app as the UI over it, then the two samsara
# bundles. Once published: `dsh plugin --profile workbench add @deepseek-ai/dsh-base
# @deepseek-ai/dsh-web-app @oldbulb/samsara @oldbulb/samsara-workbench`.
ln -s "$PWD/profiles/workbench" ~/.dsh/profiles/workbench
dsh plugin --profile workbench install

# the composed tree: no `not found` warning (every patched row exists), every
# id once (the loader rejects a duplicate before it reads `disabled`), the
# base rows present, the workbench rows inserted, the CLI rows disabled
dsh --profile workbench --dump-config 2>&1 | grep -c 'not found'        # 0
dsh --profile workbench --dump-config 2>/dev/null | grep -E '^\s*- id:' | sort | uniq -d   # nothing
dsh --profile workbench --dump-config 2>/dev/null | grep -E '^- id: (agent|commands|jobs|approval|tools|session|agent-default-model|workbench-|samsara-run)'
```

The samsara bundle brings its own storage hub, domain facility and webserver
for the `host` profile; `dsh-web-app` brings all three under the ids `storage`,
`storage-domain` and `webserver`, so the samsara rows carry their own ids
(`samsara-storage`, `samsara-storage-domain`, `samsara-webserver`) and the
workbench patch disables them, keeps the bundle's `storage-sqlite` backend row
and routes the ledger domain to it through `dsh-web-app`'s facility
(`storage-domain: { backend: json, routes: { samsara_ledger: sqlite } }`). Both
profiles therefore write the same sqlite ledger file.

From a checkout: `profiles/workbench/package.json` links the packages; `pnpm install && pnpm build` then `dsh plugin --profile workbench install`. Copy `profiles/host/cordis.patch.yml`'s route rows into `profiles/workbench/cordis.patch.yml` — the deployment facts are the same file shape.

On first boot the `workbench-presets` row copies the shipped `samsara-operator` preset into `$DSH_HOME/.agent-presets/samsara-operator` and leaves a `.samsara-preset-sha` marker; it recopies when the shipped hash changes and never overwrites a directory without the marker. `agent-presets.default` is set to `samsara-operator` by the bundle patch, so a new conversation starts on the operator preset with only the `samsara_*` tools, `job_*`, `ask_user` and `todo` — no shell, no filesystem, no web.

The check that the rows compose, recorded as W1's required proof, is the
`--dump-config` triple above; `tests/bundle.test.ts` runs the same composition
over a reduced copy of the dsh-base and dsh-web-app patches
(`tests/fixtures/dsh-layers.yml`, refreshed by hand on a re-pin). The profile
was also booted (`dsh --profile workbench --no-open --port 0`): the loader
mounts every row, the ledger opens on sqlite, the preset is installed.

## An example conversation

```
you      /samsara status
host     champion c3f1… (skill@a91e). No noise floor for coding-tasks/dsh on pass_rate.
you      calibrate the champion on holdin
agent    samsara_calibrate { pack: coding-tasks, loop: dsh, set: holdin, reruns: 3 }
host     Allow? calibrate ≈ $2.10 (249 attempts)                       [Allow] [Refuse]
agent    job j-17 started; I will report sd_paired when it completes.  → /samsara/noise_floors
you      /samsara predict new "a tighter skill raises pass_rate" --metric pass_rate --direction up --budget-rounds 3   (add --auto-reveal to consent to the held-out reveals here, once, instead of /samsara reveal per round)
host     experiment e-8b2c… registered. samsara_campaign_start { experiment_id: e-8b2c…, proposer: claude-p, rounds: 3 }
you      run it
agent    samsara_campaign_start …  → Allow? campaign ≈ $9.40 (3 rounds, 498 attempts) [Allow]
agent    round r-02 judged hold:underpowered at holdin (Δ 0.04, MDE 0.14); next: replicate ×3 ≈ $2.10, or drop.
agent    round r-02 held at holdin; the campaign is paused for the held-out reveal — please type /samsara reveal 5c1e…
you      /samsara reveal 5c1e… --wait 60          (sign the nonce; then "run it" again on the same experiment)
agent    round r-03: promote at holdout (Δ 0.16, CI [0.05, 0.27]); the campaign is paused for consent — please type /samsara approve 7d40…
you      /samsara approve 7d40… --wait 60      (then sign the nonce with the signoff CLI on the socket)
host     serving s-12: champion 7d40… from 2026-08-26T10:41Z, consent k-3a.
```

Every number the agent says came from a tool result and is in the notebook; the approval and the signature are the person's, on two different channels.

## Run

```
pnpm vitest run packages/workbench/tests
pnpm exec tsc -b packages/workbench/tsconfig.json
```

Tests use fakes for `lifecycle`, `ledger`, `jobs` and `approval`; nothing touches a model, the network or a real dsh session.
