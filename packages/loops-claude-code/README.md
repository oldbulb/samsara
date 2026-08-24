# @oldbulb/samsara-loops-claude-code

Loop provider `claude-code` for the `loops` seam (`docs/design/loops.md`). One attempt = one
`query()` of `@anthropic-ai/claude-agent-sdk@0.3.220`, whose real `claude` CLI process is spawned
through `ctx.subprocess` inside this plugin's own effect (E4), mapped message-by-message onto
`LoopEvent`s, and settled as exactly one `finished`.

## The SDK is an optional peer

`@anthropic-ai/claude-agent-sdk` is proprietary ("© Anthropic PBC, all rights reserved"), so this
package declares it as an *optional* peer dependency and the bundle ships this row `disabled: true`.
Nothing installs the SDK for you, and the module never loads it until an attempt starts — a
deployment that does not want the dependency never touches it.

```sh
dsh plugin --profile <name> add @anthropic-ai/claude-agent-sdk
```

```yaml
- { id: loops-claude-code, disabled: false, config: { baseUrl: …, credentialRef: … } }
```

Enabling the row without the SDK fails at the first attempt with that instruction, not with a
module-resolution stack trace.

## Plugin

```ts
export const name = 'loops-claude-code'
export const inject = ['loops', 'subprocess', 'credentials']
export const Config = Schema.object({ graceMs: Schema.number().default(3000) })
```

`apply` registers `ClaudeCodeLoopProvider` on `ctx.loops` via `ctx.effect(() => ctx.loops.register(provider))`.

| fact | value |
|---|---|
| `harnessFacts.systemPromptMode` | `preset:claude_code` |
| `harnessFacts.skillDelivery` | `prompt-inline` — `SKILL.md` body (frontmatter stripped) + the submit-file instruction are appended to the preset system prompt |
| `harnessFacts.schemaEnforcement` | `permissive-tool` — the agent writes `<workdir>/<submitTool.name>.json`; the host validates it against the pack contract |
| `harnessFacts.permission` | `bypassPermissions` |
| `harnessFacts.version` | `{ loop: 'claude-code', sdk: '0.3.220' }` |
| `capabilities` | `perAttemptBaseUrl`, `perAttemptEnv`, `toolFilter` (`spec.tools.deny` → `disallowedTools`), `nativeMaxTurns`; `nativeSchema: 'none'` |

## What a real run needs

- **The `claude` binary.** Production omits `pathToClaudeCodeExecutable`; SDK 0.3.220 resolves the
  native `claude` from its own platform package (`@anthropic-ai/claude-agent-sdk-<os>-<arch>`,
  an optional dependency — make sure it installed for the host's platform). `PATH` is not consulted.
- **A base URL.** `spec.route.baseUrl` becomes `ANTHROPIC_BASE_URL`; the intended target is the
  external LLM proxy with a per-attempt segment so cost attributes per attempt.
- **A credential ref.** `spec.route.credentialRef` is resolved through `ctx.credentials.resolve`
  at every start and injected as `ANTHROPIC_AUTH_TOKEN` (E5). It is never logged, never part of
  `harnessFacts`, and never inside any artifact. An unconfigured ref rejects `start()` before
  publication.
- **A sealed workdir and a per-attempt tmpdir** from the `workdir` plugin. `HOME`, `TMPDIR` and
  `CLAUDE_CONFIG_DIR` (`<tmpdir>/claude-config`) all point inside `spec.tmpdir` (E6);
  `persistSession: false` keeps the CLI from writing session files elsewhere.

Child environment (in override order): `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL` and
`ANTHROPIC_SMALL_FAST_MODEL` (= `spec.route.model`), `CLAUDE_CONFIG_DIR`, `HOME`, `TMPDIR`,
`DISABLE_TELEMETRY=1`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `ANTHROPIC_BASE_URL` when
set, `ANTHROPIC_CUSTOM_HEADERS` from `spec.env` when set, then every `spec.env` entry. The SDK
receives `{ ...scrubbedParentEnv(), ...env }`; the SDK's final child env is re-expressed as a
subprocess overlay with tombstones for every scrubbed name it dropped (same as dsh's
`subagent-claude-code`).

## Event mapping

| SDKMessage | LoopEvent |
|---|---|
| `system/init` | `started{native:{kind:'claude-code', id: session_id, pid}}` then `system_prompt{sha256(preset id + append + tools), tools}` |
| `assistant` `tool_use` block | `tool_call{callId, name, argsSha256, argsBytes, argsPreview}` |
| `assistant` (every message) | `assistant{turn, textBytes, usage}` |
| `user` `tool_result` block | `tool_result{callId, isError, bytes, durationMs}` |
| `result` | kept; after the stream ends → `output` (`submit-tool` if the submit file exists, else `parsed-text` with the result text) then `finished` |

`finished.status`: `success → COMPLETED`; `error_max_turns / error_max_budget_usd → TRUNCATED`
(`max_turns` / `budget`); `maxDurationMs` elapsed → `TRUNCATED/timeout`; `cancel()` or the attempt
signal → `ABORTED`; any other subtype or a stream with no result → `FAILED`. Cost is
`{ usd: total_cost_usd, source: 'self-reported' }`. The raw message stream is written to
`<tmpdir>/claude-stream.jsonl` and reported as a `transcript-native` artifact with its sha256.

`cancel` aborts the SDK controller; `dispose` (idempotent) closes the query, terminates the
process tree, waits for exit, awaits the settled result, releases the effect, and deletes
`<tmpdir>/claude-config`. Artifacts are kept.

## Filesystem isolation

The CLI process is spawned through `@oldbulb/samsara-sandbox`'s `apply` with
`spec.sandbox` (composed by the host from the workdir's `policyPaths`). On a
Linux host whose launcher probes usable the argv is wrapped in `landlock-run`
grants and the provider's `harnessFacts.sandbox` is `'landlock'`; elsewhere
the spawn is unchanged and the facts say `'none'`. An enforcing host with an
attempt that carries no policy fails closed at spawn. The `host` in `RunDeps`
(and the provider constructor) is the test seam.

## Run

```sh
pnpm --filter @oldbulb/samsara-loops-claude-code build
pnpm exec vitest run packages/loops-claude-code   # no process spawn, no network
```
