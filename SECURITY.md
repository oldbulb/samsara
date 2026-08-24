# Security

## Reporting

Use GitHub's private vulnerability reporting on this repository
(**Security → Report a vulnerability**). It reaches the maintainer without
disclosing anything publicly. Please do not open a public issue for a
vulnerability first.

Tell us what you did, what happened, and what you expected. A proof of concept
is welcome but not required.

## What is in scope

samsara runs agent processes over evaluation data and decides, from their
results, what configuration a harness serves. The interesting failures are
therefore:

- **Escaping an attempt's confinement** — an attempt or a proposer reading the
  pack's `tasks/`, `data/`, `bin/truth` or `bin/score`, or writing outside its
  workdir.
- **Reaching truth from inside the loop** — anything in the optimization loop
  that can write the book, the gate's verdict, or a sign-off.
- **Forging a sign-off** — the consent proof is an Ed25519 signature over a
  nonce, delivered on a `0600` unix socket; an HTTP request is never a proof.
- **Leaking the holdout** — a path by which raw holdout results reach the
  proposer, rather than the parameter-free signal the book exposes.
- **Credential exposure** — a gateway key reaching a log, an artifact, a ledger
  row or a proposal.

## Known limitations (not vulnerabilities, but know them)

- **macOS does not enforce the filesystem policy.** Landlock is Linux-only; on
  macOS the policy is recorded and `facts.sandbox` says `none`. Treat loop and
  proposer output on a developer machine as untrusted.
- **The proposer process is not confined on every platform** for the same reason.
- A pack command is a subprocess with the environment the operator gives it. A
  malicious pack is outside the trust model: you choose which packs you run.

## Supported versions

Pre-1.0: fixes land on `master` and in the next release. There is no backport
branch yet.
