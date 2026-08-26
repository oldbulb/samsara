---
"@oldbulb/samsara": minor
---

The bundle now mounts the whole control plane, not just the loops and the runner: sqlite storage under the bundle's own ids (`samsara-storage`, `storage-sqlite`, `samsara-storage-domain`, so a profile that also loads dsh-web-app can disable them and route the ledger domain through its own facility), the ledger, the gate, the lifecycle service, the champion, sign-off, the proposers and the UI. `cordis.patch.yml` carries commented rows for the things a profile typically adds — the gate catalog as shadow policies, a subprocess gate in any language, a command proposer — and the README lists every config key a deployment pins (`storage-sqlite.config.path`, the sign-off socket and public key, the champion's profile dir, the web port). Two profile templates ship beside it: `host` for the CLI, and the new `workbench` that loads `@oldbulb/samsara-workbench` over dsh-web-app; both write the same ledger.
