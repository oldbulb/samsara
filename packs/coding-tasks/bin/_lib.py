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
RUNTIME = PACK / "runtime"
TIMEOUT = 180

# Test files the upstream config does not list: Go tracks keep extra step /
# bonus / cases files next to the registered one, Rust keeps every tests/*.rs.
TEST_GLOBS = {"rust": "tests/*.rs", "go": "*_test.go"}


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


def hidden_files(fixture):
    """The tests: the registered ones plus the language's test glob. Never
    materialized — the agent works from the instructions and the stub, as in
    the aider and DGM Polyglot protocols; truth restores them to score."""
    names = set(meta_files(fixture)["test"])
    glob = TEST_GLOBS.get(fixture.parent.name)
    if glob:
        names |= {p.relative_to(fixture).as_posix() for p in fixture.glob(glob)}
    return sorted(names)


def test_files(fixture):
    """Pristine files truth restores: the hidden tests and the `editor` support
    files (Go's interfaces / definitions the tests and the stub share)."""
    return sorted(set(hidden_files(fixture)) | set(meta_files(fixture).get("editor", [])))


def truth_sha(fixture):
    h = hashlib.sha256()
    for name in test_files(fixture):
        h.update(name.encode() + b"\0" + (fixture / name).read_bytes() + b"\0")
    return h.hexdigest()


def install_test(fixture, name, workdir):
    """Copy one pristine test file into workdir, un-skipping xtest/xit and
    #[ignore] (the upstream specs skip everything but the first test by
    default)."""
    dst = workdir / name
    dst.parent.mkdir(parents=True, exist_ok=True)
    src = fixture / name
    if name.endswith(".js"):
        text = src.read_text()
        text = re.sub(r"\bxtest\(", "test(", text)
        text = re.sub(r"\bxit\(", "it(", text)
        dst.write_text(text)
    elif name.endswith(".rs"):
        text = re.sub(r"^[ \t]*#\[ignore(?:\s*=\s*\"[^\"]*\")?\][ \t]*\n", "", src.read_text(), flags=re.M)
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
    venv = RUNTIME / "py" / ".venv" / "bin" / "python"
    return str(venv) if venv.exists() else sys.executable


# Go and Rust: the pack-local install under runtime/ when it exists (see
# runtime/provision.sh), else whatever is on PATH. Both run without network.
def go_bin():
    env = os.environ.get("CODING_TASKS_GO")
    if env:
        return env
    local = RUNTIME / "go" / "go" / "bin" / "go"
    return str(local) if local.exists() else "go"


def go_env():
    return {**os.environ, "GOTOOLCHAIN": "local", "GOPROXY": "off",
            "GOCACHE": str(RUNTIME / "go" / "cache"), "GOPATH": str(RUNTIME / "go" / "gopath")}


def cargo_bin():
    env = os.environ.get("CODING_TASKS_CARGO")
    if env:
        return env
    local = RUNTIME / "rust" / "cargo" / "bin" / "cargo"
    return str(local) if local.exists() else "cargo"


def cargo_env():
    env = {**os.environ, "CARGO_NET_OFFLINE": "true"}
    if (RUNTIME / "rust" / "rustup").is_dir():
        env["RUSTUP_HOME"] = str(RUNTIME / "rust" / "rustup")
        env["CARGO_HOME"] = str(RUNTIME / "rust" / "cargo")
    return env


def run(cmd, cwd, env=None):
    try:
        p = subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True, timeout=TIMEOUT)
        return p.returncode, p.stdout, p.stderr
    except subprocess.TimeoutExpired as e:
        return 124, e.stdout or "", (e.stderr or "") + "\ntimeout"
