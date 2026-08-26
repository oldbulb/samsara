---
"@oldbulb/samsara-workbench": minor
---

New package: dsh as the place where RSI experiments are run. A second bundle over dsh-web-app that gives the operator preset its `samsara_*` tools (calibrate, propose, campaign, control, status, …), the `/samsara …` commands as the only place consent happens (`approve`, `predict --auto-reveal`, `budget`, `reconcile`), a notebook that mirrors every tool call, approval and command into the ledger, a startup check that lists rounds left open by a dead host, and a table that turns every `LifecycleError` and `LedgerError` code into a sentence and the next action, so no bare code reaches the conversation.
