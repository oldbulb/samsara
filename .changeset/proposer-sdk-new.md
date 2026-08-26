---
"@oldbulb/samsara-proposer-sdk": minor
---

New package: write a proposer in TypeScript against the directory-in / directory-out contract — `parseArgs` for `--view` / `--out`, `loadView` for the rendered view, a validated `Proposal` type, `writeProposal` that copies a skill directory into the out directory and rewrites the patch to point at it. No dsh, no cordis; zod is the only dependency. The Python twin lives in `sdk/py`.
