# samsara-proposer (Python SDK)

Write a proposer — an optimizer — in Python against samsara's directory-in /
directory-out contract (`examples/proposers/README.md`). Standard library only;
the API mirrors `@oldbulb/samsara-proposer-sdk` (TypeScript).

No build is needed: put `sdk/py` on `sys.path` (or `pip install -e sdk/py`).

```python
import sys
sys.path.insert(0, "/path/to/samsara/sdk/py")
from samsara_proposer import Proposal, load_view, parse_args, write_proposal

args = parse_args(sys.argv[1:])            # --view <dir> --out <dir>; the rest is yours
view = load_view(args.view)                # champion skill, tasks, attempts, scores, compares, environment
failing = [s["task_id"] for s in view.champion_scores if s.get("value") == 0]

# ... derive a new skill directory from view.champion_skill_dir ...

write_proposal(args.out, Proposal(
    surface="skill",
    patch={"surface": "skill", "skill_dir": "skill"},   # rewritten to <out>/skill when skill_dir= is given
    intent="one paragraph: what changed and why",
    prediction={"metric": view.metric, "direction": "up", "predicted_fixes": failing[:3], "at_risk": []},
), skill_dir=new_skill_dir)
```

## API

| name | what |
|---|---|
| `VIEW_VERSION` | `1` |
| `load_view(dir) -> View` | reads `view.json` (falls back to `champion.json` + the directory listing) and every `*.jsonl` into lists of dicts; `champion_skill_dir` is absolute; `environment` / `proposal_schema` are `None` when the host wrote none |
| `Proposal(surface, patch, intent, prediction, parent=None)` | dataclass of what you write; `to_dict()` |
| `validate_proposal(p) -> dict` | the same required keys and enum values as the TS schema (`SURFACES`, `DIRECTIONS`); raises `ProposalError` |
| `write_proposal(out_dir, proposal, skill_dir=None) -> path` | validates, copies `skill_dir` to `<out>/skill` and rewrites `patch.skill_dir`, writes `proposal.json` |
| `parse_args(argv) -> ProposerArgs(view, out, rest)` | the `--view` / `--out` convention |

`view.tasks` rows are opaque beyond `task_id`, `entity_key` and `stratum`; the
prediction may name only task ids that appear there.

## Tests

The Python example (`examples/proposers/noop.py`) runs through the host's
`CommandAdapter` in `packages/proposers/tests/command.test.ts` whenever
`python3` is on `PATH`; nothing here touches the network.
