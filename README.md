# samsara

English | [中文](README.zh.md)

A recursive self-improvement framework for agent harnesses, built as a
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) bundle.

**Every change to the harness is a challenger.** It is evaluated in a disposable
child scope, judged only by truth that comes from outside the optimization loop,
promoted to champion only through a statistical gate, and adopted only after a
human signs off through a channel the loop cannot reach.

What changes is the harness, not the weights: v1 opens four surfaces — the
skill, prompt sections, memory, and tool configuration. Evaluation artifacts and
the three fixed points are never surfaces.

## The three fixed points

Everything in samsara is replaceable except three things, and they are outside
the loop by construction:

| | | |
|---|---|---|
| **book** | truth | task sets, settlement, holdout visibility and budget |
| **gate** | the verdict | statistics decide promotion; the loop cannot write it |
| **sign-off** | consent | an Ed25519 signature over a nonce on a `0600` unix socket — an HTTP request is never a proof |

The optimizer itself may be optimized. The judge and the right to sign may not.

Mechanism is fixed, policy is pluggable: the statistical test, the optimization
algorithm, the evaluation logic and the consent channel are all plugins, strict
by default, and the ledger records which one produced each verdict.

## How a round works

```
proposer  →  challenger  →  disposable child scope  →  attempts on a task set
                                    │                        │
                            diff scan rejects           pack commands
                            out-of-surface patches      (subprocesses) return truth
                                    │                        │
                                    └────→  gate  ←──────────┘
                                             │
                                   verdict + ledger row
                                             │
                                    human sign-off
                                             │
                                    champion (profile patch rewritten, hot-applied)
```

A **pack** is what supplies reality: tasks, truth, and a score. The framework
knows nothing about any domain — it talks to a pack only through `pack.yaml` and
the stdout of the pack's commands, which are always subprocesses, never imports.
`packs/coding-tasks` (82 Exercism exercises in Python and JavaScript, from the
Aider polyglot benchmark) is the one that ships.

A **loop** is one attempt of one task under one configuration. Two ship: dsh's
own in-process agent, and Claude Code as a subprocess. Adding a third is a
package and one row in a patch file.

The Claude Code loop is **off by default**: it needs `@anthropic-ai/claude-agent-sdk`,
which is proprietary, so it is an optional peer dependency and its row ships
disabled. Install the SDK into your profile and flip the row to use it. Nothing
else in samsara depends on it.

## Install

samsara is a dsh bundle plus a profile. You need the dsh CLI, Node ≥ 22.19 and
pnpm 11.7.

```sh
npm i -g @deepseek-ai/dsh@0.1.1-rc.2
# the ledger uses sqlite, which the CLI does not ship — install it into the CLI,
# not into your profile (a second copy of dsh-storage there shadows the CLI's own)
cd "$(npm root -g)/@deepseek-ai/dsh" && npm i @deepseek-ai/dsh-storage-sqlite@0.1.1-rc.2

dsh plugin --profile host add @oldbulb/samsara
dsh --profile host --dump-config | grep samsara     # the composed tree should list its rows
```

Then give the profile its deployment facts — the gateway URL and the credential
*reference* (never a secret) — by copying
[`profiles/host/cordis.patch.example.yml`](profiles/host/cordis.patch.example.yml)
to `cordis.patch.yml` in your profile directory.

### From a checkout

```sh
git clone https://github.com/oldbulb/samsara.git && cd samsara
pnpm install && pnpm build && pnpm test    # 270 tests, entirely offline: no model, no gateway
ops/leak-scan.sh                           # the framework must not know any domain
dsh plugin --profile host install          # links this checkout into the host profile
```

## Run

