---
"@oldbulb/samsara-champion": minor
---

`promote` requires the verdict to come from the promotion gate mounted on `ctx.gate` and re-verifies the consent row's proof against the sign-off public key before acting, so a row inserted into the ledger by hand is refused. `demote(challengerId)` only rewrites the profile (`NOT_KEPT` otherwise); the `reversed` verdict is the lifecycle's write. `rescored` gives way to the pure `compareRowOf(challengerId, judgement, slot, kept)`; the serving history is the lifecycle's write too.
