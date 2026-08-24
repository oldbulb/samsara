# Contributing

Thanks for looking. samsara is young and the fastest way to help is to use it on
something we did not think of — a pack in another language, a loop provider for
another agent harness, a gate policy with different statistics.

## What fits well

- **A pack.** The framework knows nothing about any domain; it talks to a pack
  through `pack.yaml` and the stdout of the pack's commands. If you can express
  "here are tasks, here is truth, here is a score", you can plug it in. Start
  from `packs/coding-tasks` and `docs/design/packs.md`.
- **A loop provider.** One attempt of one task under one configuration. The seam
  is `docs/design/loops.md`; `@oldbulb/samsara-loops-dsh` (in-process) and
  `@oldbulb/samsara-loops-claude-code` (subprocess) are the two shapes.
- **A gate policy.** `gate-default` is one policy behind a registry. A different
  test, a different exposure rule, a different early-stopping story — mount it
  and the ledger records which one produced the verdict.
- **Bugs, and places the docs lie.** Especially anything platform-specific: the
  project is developed on macOS and tested on Linux in CI, and that gap has bitten
  us before.

## What is deliberately not open for change

The three fixed points — the book (truth), the gate, and sign-off — sit outside
the optimization loop. A change that lets anything inside the loop write them is
not a feature; see `docs/design/philosophy.md`. Everything else is fair game,
including the optimizer.

## Setup

```sh
pnpm install
pnpm build
pnpm test                      # offline: no model, no gateway, no private data

# once, if you want the coding-tasks e2e to run for real
python3 -m venv packs/coding-tasks/runtime/py/.venv
packs/coding-tasks/runtime/py/.venv/bin/pip install -r packs/coding-tasks/runtime/py/requirements.txt
pnpm --dir packs/coding-tasks/runtime/js install --frozen-lockfile
```

To run the host itself you also need the dsh CLI and a profile; `ops/README.md`
has the install notes, including the two ways it goes wrong.

## House rules

- **The framework does not know any domain.** No table name, column name,
  business word or concrete metric name in `packages/`. `ops/leak-scan.sh` is the
  check, and CI runs it.
- **The framework and a pack talk only through `pack.yaml` and command stdout.**
  No imports across that line; pack commands are always subprocesses.
- **dsh enters through one package.** Only `@oldbulb/samsara-kernel` imports dsh
  by path, so re-pinning is a one-file change.
- **Every side effect goes through `ctx.effect`.** Routes, registry entries,
  timers, storage domains, child processes — otherwise disposal leaks them.
- Commits and code in English, present tense, saying what changed and why.
- New behaviour comes with a test that fails without it. Tests stay offline.

## Submitting

Fork, branch, open a pull request. Sign your commits off (`git commit -s`) to
certify the [Developer Certificate of Origin](https://developercertificate.org/)
— that is the whole agreement, there is no CLA.

CI must be green: build, the offline test suite, and the leak scan.