```sh
# attempts — the null loop calls no model at all
dsh --profile host run --pack packs/coding-tasks --loop null --set smoke --limit 2 --out data/runs/x

# one challenger, end to end: diff scan → scope → attempts → gate → ledger
dsh --profile host challenge --pack packs/coding-tasks --loop null --set holdin --limit 2 \
    --surface skill --skill-dir <dir> --intent "..." --metric pass_rate --with-champion

# one round: a proposer writes the challenger, then the same pipeline
dsh --profile host round --pack packs/coding-tasks --loop dsh --proposer claude-p \
    --set smoke --limit 2 --metric pass_rate --with-champion

# promotion needs a signature, delivered on a unix socket
node packages/signoff/lib/cli.js keygen --out data/signoff
dsh --profile host promote <challengerId> --wait 60 &
node packages/signoff/lib/cli.js confirm --socket data/signoff.sock \
    --key data/signoff/signoff.key --row <challengerId> --action promote --who <name>

dsh --profile host serve      # read-only /samsara page: champion, settlements, challengers, sign-offs
dsh --profile host certify --pack packs/coding-tasks --skill-dir <dir> --loops dsh,claude-code \
    --set smoke --limit 2 --metric pass_rate      # does the skill hold across harnesses?

dsh --profile host run --pack packs/coding-tasks --loop dsh --set holdin --limit 32 --parallel 16 --out data/runs/x
dsh --profile host run --resume data/runs/x       # durable steps: only attempts without a marker re-run
dsh --profile host export --run data/runs/x --format otlp-json --out data/runs/x.otlp.json
```

> The ledger path is relative to the working directory
> (`<cwd>/data/ledger/samsara_ledger.sqlite`), so every `run` from the repository
> root writes to that one real ledger. Run from elsewhere to try things out.

## Packages

Published under the `@oldbulb` scope; the bundle is `@oldbulb/samsara` and each
concept is one package.

| | |
|---|---|
| `kernel` | the only package that imports dsh by path — re-pinning dsh is a one-file change |
| `pack` · `book` | the pack contract, and truth: task sets, settlement, holdout budget |
| `loops` · `loops-dsh` · `loops-claude-code` | the loop seam and its two providers |
| `workdir` · `submit` · `sandbox` · `scope` | sealed attempt directories, the submit tool, filesystem policy, disposable scopes with the diff scan |
| `gate` · `ledger` | the verdict seam with `gate-default`, and the append-only record |
| `champion` · `signoff` | the served configuration as a content-addressed alias, and consent proofs |
| `proposers` · `runner` · `ui` | proposal adapters, the commands, the read-only page |

## Documentation

| | |
|---|---|
| [`docs/design/philosophy.md`](docs/design/philosophy.md) | why the three fixed points sit outside the loop, and what follows |
| [`docs/design/architecture.md`](docs/design/architecture.md) | layout, seams, the 13 surfaces, the pack contract, the ledger model, hard constraints E1–E8 / S1–S8 |
| [`docs/design/packs.md`](docs/design/packs.md) | the pack contract, and what a second pack needs |
| [`docs/design/gate.md`](docs/design/gate.md) · [`loops.md`](docs/design/loops.md) · [`proposers.md`](docs/design/proposers.md) | the seams in detail |
| [`docs/dsh-plugin-notes.md`](docs/dsh-plugin-notes.md) | writing dsh plugins: the mental model, the pitfalls we hit, the patterns that worked (in Chinese) |

## Status

Pre-1.0 and honest about it. Both loops run on the Aider polyglot set; gate,
ledger, scope, sign-off, champion and proposer are verified end to end; a real
`claude -p` proposal round completes.

Known limitations:

- **The gate has never been falsified.** On the current task set the model's
  pass rate is 1.0 with a measured noise floor of zero, so no positive control
  has promoted. A harder task set is the next thing that matters.
- The `live` tier (mSPRT on production traffic) is not implemented.
- Landlock is Linux-only: on macOS the filesystem policy is recorded but not
  enforced, and the proposer process is unconfined.
- A SIGINT can lose a few ledger writes; `attempts.jsonl` stays complete and
  `run --resume` rebuilds from it.

## Contributing and license

[`CONTRIBUTING.md`](CONTRIBUTING.md) — what fits, how to set up, the house rules,
and the DCO sign-off that is the whole agreement.
[`SECURITY.md`](SECURITY.md) · [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) ·
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

MIT — see [`LICENSE`](LICENSE).
