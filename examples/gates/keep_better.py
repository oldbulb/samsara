#!/usr/bin/env python3
"""keep-better: the smallest honest gate.

Reads a CompareRequest as JSON on stdin, prints a GateJudgement as JSON on
stdout (contract: README.md next to this file). Pairs challenger and champion
by (taskId, sample), takes the mean paired delta, and promotes iff it is
positive. No bootstrap, no multiplicity, no power floor: `ci` is [mean, mean]
and `method` says so. It exists to show the contract, not to be a good gate;
mount it and the ledger will record every verdict as keep-better@0.1.0.

Standard library only. Deterministic: the same request yields the same
output; nothing is read from the environment.
"""

import json
import math
import statistics
import sys

NAME = "keep-better"
VERSION = "0.1.0"
ELIGIBLE = ("COMPLETED", "TRUNCATED")


def cost_of(metric, rows):
    """usd only when every row reports it; otherwise tokens, so a ratio never mixes units."""
    if metric == "cost_usd" and rows and all(r["cost"].get("usd") is not None for r in rows):
        return lambda r: r["cost"]["usd"]
    return lambda r: r["cost"]["tokens"]


def ratio(num, den):
    if den == 0:
        return 1.0 if num == 0 else float("inf")
    return num / den


def sd(xs):
    return statistics.stdev(xs) if len(xs) >= 2 else 0.0


def mde(sd_paired, n_eff, alpha, power, replicates):
    if n_eff <= 0 or replicates <= 0:
        return float("inf")
    nd = statistics.NormalDist()
    return (nd.inv_cdf(1 - alpha / 2) + nd.inv_cdf(power)) * sd_paired / math.sqrt(n_eff * replicates)


def finite(x):
    """JSON has no inf/nan; the contract requires finite numbers."""
    return x if math.isfinite(x) else 0.0


def judge(req):
    policy = req["policy"]
    metric = req["primaryMetric"]
    challenger = [a for a in req["challenger"] if a["metric"] == metric]
    champion = [a for a in req["champion"] if a["metric"] == metric]
    cost = cost_of(policy["costBudget"]["metric"], challenger + champion)

    excluded = 0
    champ_by = {}
    for c in champion:
        if c["status"] not in ELIGIBLE:
            excluded += 1
            continue
        champ_by[(c["taskId"], c["sample"])] = c
    per_task, costs_a, costs_c, used = [], [], [], set()
    eligible_challenger = 0
    for a in challenger:
        if a["status"] not in ELIGIBLE:
            excluded += 1
            continue
        eligible_challenger += 1
        key = (a["taskId"], a["sample"])
        c = champ_by.get(key)
        if c is None or key in used:
            continue
        used.add(key)
        d = {"taskId": a["taskId"], "entityKey": a["entityKey"], "sample": a["sample"], "delta": a["value"] - c["value"]}
        if a.get("stratum") is not None:
            d["stratum"] = a["stratum"]
        per_task.append(d)
        costs_a.append(cost(a))
        costs_c.append(cost(c))
    unpaired = eligible_challenger - len(per_task) + (len(champ_by) - len(used))

    deltas = [d["delta"] for d in per_task]
    mean = statistics.fmean(deltas) if deltas else 0.0
    by_entity = {}
    for d in per_task:
        by_entity.setdefault(d["entityKey"], []).append(d["delta"])
    n_eff = len(by_entity)
    entity_sd = sd([statistics.fmean(v) for v in by_entity.values()])
    distinct_tasks = len({d["taskId"] for d in per_task})
    replicates = len(per_task) / distinct_tasks if distinct_tasks else 0.0
    step = entity_sd / math.sqrt(n_eff) if n_eff else float("inf")
    best = req.get("bestSoFar")
    beat_best = n_eff > 0 and (best is None or mean > best + step)
    valid = sum(1 for a in challenger if a["status"] == "COMPLETED" and a.get("valid") is not False)
    valid_rate = valid / len(challenger) if challenger else 0.0

    compare = {
        "perTask": per_task,
        "mean": mean,
        "ci": [mean, mean],
        "method": NAME,
        "clusterKey": "entity",
        "nEff": n_eff,
        "mde": finite(mde(req["noiseFloor"]["sdPaired"], n_eff, policy["alpha"], policy["power"], replicates)),
        "replicates": replicates,
        "minEffect": policy.get("mde") or 0,
        "holm": {"adjustedAlpha": policy["alpha"] / (req["round"]["k"] - req["round"]["index"])},
        "costRatio": finite(ratio(statistics.fmean(costs_a) if costs_a else 0.0, statistics.fmean(costs_c) if costs_c else 0.0)),
        "ladder": {"step": finite(step), "beatBest": beat_best},
        "counts": {"paired": len(per_task), "unpaired": unpaired, "excluded": excluded, "validRate": valid_rate},
        "ruleFired": "",
    }

    facts = req.get("factsSha")
    if facts and facts.get("challenger") != facts.get("champion"):
        return decide(compare, "invalid", "facts:mismatch")
    if any(a["kind"] == "judge" for a in challenger + champion):
        return decide(compare, "invalid", "type:judge")
    if not per_task:
        return decide(compare, "invalid", "type:no-data")
    if mean > 0:
        return decide(compare, "promote", "keep-better:mean>0")
    return decide(compare, "hold", "keep-better:mean<=0")


def decide(compare, verdict, rule):
    return {"compare": {**compare, "ruleFired": rule}, "verdict": verdict}


def main():
    req = json.load(sys.stdin)
    json.dump(judge(req), sys.stdout, allow_nan=False)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
