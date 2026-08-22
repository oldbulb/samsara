"""Shared helpers for the coding-tasks pack commands. Not a framework import."""
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

PACK = Path(__file__).resolve().parent.parent
TIMEOUT = 180


def read_lines():
    for raw in sys.stdin:
        raw = raw.strip()
        if raw:
            yield json.loads(raw)


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def fixture_of(task_id):
    lang, exercise = task_id.split("/", 1)
    d = PACK / "fixtures" / lang / exercise
    if not d.is_dir():
        raise SystemExit(f"unknown task {task_id}: {d} missing")
    return lang, d


def meta_files(fixture):
    return json.loads((fixture / ".meta" / "config.json").read_text())["files"]


def test_files(fixture):
    return sorted(meta_files(fixture)["test"])


def truth_sha(fixture):
    h = hashlib.sha256()
    for name in test_files(fixture):
        h.update(name.encode() + b"\0" + (fixture / name).read_bytes() + b"\0")
    return h.hexdigest()


def install_test(fixture, name, workdir):
    """Copy one pristine test file into workdir, un-skipping xtest/xit (the
    upstream specs skip everything but the first test by default)."""
    dst = workdir / name
    dst.parent.mkdir(parents=True, exist_ok=True)
    src = fixture / name
    if name.endswith(".js"):
        text = src.read_text()
        text = re.sub(r"\bxtest\(", "test(", text)
        text = re.sub(r"\bxit\(", "it(", text)
        dst.write_text(text)
    else:
        shutil.copy2(src, dst)


def restore_tests(fixture, workdir):
    for name in test_files(fixture):
        install_test(fixture, name, workdir)


def python_bin():
    env = os.environ.get("CODING_TASKS_PYTHON")
    if env:
        return env
    venv = PACK / "runtime" / "py" / ".venv" / "bin" / "python"
    return str(venv) if venv.exists() else sys.executable


def run(cmd, cwd, env=None):
    try:
        p = subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True, timeout=TIMEOUT)
        return p.returncode, p.stdout, p.stderr
    except subprocess.TimeoutExpired as e:
        return 124, e.stdout or "", (e.stderr or "") + "\ntimeout"
