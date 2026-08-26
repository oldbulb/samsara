#!/usr/bin/env python
"""Generate the Harbor job fixtures under jobs/ from real Harbor models.

Needs a venv with Harbor installed (the fixtures are contract-true for the
version it pins, 0.22.0): the trial's config.json and result.json are written
the way harbor.trial.Trial writes them (TrialConfig with defaults excluded,
TrialResult in full), and verifier/reward.txt|json the way a task's tests/test.sh
leaves them. The framework never imports Harbor; this script only builds the
files the importer reads. The generated JSON is committed, so run it only to
re-pin: every id and timestamp is derived from the job and trial names.

    <venv>/bin/python packages/runner/tests/fixtures/harbor/gen.py
"""

import hashlib
import json
import shutil
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import NAMESPACE_URL, uuid5

from harbor.models.agent.context import AgentContext
from harbor.models.environment_type import EnvironmentType
from harbor.models.task.config import VerifierEnvironmentMode
from harbor.models.task.id import LocalTaskId
from harbor.models.trial.config import AgentConfig, EnvironmentConfig, TaskConfig, TrialConfig
from harbor.models.trial.result import AgentInfo, ExceptionInfo, ModelInfo, TimingInfo, TrialResult
from harbor.models.verifier.result import VerifierResult

HERE = Path(__file__).resolve().parent
JOBS = HERE / "jobs"
T0 = datetime(2026, 8, 26, 12, 0, tzinfo=timezone.utc)

# One job = one agent over one task set; `trials` lists, per task, the reward of each trial in creation order.
# `reward` is how the reward reaches the importer: "result" (verifier_result in result.json, and the file),
# "file" (the file only: verifier_result is None), "none" (the trial failed before its verifier ran).
JOBS_SPEC = {
    # The champion: 3 trials per task, so it also serves as a noise floor.
    "oracle": {
        "agent": AgentInfo(name="oracle", version="1.0.0"),
        "config": AgentConfig(name="oracle"),
        "reward_file": "reward.txt",
        "trials": {
            "o1": [(1.0, "result"), (1.0, "file"), (1.0, "result")],
            "o2": [(1.0, "result"), (0.0, "result"), (1.0, "result")],
            "o3": [(0.0, "result"), (1.0, "result"), (1.0, "result")],
        },
    },
    # The same agent run again with a skill declared: a challenger of the job above (rule 0 holds).
    "variant": {
        "agent": AgentInfo(name="oracle", version="1.0.0"),
        "config": AgentConfig(name="oracle", skills=["skills/terse"]),
        "reward_file": "reward.json",
        "trials": {
            "o1": [(0.0, "result"), (1.0, "result")],
            "o2": [(1.0, "result"), (1.0, "file")],
            "o3": [(1.0, "result"), (1.0, "result")],
        },
    },
    # Another agent on a subset of the tasks, one trial failed: a different harness, not comparable.
    "other": {
        "agent": AgentInfo(name="other", version="0.1.0", model_info=ModelInfo(name="model-x", provider="prov")),
        "config": AgentConfig(name="other", model_name="prov/model-x", kwargs={"max_turns": 5}),
        "reward_file": "reward.txt",
        "trials": {
            "o1": [(0.5, "result"), (None, "none")],
            "o2": [(0.5, "result"), (0.5, "result")],
        },
    },
}


def uuid_of(*parts: str):
    return uuid5(NAMESPACE_URL, "samsara-harbor-fixture/" + "/".join(parts))


def checksum_of(task: str) -> str:
    return hashlib.sha256(f"task:{task}".encode()).hexdigest()


def write_job(name: str, spec: dict) -> None:
    job_dir = JOBS / name
    shutil.rmtree(job_dir, ignore_errors=True)
    # The paths Harbor records are the machine's; the fixture records a neutral root so the JSON is portable.
    recorded_dir = Path("/jobs") / name
    job_id = uuid_of(name)
    n = 0
    for task, trials in spec["trials"].items():
        for k, (value, how) in enumerate(trials):
            trial_name = f"{task}__{name[:3]}{k:04d}"
            trial_dir = job_dir / trial_name
            (trial_dir / "agent").mkdir(parents=True)
            (trial_dir / "verifier").mkdir()
            started = T0 + timedelta(minutes=10 * n)
            n += 1
            config = TrialConfig(
                task=TaskConfig(path=Path("/tasks") / task),
                trial_name=trial_name,
                trials_dir=recorded_dir,
                agent=spec["config"].model_copy(),
                environment=EnvironmentConfig(type=EnvironmentType.DOCKER),
                job_id=job_id,
            )
            rewards = None if value is None else {"reward": value}
            if spec["reward_file"] == "reward.json" and rewards is not None:
                rewards["tests_passed"] = int(value * 4)
            failed = how == "none"
            result = TrialResult(
                id=uuid_of(name, trial_name),
                task_name=task,
                trial_name=trial_name,
                trial_uri=(recorded_dir / trial_name).as_uri(),
                task_id=LocalTaskId(path=Path("/tasks") / task),
                task_checksum=checksum_of(task),
                config=config,
                agent_info=spec["agent"],
                agent_result=None if failed else AgentContext(
                    n_input_tokens=1000 + 100 * n, n_cache_tokens=200, n_output_tokens=50 + n, cost_usd=0.01 * n,
                ),
                verifier_result=VerifierResult(rewards=rewards) if how == "result" else None,
                verifier_environment_mode=None if failed else VerifierEnvironmentMode.SHARED,
                exception_info=ExceptionInfo(
                    exception_type="AgentTimeoutError", exception_message="agent timed out",
                    exception_traceback="Traceback (most recent call last):\n  ...\n", occurred_at=started + timedelta(minutes=5),
                ) if failed else None,
                started_at=started,
                finished_at=started + timedelta(minutes=6),
                environment_setup=TimingInfo(started_at=started, finished_at=started + timedelta(seconds=30)),
                agent_execution=TimingInfo(started_at=started + timedelta(seconds=30), finished_at=started + timedelta(minutes=5)),
                verifier=None if failed else TimingInfo(started_at=started + timedelta(minutes=5), finished_at=started + timedelta(minutes=6)),
            )
            (trial_dir / "config.json").write_text(config.model_dump_json(indent=4, exclude_defaults=True))
            (trial_dir / "result.json").write_text(result.model_dump_json(indent=4))
            (trial_dir / "trial.log").write_text(f"{trial_name}: {'failed' if failed else 'ok'}\n")
            (trial_dir / "agent" / "agent.log").write_text("fixture agent log\n")
            if failed:
                (trial_dir / "exception.txt").write_text("agent timed out\n")
                continue
            (trial_dir / "verifier" / "test-stdout.txt").write_text("fixture tests\n")
            if spec["reward_file"] == "reward.json":
                (trial_dir / "verifier" / "reward.json").write_text(json.dumps(rewards) + "\n")
            else:
                (trial_dir / "verifier" / "reward.txt").write_text(f"{value}\n")
    # A job directory also holds Harbor's job-level files; the importer walks the trial directories only.
    (job_dir / "job.log").write_text(f"job {job_id}\n")


if __name__ == "__main__":
    for name, spec in JOBS_SPEC.items():
        write_job(name, spec)
    print(f"wrote {len(JOBS_SPEC)} jobs under {JOBS}")
