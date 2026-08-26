---
"@oldbulb/samsara-ui": minor
---

The single page becomes a set: overview, experiments and one experiment (budget bars, the rounds table with the promotion verdict and one column per shadow gate, the lineage curve), one round (its gate, shadows, noise floor, siblings side by side, next actions with costs, live progress), one challenger, servings, bench and a session's notebook — each with a `.json` twin that carries every number on the page and the ids it came from, plus an SSE stream of a round's lifecycle events. Reads use the `operator` viewer, so a loopback client never sees held-out per-task deltas; `lifecycle` is optional and looked up per request. The three `/api/*` routes stay as legacy.
