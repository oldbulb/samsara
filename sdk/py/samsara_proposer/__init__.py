"""samsara_proposer — write a proposer in Python against the directory-in /
directory-out contract (examples/proposers/README.md): load the rendered view,
build a Proposal, validate it, write it to the out directory.

Standard library only. The proposal shape mirrors the host's draft schema
(packages/proposers/src/types.ts) and the TypeScript SDK
(packages/proposer-sdk); the required keys and enum values below are the same.
"""

from __future__ import annotations

import json
import math
import os
import shutil
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence

__all__ = [
    "VIEW_VERSION",
    "SURFACES",
    "DIRECTIONS",
    "View",
    "ViewError",
    "Proposal",
    "ProposalError",
    "load_view",
    "validate_proposal",
    "write_proposal",
    "parse_args",
]

VIEW_VERSION = 1

VIEW_FILE = "view.json"
CHAMPION_FILE = "champion.json"
CHAMPION_SKILL_DIR = "champion-skill"
TASKS_FILE = "tasks.jsonl"
CHAMPION_ATTEMPTS_FILE = "champion-attempts.jsonl"
CHAMPION_SCORES_FILE = "champion-scores.jsonl"
COMPARES_FILE = "compares.jsonl"
ENVIRONMENT_FILE = "environment.md"
PROPOSAL_SCHEMA_FILE = "proposal.schema.json"
PROPOSAL_FILE = "proposal.json"
SKILL_DIR = "skill"

SURFACES = ("skill", "prompt", "memory", "tools", "runtime", "route", "context")
DIRECTIONS = ("up", "down")

PROPOSAL_KEYS = ("parent", "surface", "patch", "intent", "prediction")
PROPOSAL_REQUIRED = ("surface", "patch", "intent", "prediction")
PREDICTION_KEYS = ("metric", "direction", "magnitude", "predicted_fixes", "at_risk")
PREDICTION_REQUIRED = ("metric", "direction")


# ---------------------------------------------------------------------- view


class ViewError(Exception):
    pass


@dataclass
class View:
    dir: str
    view_version: int
    champion_id: str
    metric: str
    files: List[str]
    champion_skill_dir: str
    tasks: List[Dict[str, Any]] = field(default_factory=list)
    champion_attempts: List[Dict[str, Any]] = field(default_factory=list)
    champion_scores: List[Dict[str, Any]] = field(default_factory=list)
    compares: List[Dict[str, Any]] = field(default_factory=list)
    environment: Optional[str] = None
    proposal_schema: Optional[Any] = None


def _read_json(path: str) -> Any:
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except ValueError as e:
        raise ViewError(f"{path} is not JSON: {e}") from e


