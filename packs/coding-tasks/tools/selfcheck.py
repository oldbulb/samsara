#!/usr/bin/env python3
"""Reference run over every task: materialize -> truth (stub must fail) ->
copy .meta example over the stub -> truth (all must pass). Uses bin/ as
subprocesses, exactly as the framework does.

usage: tools/selfcheck.py [task_id ...]   (default: all tasks in tasks/*.jsonl)
"""
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

PACK = Path(__file__).resolve().parent.parent


def cmd(name, lines):
    p = subprocess.run([str(PACK / "bin" / name)], input="".join(json.dumps(l) + "\n" for l in lines),
                       capture_output=True, text=True, cwd=PACK)
    if p.returncode != 0:
        raise RuntimeError(f"{name} exit {p.returncode}: {p.stderr.strip()}")
    return [json.loads(l) for l in p.stdout.splitlines() if l.strip()]


def all_tasks():
    for s in ("smoke", "holdin", "holdout"):
        for raw in (PACK / "tasks" / f"{s}.jsonl").read_text().splitlines():
            if raw.strip():
                yield json.loads(raw)


def check(task, root):
    tid = task["task_id"]
    wd = root / tid.replace("/", "__")
    fixture = PACK / task["fixture"]
    files = json.loads((fixture / ".meta" / "config.json").read_text())["files"]
    line = {"task_id": tid, "workdir": str(wd)}
    m = cmd("materialize", [line])[0]
    if not m["ok"]:
        return "materialize not ok"
    leaked = [t for t in files["test"] if (wd / t).exists() or t in m["files"]]
    if leaked:
        return f"tests visible to the agent: {leaked}"
    stub = cmd("truth", [line])[0]["truth"]
    if stub["total"] == 0 or stub["failed"] == 0:
        return f"stub did not fail: {stub}"
    # copy, not copy2: cargo fingerprints by mtime, and the example is older than the stub build
    for ex, sol in zip(files["example"], files["solution"]):
        shutil.copy(fixture / ex, wd / sol)
    if (fixture / ".meta" / "Cargo-example.toml").exists():  # the reference solution's own manifest
        shutil.copy(fixture / ".meta" / "Cargo-example.toml", wd / "Cargo.toml")
    ref = cmd("truth", [line])[0]["truth"]
    if ref["failed"] != 0 or ref["passed"] != ref["total"] or ref["exit_code"] != 0:
        return f"reference did not pass: {ref}"
    return None


def main(argv):
    wanted = set(argv)
    tasks = [t for t in all_tasks() if not wanted or t["task_id"] in wanted]
    failures = []
    with tempfile.TemporaryDirectory(prefix="coding-tasks-selfcheck-") as tmp:
        root = Path(tmp)
        for t in tasks:
            try:
                why = check(t, root)
            except Exception as e:  # noqa: BLE001
                why = f"error: {e}"
            print(f"{'FAIL' if why else 'ok  '} {t['task_id']}" + (f"  {why}" if why else ""), flush=True)
            if why:
                failures.append((t["task_id"], why))
    print(f"\n{len(tasks) - len(failures)}/{len(tasks)} ok, {len(failures)} failed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
