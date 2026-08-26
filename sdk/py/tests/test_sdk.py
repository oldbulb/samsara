"""Round trip on the TypeScript SDK's fixture view; the same required keys and
enum values as the TS schema. Run: python3 -m unittest discover sdk/py/tests"""

import json
import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))
FIXTURE = os.path.join(HERE, "..", "..", "..", "packages", "proposer-sdk", "tests", "fixtures", "view")

from samsara_proposer import (  # noqa: E402
    DIRECTIONS,
    SURFACES,
    VIEW_VERSION,
    Proposal,
    ProposalError,
    ViewError,
    load_view,
    parse_args,
    validate_proposal,
    write_proposal,
)

GOOD = {
    "surface": "skill",
    "patch": {"surface": "skill", "skill_dir": "/elsewhere"},
    "intent": "Tighten the checklist.",
    "prediction": {"metric": "pass", "direction": "up", "predicted_fixes": ["t2"], "at_risk": ["t1"]},
}


class LoadViewTest(unittest.TestCase):
    def test_reads_the_fixture(self):
        view = load_view(FIXTURE)
        self.assertEqual(view.view_version, VIEW_VERSION)
        self.assertEqual(view.champion_id, "ch-champion")
        self.assertEqual(view.metric, "pass")
        self.assertTrue(os.path.exists(os.path.join(view.champion_skill_dir, "SKILL.md")))
        self.assertEqual([t["task_id"] for t in view.tasks], ["t1", "t2", "t3"])
        self.assertEqual(len(view.champion_attempts), 3)
        self.assertEqual([s["task_id"] for s in view.champion_scores if s["value"] == 0], ["t2", "t3"])
        self.assertEqual((view.compares[0]["redacted"], view.compares[0]["ladder"]), (True, {"beat_best": False, "best_so_far": 0.05}))
        self.assertNotIn("mean", view.compares[0])
        self.assertIn("demo-loop", view.environment)
        self.assertEqual(view.proposal_schema["required"], ["surface", "patch", "intent", "prediction"])

    def test_infers_the_header_without_view_json(self):
        root = tempfile.mkdtemp()
        shutil.copytree(FIXTURE, root, dirs_exist_ok=True)
        os.remove(os.path.join(root, "view.json"))
        os.remove(os.path.join(root, "environment.md"))
        view = load_view(root)
        self.assertEqual(view.champion_id, "ch-champion")
        self.assertIn("tasks.jsonl", view.files)
        self.assertIsNone(view.environment)

    def test_rejects_bad_input(self):
        with self.assertRaises(ViewError):
            load_view(os.path.join(FIXTURE, "nope"))
        root = tempfile.mkdtemp()
        shutil.copytree(FIXTURE, root, dirs_exist_ok=True)
        with open(os.path.join(root, "tasks.jsonl"), "w") as f:
            f.write('{"task_id":"t1"}\nnot json\n')
        with self.assertRaisesRegex(ViewError, "tasks.jsonl:2"):
            load_view(root)


class ValidateProposalTest(unittest.TestCase):
    def test_accepts_skill_and_rows(self):
        self.assertEqual(validate_proposal(GOOD), GOOD)
        self.assertEqual(validate_proposal(Proposal(**GOOD, parent="ch-x"))["parent"], "ch-x")
        rows = dict(GOOD, surface="prompt", patch={"surface": "prompt", "rows": [{"id": "r1"}]})
        self.assertEqual(validate_proposal(rows)["surface"], "prompt")

    def test_enums_match_the_ts_schema(self):
        self.assertEqual(SURFACES, ("skill", "prompt", "memory", "tools", "runtime", "route", "context"))
        self.assertEqual(DIRECTIONS, ("up", "down"))

    def test_rejects(self):
        for key in ("surface", "patch", "intent", "prediction"):
            bad = {k: v for k, v in GOOD.items() if k != key}
            with self.assertRaises(ProposalError):
                validate_proposal(bad)
        cases = [
            dict(GOOD, prediction={"metric": "pass", "direction": "sideways"}),
            dict(GOOD, surface="weights", patch={"surface": "weights", "rows": [{}]}),
            dict(GOOD, surface="prompt"),
            dict(GOOD, patch={"surface": "prompt", "rows": []}),
            dict(GOOD, extra=1),
            dict(GOOD, proposer={"name": "x", "version": "1", "config_sha": "a" * 64}),
            dict(GOOD, prediction=dict(GOOD["prediction"], predicted_fixes=["", "t1"])),
        ]
        for bad in cases:
            with self.assertRaises(ProposalError):
                validate_proposal(bad)


class WriteProposalTest(unittest.TestCase):
    def test_copies_the_skill_and_rewrites_skill_dir(self):
        view = load_view(FIXTURE)
        out = os.path.join(tempfile.mkdtemp(), "out")
        path = write_proposal(out, Proposal(**GOOD), skill_dir=view.champion_skill_dir)
        self.assertEqual(path, os.path.join(out, "proposal.json"))
        with open(os.path.join(out, "skill", "SKILL.md")) as a, open(os.path.join(view.champion_skill_dir, "SKILL.md")) as b:
            self.assertEqual(a.read(), b.read())
        with open(path) as f:
            written = json.load(f)
        self.assertEqual(written, dict(GOOD, patch={"surface": "skill", "skill_dir": "skill"}))
        with self.assertRaises(ProposalError):
            write_proposal(out, dict(GOOD, intent=""))
        with self.assertRaisesRegex(ProposalError, "SKILL.md"):
            write_proposal(out, GOOD, skill_dir=os.path.join(FIXTURE, "nope"))


class ParseArgsTest(unittest.TestCase):
    def test_both_spellings_and_rest(self):
        a = parse_args(["--model", "m", "--out=/o", "--view", "/v", "x"])
        self.assertEqual((a.view, a.out, a.rest), ("/v", "/o", ["--model", "m", "x"]))
        with self.assertRaisesRegex(ValueError, "--out"):
            parse_args(["--view", "/v"])
        with self.assertRaisesRegex(ValueError, "--view needs"):
            parse_args(["--view"])


if __name__ == "__main__":
    unittest.main()
