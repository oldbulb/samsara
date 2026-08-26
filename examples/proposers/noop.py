#!/usr/bin/env python3
"""The no-op proposer: returns the champion skill unchanged.

Conformance check for the command contract (README.md in this directory) —
run it through the host to prove the wiring before spending anything on a
model. Standard library plus the SDK from ../../sdk/py.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "sdk", "py"))

from samsara_proposer import Proposal, load_view, parse_args, write_proposal  # noqa: E402


def main(argv):
    args = parse_args(argv)
    view = load_view(args.view)
    print(f"noop: champion {view.champion_id}, {len(view.tasks)} tasks, metric {view.metric}", file=sys.stderr)
    path = write_proposal(
        args.out,
        Proposal(
            surface="skill",
            patch={"surface": "skill", "skill_dir": "skill"},
            intent="no-op conformance proposal",
            prediction={"metric": view.metric, "direction": "up", "predicted_fixes": [], "at_risk": []},
        ),
        skill_dir=view.champion_skill_dir,
    )
    print(f"noop: wrote {path}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
