---
"@oldbulb/samsara-gate-catalog": minor
---

New package: the acceptance rules of the RSI literature (`keep-better`, `hillclimb`, `dgm-keep-better`, `self-harness`, `rsea`, `ladder`, `miller`, `normal-one-sided`, `mcnemar`, `pace`, `hcl-commit`) as gate policies for `ctx.gate`, each computing the same `Compare` statistics as gate-default and deciding only the verdict, and a bench that measures any policy's null rate and power on recorded attempts. The `plugin` module mounts a chosen subset as shadow policies from a `policies: [...]` config, so "our gate versus theirs" is a number a profile can regenerate.
