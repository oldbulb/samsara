---
"@oldbulb/samsara-signoff": minor
---

`request(rowId, action, { roundId? })` binds a `promote` to the round it decides, and the signed payload carries `roundId`. The service enforces the key split it can see: while a `signoff.key` sits beside the public key on the host, every proof is refused (`KEY_ON_HOST`). Consents store the proof itself, and `verifyConsent` re-checks a stored row against the public key. `SIGNOFF_ACTIONS` mirrors the ledger's consent actions (`demote`, `gate_change`, `holdout_reveal`, …), and the CLI accepts `--row <name@version>` for a gate change.
