---
"@oldbulb/samsara-kernel": minor
---

The kernel re-exports the interaction seams the workbench sits on — `ctx.commands` (dsh-commands), `ctx.approval` (dsh-user-approval), `defineTool` and the tool argument types (dsh-tools), `dshHomePath` — and mirrors the jobs seam structurally until `@deepseek-ai/dsh-jobs` is in the pinned store. Still the only package that imports dsh by path.
