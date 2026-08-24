# @oldbulb/samsara-loops-dsh

Loop provider `dsh`: one attempt runs as an in-process dsh child agent. The
plugin (`name: 'loops-dsh'`, `inject: ['loops', 'agents', 'sessions']`)
registers a `LoopProvider` on `ctx.loops` through `ctx.effect`, so the loop
exists exactly as long as the plugin's scope.

## What `start(spec)` does

Modeled on dsh's headless runner and in-process subagent driver
(see `docs/dsh-plugin-notes.md` C.2).

1. `ctx.agents.create({ sessionId, meta: { cwd: spec.workdir }, agentOptions: { provider, model }, signal, setup })`.
2. Inside `setup(agentCtx)`, in this order:
   - join the host's preset composition (`agentPresets.composeFrom`) when a preset service exists;
   - `tools.restrict({ allow: spec.tools.allow })` when `allow` is non-empty;
   - register the submit tool from `@oldbulb/samsara-submit` (writes `<workdir>/<name>.json`, concludes the turn);
   - system-prompt sections `samsara:skill` (order 150, the `SKILL.md` body without frontmatter) and `samsara:submit` (order 190, `submitInstruction`);
   - a `tools.guard` denying any call whose serialized arguments match one of `spec.tools.deny` (regex, substring fallback);
   - a scoped `session/event` listener mapping the committed log to `LoopEvent`s (see below);
   - an `agent/pre-step` listener enforcing `limits.maxTurns` (one samsara turn = one dsh model step) and a `maxDurationMs` timer that cancels the agent.
3. `agent.followup(userMessage(spec.prompt))`, `await agent.whenIdle()`, `await sessions.flush(session)`, then the single `finished` event.

`LoopRun`: `events` is an async queue fed live; `result` never rejects once
`start` resolved; `cancel` → `agent.cancel({kind:'parent'})`; `dispose` is
idempotent and always runs `handle.dispose()` (`Promise.allSettled` with the result).

## Event mapping (docs/design/loops.md, dsh row)

| session event | loop event |
|---|---|
| first `request/header` | `system_prompt` — sha256 + bytes of the rendered system text, tool names |
| `tool/call` | `tool_call` — sha256/bytes/preview of the raw argument string |
| `tool/result` | `tool_result` — `isError` from the block flag or dsh's error identity, duration from the paired call |
| `tool/result` of the submit tool, not an error | additionally `output{source:'submit-tool', structured: parsed args}` |
| `assistant/message` | `assistant` with per-step usage; usage summed into `finished.usage` |
| `turn/end` | recorded; becomes `finished` after whenIdle + flush |

`finished` status/stopReason: a limit that fired owns the reason
(`max_turns`, `timeout`, `budget` → `TRUNCATED`; host cancel → `ABORTED`).
Otherwise from `turn/end.reason`: `completed` with a submit → `COMPLETED`;
`completed` without a submit → `TRUNCATED/schema_failed` (kept, scored as
failure); `max-tokens` → `TRUNCATED/budget`; `aborted` → `ABORTED`;
`error | blocked | interrupted` → `FAILED/error`. A throw from the drive itself
→ `FAILED/error`.

Cost: `{ source: 'unknown' }` unless `Config.pricePerMtok` is set, then
`{ usd, source: 'price-table' }` (USD per million tokens: `input`, `output`,
optional `cacheRead`, default = `input`). With a price table and
`limits.maxBudgetUsd`, the budget is checked after every assistant message and
cancels the agent with stopReason `budget`.

## Harness facts

```
systemPromptMode: 'dsh-persona'      skillDelivery: 'prompt-inline'
schemaEnforcement: 'scoped-tool+retry'   permission: 'approval/policy=never'
version.loop: DSH_PIN (from @oldbulb/samsara-kernel)
```

Why `prompt-inline` and not `agents-skills-dir`: `dsh-skill-filesystem` does
scan `<projectRoot>/.agents/skills`, but `projectRoot` is the nearest ancestor
containing `.git` (the cwd only as a fallback), and it only publishes a
name/description catalog — the body is loaded on demand through the `skill`
tool. A sealed workdir under a git checkout would therefore miss its own
snapshot, so the body is inlined as a prompt section. dsh may additionally
catalog the snapshot; that does not change the facts.

## Default tool allow list

`spec.tools.allow` is passed verbatim to `tools.restrict` (unknown names throw
at creation). The names dsh-base registers (`packages/bundle/base/cordis.patch.yml`
rows `tool-fs`, `tool-fs-search`, `tool-bash`) are:

| tool | package | row |
|---|---|---|
| `read`, `write`, `edit` (also `read_image`) | `@deepseek-ai/dsh-tool-fs` | `tool-fs` |
| `grep`, `glob` | `@deepseek-ai/dsh-tool-fs-search` | `tool-fs-search` |
| `bash` | `@deepseek-ai/dsh-tool-bash` | `tool-bash` |

Exported as `DEFAULT_TOOL_ALLOW = ['read', 'write', 'edit', 'grep', 'glob', 'bash']`.
Other rows a profile may enable (`str_replace_editor`, `skill`, `todo`, web,
subagent tools) stay hidden unless listed. The submit tool is registered in
the agent scope and is visible regardless of the restriction.

## What a real run needs

- A dsh host context with the `agents` factory (`dsh-agent-loop`), `tools`,
  `sessions`, `system-prompt`, an LLM provider route for `spec.route.provider`
  and the tool rows above — i.e. a profile built on dsh-base, booted through
  `@oldbulb/samsara-kernel`. Credentials come from the host's `credentials` service for
  that route; the in-process loop cannot take `spec.env` or a per-attempt
  `baseUrl` (`capabilities.perAttemptEnv/perAttemptBaseUrl = false`).
- A sealed workdir from `@oldbulb/samsara-workdir`: `spec.skill.dir` must contain
  `SKILL.md`; the submit file lands at `<workdir>/<submitTool.name>.json` for the
  host to validate against the pack contract.
- Nothing here spawns processes itself; the child agent's tools (`bash`) go
  through the host's subprocess runtime.

## Filesystem isolation

None; `HARNESS_FACTS.sandbox` is `'none'`. The agent's `bash` tool runs through
dsh's mode-based sandbox seam (`read-only` / `workspace-write` over one root,
built as `--ro /` under Landlock), which cannot take the per-attempt read
allow-list `@oldbulb/samsara-sandbox` composes, so the pack's `tasks/`, `data/` and
`bin/` stay reachable from an in-process attempt. The subprocess-based loop
(`loops-claude-code`) is the confined one; see `packages/sandbox/README.md`.

## Tests

`pnpm --filter @oldbulb/samsara-loops-dsh test` — unit tests of the event mapper,
`finish`, the limits, the deny guard, the queue and the skill body reader,
driven by synthetic session events. No agent, no LLM, no network.
