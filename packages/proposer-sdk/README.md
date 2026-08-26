# @oldbulb/samsara-proposer-sdk

Write a proposer — an optimizer — in TypeScript against samsara's directory-in /
directory-out contract (`examples/proposers/README.md`): load the rendered view,
build a `Proposal`, validate it, write it to the out directory. No dsh, no cordis;
the only dependency is zod. The Python twin is `sdk/py`.

```ts
import { loadView, parseArgs, writeProposal, type Proposal } from '@oldbulb/samsara-proposer-sdk'

const { view: viewDir, out } = parseArgs(process.argv.slice(2))   // --view <dir> --out <dir>
const view = loadView(viewDir)
const failing = view.championScores.filter((s) => s['value'] === 0).map((s) => String(s['task_id']))

// ... derive a new skill directory from view.championSkillDir ...

const proposal: Proposal = {
  surface: 'skill',
  patch: { surface: 'skill', skill_dir: 'skill' },      // rewritten to <out>/skill when skillDir is given
  intent: 'one paragraph: what changed and why',
  prediction: { metric: view.metric, direction: 'up', predicted_fixes: failing.slice(0, 3), at_risk: [] },
}
writeProposal(out, proposal, { skillDir: newSkillDir })
```

## API

| export | what |
|---|---|
| `VIEW_VERSION` | `1` |
| `loadView(dir): View` | reads `view.json` (falls back to `champion.json` + the directory listing) and every `*.jsonl` into arrays of records; `championSkillDir` is absolute; `environment` / `proposalSchema` are `undefined` when the host wrote none |
| `Proposal`, `proposalSchema` | the zod schema of what you write (`surface`, `patch`, `intent`, `prediction`, optional `parent`); structurally identical to the host's draft schema in `@oldbulb/samsara-proposers` — `tests/parity.test.ts` keeps them aligned |
| `validateProposal(p): Proposal` | throws `ProposalError` |
| `writeProposal(outDir, p, { skillDir? })` | validates, copies `skillDir` to `<out>/skill` and rewrites `patch.skill_dir`, writes `proposal.json`; returns its path |
| `parseArgs(argv): { view, out, rest }` | the `--view` / `--out` convention |
| `SURFACES`, `DIRECTIONS`, `predictionSchema`, `skillPatchSchema`, `rowsPatchSchema`, `patchSchema` | the pieces |

`view.tasks` rows are opaque beyond `task_id`, `entity_key` and `stratum`; the
prediction may name only task ids that appear there.

## Tests

`pnpm --filter @oldbulb/samsara-proposer-sdk test` — round trip on
`tests/fixtures/view` and the schema-parity check. Offline.
