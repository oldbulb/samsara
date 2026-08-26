#!/usr/bin/env python3
"""Regenerate fixtures/ and tasks/ from a polyglot-benchmark checkout.

usage: tools/import_polyglot.py <path-to-polyglot-benchmark>

Copies every python/, javascript/, rust/ and go/ practice exercise verbatim
(minus node_modules) into fixtures/<lang>/<exercise>/ and writes
tasks/{smoke,holdin,holdout}.jsonl with a deterministic split by
sha256(entity_key), entity = exercise name, so every language of one
exercise lands in the same set.
"""
import hashlib
import json
import shutil
import sys
from pathlib import Path

PACK = Path(__file__).resolve().parent.parent
LANGS = ("python", "javascript", "rust", "go")
SPLIT = {"smoke": 15, "holdin": 83, "holdout": 53}


# Exercises whose untouched stub already passes (refactoring tasks) or that
# ship no tests at all (go/counter: "design the test suite", deprecated) are
# not "fix the failing tests" tasks and are excluded.
EXCLUDE = {"javascript/ledger", "go/counter", "go/ledger", "go/markdown"}


def main(src: Path) -> None:
    fixtures = PACK / "fixtures"
    if fixtures.exists():
        shutil.rmtree(fixtures)
    tasks = []
    for lang in LANGS:
        for ex in sorted((src / lang / "exercises" / "practice").iterdir()):
            if f"{lang}/{ex.name}" in EXCLUDE:
                continue
            if not ex.is_dir():
                continue
            dst = fixtures / lang / ex.name
            shutil.copytree(ex, dst, symlinks=True,
                            ignore=shutil.ignore_patterns("node_modules"))
            tasks.append({
                "task_id": f"{lang}/{ex.name}",
                "entity_key": ex.name,
                "stratum": lang,
                "lang": lang,
                "exercise": ex.name,
                "fixture": f"fixtures/{lang}/{ex.name}",
            })

    # deterministic split: rank entities by sha256, cut by quota on tasks
    entities = sorted({t["entity_key"] for t in tasks},
                      key=lambda e: hashlib.sha256(e.encode()).hexdigest())
    per_entity = {e: sum(1 for t in tasks if t["entity_key"] == e) for e in entities}
    assign = {}
    order = ["smoke", "holdin", "holdout"]
    counts = {s: 0 for s in order}
    for e in entities:
        for s in order:
            if counts[s] + per_entity[e] <= SPLIT[s] or s == order[-1]:
                assign[e] = s
                counts[s] += per_entity[e]
                break

    (PACK / "tasks").mkdir(exist_ok=True)
    for s in order:
        with open(PACK / "tasks" / f"{s}.jsonl", "w") as f:
            for t in tasks:
                if assign[t["entity_key"]] == s:
                    f.write(json.dumps(t) + "\n")
    print(f"{len(tasks)} tasks: " + ", ".join(f"{s}={counts[s]}" for s in order))


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(Path(sys.argv[1]).resolve())