def _read_jsonl(path: str) -> List[Dict[str, Any]]:
    if not os.path.exists(path):
        return []
    rows: List[Dict[str, Any]] = []
    with open(path, encoding="utf-8") as f:
        for n, line in enumerate(f, 1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except ValueError as e:
                raise ViewError(f"{path}:{n} is not JSON: {e}") from e
            if not isinstance(value, dict):
                raise ViewError(f"{path}:{n} is not an object")
            rows.append(value)
    return rows


def _read_text(path: str) -> Optional[str]:
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as f:
        return f.read()


def load_view(dir: str) -> View:
    """Load a rendered view directory; `view.json` is optional (inferred from `champion.json` and the files present)."""
    root = os.path.abspath(dir)
    if not os.path.isdir(root):
        raise ViewError(f"{root} is not a directory")
    champion_path = os.path.join(root, CHAMPION_FILE)
    champion = _read_json(champion_path) if os.path.exists(champion_path) else None
    if champion is not None and not (isinstance(champion, dict) and all(isinstance(champion.get(k), str) and champion[k] for k in ("challenger_id", "skill", "metric"))):
        raise ViewError(f"{champion_path}: expected challenger_id, skill and metric")
    header_path = os.path.join(root, VIEW_FILE)
    if os.path.exists(header_path):
        header = _read_json(header_path)
        if not isinstance(header, dict) or not isinstance(header.get("view_version"), int):
            raise ViewError(f"{header_path}: expected an object with view_version")
        if header["view_version"] != VIEW_VERSION:
            raise ViewError(f"{header_path}: view_version {header['view_version']} is not {VIEW_VERSION}")
        for k in ("champion_id", "metric"):
            if not isinstance(header.get(k), str) or not header[k]:
                raise ViewError(f"{header_path}: {k} is required")
        files = header.get("files")
        if not isinstance(files, list) or not all(isinstance(x, str) for x in files):
            raise ViewError(f"{header_path}: files must be a list of names")
    else:
        if champion is None:
            raise ViewError(f"{root} has neither {VIEW_FILE} nor {CHAMPION_FILE}")
        header = {"view_version": VIEW_VERSION, "champion_id": champion["challenger_id"], "metric": champion["metric"]}
        files = sorted(os.listdir(root))
    skill_rel = champion["skill"] if champion is not None else CHAMPION_SKILL_DIR
    champion_skill_dir = skill_rel if os.path.isabs(skill_rel) else os.path.normpath(os.path.join(root, skill_rel))
    if not os.path.exists(os.path.join(champion_skill_dir, "SKILL.md")):
        raise ViewError(f"{champion_skill_dir} is not a skill directory (no SKILL.md)")
    schema_path = os.path.join(root, PROPOSAL_SCHEMA_FILE)
    return View(
        dir=root,
        view_version=header["view_version"],
        champion_id=header["champion_id"],
        metric=header["metric"],
        files=list(files),
        champion_skill_dir=champion_skill_dir,
        tasks=_read_jsonl(os.path.join(root, TASKS_FILE)),
        champion_attempts=_read_jsonl(os.path.join(root, CHAMPION_ATTEMPTS_FILE)),
        champion_scores=_read_jsonl(os.path.join(root, CHAMPION_SCORES_FILE)),
        compares=_read_jsonl(os.path.join(root, COMPARES_FILE)),
        environment=_read_text(os.path.join(root, ENVIRONMENT_FILE)),
        proposal_schema=_read_json(schema_path) if os.path.exists(schema_path) else None,
    )


# ------------------------------------------------------------------ proposal


class ProposalError(Exception):
    pass


@dataclass
class Proposal:
    """What a proposer writes to `proposal.json`; the host stamps `proposer` and, when it knows it, `parent`."""

    surface: str
    patch: Dict[str, Any]
    intent: str
    prediction: Dict[str, Any]
    parent: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {"surface": self.surface, "patch": self.patch, "intent": self.intent, "prediction": self.prediction}
        if self.parent is not None:
            out["parent"] = self.parent
        return out


def _non_empty_str(value: Any) -> bool:
    return isinstance(value, str) and len(value) > 0


def _task_ids(value: Any, where: str) -> None:
    if not isinstance(value, list) or not all(_non_empty_str(x) for x in value):
        raise ProposalError(f"invalid proposal: {where} must be a list of task ids")


def validate_proposal(value: Any) -> Dict[str, Any]:
    """Check the same keys and enum values as the TS schema; returns the proposal as a plain dict."""
    p = value.to_dict() if isinstance(value, Proposal) else value
    if not isinstance(p, dict):
        raise ProposalError("invalid proposal: not an object")
    extra = set(p) - set(PROPOSAL_KEYS)
    if extra:
        raise ProposalError(f"invalid proposal: unknown keys {sorted(extra)}")
    for k in PROPOSAL_REQUIRED:
        if k not in p:
            raise ProposalError(f"invalid proposal: {k} is required")
    if "parent" in p and not _non_empty_str(p["parent"]):
        raise ProposalError("invalid proposal: parent must be a non-empty string")
    if p["surface"] not in SURFACES:
        raise ProposalError(f"invalid proposal: surface must be one of {list(SURFACES)}")
    if not _non_empty_str(p["intent"]):
        raise ProposalError("invalid proposal: intent must be a non-empty string")

    patch = p["patch"]
    if not isinstance(patch, dict) or patch.get("surface") not in SURFACES:
        raise ProposalError("invalid proposal: patch.surface must name a surface")
    if patch["surface"] != p["surface"]:
        raise ProposalError(f'proposal surface "{p["surface"]}" does not match patch surface "{patch["surface"]}"')
    if patch["surface"] == "skill":
        if set(patch) != {"surface", "skill_dir"} or not _non_empty_str(patch["skill_dir"]):
            raise ProposalError("invalid proposal: a skill patch is {surface: 'skill', skill_dir: <path>}")
    else:
        rows = patch.get("rows")
        if set(patch) != {"surface", "rows"} or not isinstance(rows, list) or not rows or not all(isinstance(r, dict) for r in rows):
            raise ProposalError("invalid proposal: a rows patch is {surface, rows: [<object>, ...]} with at least one row")

    pred = p["prediction"]
    if not isinstance(pred, dict):
        raise ProposalError("invalid proposal: prediction must be an object")
    extra = set(pred) - set(PREDICTION_KEYS)
    if extra:
        raise ProposalError(f"invalid proposal: unknown prediction keys {sorted(extra)}")
    for k in PREDICTION_REQUIRED:
        if k not in pred:
            raise ProposalError(f"invalid proposal: prediction.{k} is required")
    if not _non_empty_str(pred["metric"]):
        raise ProposalError("invalid proposal: prediction.metric must be a non-empty string")
    if pred["direction"] not in DIRECTIONS:
        raise ProposalError(f"invalid proposal: prediction.direction must be one of {list(DIRECTIONS)}")
    if "magnitude" in pred and (isinstance(pred["magnitude"], bool) or not isinstance(pred["magnitude"], (int, float))):
        raise ProposalError("invalid proposal: prediction.magnitude must be a number")
    if "magnitude" in pred and not math.isfinite(pred["magnitude"]):
        raise ProposalError("invalid proposal: prediction.magnitude must be finite")
    for k in ("predicted_fixes", "at_risk"):
        if k in pred:
            _task_ids(pred[k], f"prediction.{k}")
    return p


def write_proposal(out_dir: str, proposal: Any, skill_dir: Optional[str] = None) -> str:
    """Validate and write `proposal.json` into `out_dir`, copying `skill_dir` to `<out_dir>/skill` first. Returns the written path."""
    out = os.path.abspath(out_dir)
    os.makedirs(out, exist_ok=True)
    p = dict(proposal.to_dict() if isinstance(proposal, Proposal) else proposal)
    if skill_dir is not None:
        if not isinstance(p.get("patch"), dict) or p["patch"].get("surface") != "skill":
            raise ProposalError(f'skill_dir given for surface "{p.get("surface")}"')
        src = os.path.abspath(skill_dir)
        if not os.path.exists(os.path.join(src, "SKILL.md")):
            raise ProposalError(f"{src} is not a skill directory (no SKILL.md)")
        dest = os.path.join(out, SKILL_DIR)
        if src != dest:
            shutil.copytree(src, dest, dirs_exist_ok=True)
        p["patch"] = {"surface": "skill", "skill_dir": SKILL_DIR}
    valid = validate_proposal(p)
    path = os.path.join(out, PROPOSAL_FILE)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(valid, f, indent=2, allow_nan=False)
        f.write("\n")
    return path


# ---------------------------------------------------------------------- argv


@dataclass
class ProposerArgs:
    view: str
    out: str
    rest: List[str] = field(default_factory=list)


def parse_args(argv: Sequence[str]) -> ProposerArgs:
    """Parse the `--view <dir> --out <dir>` convention (also `--view=<dir>`); `argv` excludes the program name."""
    view: Optional[str] = None
    out: Optional[str] = None
    rest: List[str] = []
    args = list(argv)
    i = 0
    while i < len(args):
        arg = args[i]
        key, eq, inline = arg.partition("=")
        if key in ("--view", "--out"):
            if eq:
                value = inline
            else:
                i += 1
                value = args[i] if i < len(args) else ""
            if not value:
                raise ValueError(f"{key} needs a directory")
            if key == "--view":
                view = value
            else:
                out = value
        else:
            rest.append(arg)
        i += 1
    if view is None:
        raise ValueError("--view <dir> is required")
    if out is None:
        raise ValueError("--out <dir> is required")
    return ProposerArgs(view=os.path.abspath(view), out=os.path.abspath(out), rest=rest)
