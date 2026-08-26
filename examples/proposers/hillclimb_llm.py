#!/usr/bin/env python3
"""A one-step hill climber: ask an OpenAI-compatible chat endpoint to rewrite
the champion's SKILL.md given the tasks it failed, and propose the result.

Standard library only (urllib). Configuration, all optional except the key:

    OPENAI_BASE_URL   default https://api.openai.com/v1   (or --base-url)
    OPENAI_API_KEY    required                            (the host injects it via credentialRef/credentialVar)
    OPENAI_MODEL      default gpt-4o-mini                 (or --model)

Never run in tests: it spends money. Dry-run the contract with noop.py first.
"""

import json
import os
import shutil
import sys
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "sdk", "py"))

from samsara_proposer import Proposal, load_view, parse_args, write_proposal  # noqa: E402

SYSTEM = (
    "You improve an agent's skill file (SKILL.md). You are given the current file, "
    "the tasks the agent failed with it, and any judge notes. Return ONLY the full new "
    "SKILL.md, keeping its front matter, with one focused change that would fix the "
    "most failures without regressing the rest."
)


def option(rest, name, env, default=None):
    if name in rest:
        return rest[rest.index(name) + 1]
    return os.environ.get(env, default)


def failing_tasks(view):
    by_task = {}
    for score in view.champion_scores:
        if score.get("metric") == view.metric and score.get("value") == 0:
            by_task[score["task_id"]] = score.get("side_info", "")
    tasks = {t["task_id"]: t for t in view.tasks if "task_id" in t}
    return [(tid, tasks.get(tid, {}), note) for tid, note in by_task.items() if tid in tasks]


def chat(base_url, key, model, messages):
    req = urllib.request.Request(
        base_url.rstrip("/") + "/chat/completions",
        data=json.dumps({"model": model, "messages": messages, "temperature": 0.2}).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"},
    )
    with urllib.request.urlopen(req, timeout=300) as resp:
        body = json.load(resp)
    return body["choices"][0]["message"]["content"]


def main(argv):
    args = parse_args(argv)
    base_url = option(args.rest, "--base-url", "OPENAI_BASE_URL", "https://api.openai.com/v1")
    model = option(args.rest, "--model", "OPENAI_MODEL", "gpt-4o-mini")
    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        print("hillclimb_llm: OPENAI_API_KEY is not set", file=sys.stderr)
        return 2

    view = load_view(args.view)
    with open(os.path.join(view.champion_skill_dir, "SKILL.md"), encoding="utf-8") as f:
        current = f.read()
    failed = failing_tasks(view)
    print(f"hillclimb_llm: {len(failed)} failing tasks of {len(view.tasks)}; model {model}", file=sys.stderr)

    user = ["# Current SKILL.md\n", current, "\n# Failed tasks\n"]
    for tid, task, note in failed:
        user.append(f"\n## {tid}\n")
        user.append(json.dumps({k: v for k, v in task.items() if k not in ("task_id",)}, indent=2)[:4000])
        if note:
            user.append(f"\nJudge notes: {note}")
    if view.environment:
        user.append("\n# Environment\n" + view.environment)
    new_skill = chat(base_url, key, model, [{"role": "system", "content": SYSTEM}, {"role": "user", "content": "".join(user)}])
    if new_skill.startswith("```"):
        new_skill = new_skill.split("\n", 1)[1].rsplit("```", 1)[0]

    skill_dir = os.path.join(args.out, "skill")
    shutil.copytree(view.champion_skill_dir, skill_dir, dirs_exist_ok=True)
    with open(os.path.join(skill_dir, "SKILL.md"), "w", encoding="utf-8") as f:
        f.write(new_skill if new_skill.endswith("\n") else new_skill + "\n")

    predicted = [tid for tid, _, _ in failed][:5]
    write_proposal(
        args.out,
        Proposal(
            surface="skill",
            patch={"surface": "skill", "skill_dir": "skill"},
            intent=f"Rewrite SKILL.md with {model} targeting {len(failed)} failing tasks (one-step hill climb).",
            prediction={"metric": view.metric, "direction": "up", "predicted_fixes": predicted, "at_risk": []},
        ),
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
