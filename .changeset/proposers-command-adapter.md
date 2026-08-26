---
"@oldbulb/samsara-proposers": minor
---

A third adapter, `command`: any executable as a proposer, spawned as `<command> [args…] --view <dir> --out <dir>` through the kernel's subprocess seam with an allow-listed environment and one credential injected under one variable, writing `proposal.json` (and a skill directory) into the out directory. Mounted from `@oldbulb/samsara-proposers/plugin-command` with one row per proposer under its own `name`; the adapter stamps `parent` and `proposer` (name, version, `config_sha`) and rejects on non-zero exit, timeout and abort.
