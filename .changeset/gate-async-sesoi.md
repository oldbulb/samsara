---
"@oldbulb/samsara-gate": minor
---

The seam is async end to end: a policy's `judge` may return a promise (one that waits on a subprocess or a service), and `GateRegistry.judge` resolves to the judgement. `gate-default` moves to 0.2.0: `policy.mde` is the SESOI (absent means significance alone promotes; `pack.holdout.mde` supplies it), the MDE from the noise floor divides by `sqrt(nEff * replicates)` so re-judging over more replicates tightens it, and the holdout rotation config is recorded on the verdict row and consumed by nothing. New `command` / `plugin-command` modules run a gate written in any language as a subprocess (`CompareRequest` JSON on stdin, `GateJudgement` JSON on stdout) without blocking the host's event loop; the spec module carries the contract they are validated against.
