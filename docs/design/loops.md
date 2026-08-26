# loops — the loop-provider seam

A *loop* is an agent loop that runs one attempt of one task under one configuration: dsh's own in-process agent, Claude Code, Codex, pi. The framework never talks to a loop except through this seam.

## Cordis shape

`ctx.loops` is a registry service (same pattern as `ctx.subagents`): a provider plugin registers itself with `ctx.effect(() => ctx.loops.register(provider))`, so the host's loop set equals its enabled plugins and a disposed scope removes its loop. Each provider starts every child process through `ctx.subprocess.spawn` wrapped in its own effect (E4), so disposing the provider's scope reaches process-tree quiescence.

## Types

```ts
interface AttemptSpec {
  attemptId: string                      // ledger-minted; also the per-attempt base-URL segment / session name
  challengerId: string
  workdir: string                        // absolute, sealed by `workdir`: .task/token.json (0400), .agents/skills/<name>/, pack files
  skill: { name: string; dir: string; sha: string }   // content-addressed snapshot inside workdir
  prompt: string                         // final prompt text; a loop that prepends the skill body must say so in harnessFacts
  route: { provider: string; model: string; baseUrl?: string; credentialRef: string; reasoning?: Record<string, unknown> }
  outputSchema: object                   // hint to the loop; the host validates the submit file against the pack contract regardless
  tools: { allow: string[]; deny: string[]; submitTool: { name: string; schema: object } }
  limits: { maxTurns: number; maxDurationMs: number; maxBudgetUsd?: number; maxOutputTokens?: number }
  env?: Record<string, string>           // explicit credential/route injection (E5); never inherited wholesale
  tmpdir: string                         // per-attempt TMPDIR (E6)
  signal: AbortSignal
}

type LoopEvent =
  | { t: 'started'; at: number; native: { kind: string; id: string; pid?: number } }
  | { t: 'envelope'; at: number                                        // what the model was shown, in dsh's request-envelope terms; see § Envelope
      config: { sha256: string; provider: string; model: string }
      system: { sha256: string; bytes: number }
      tools: { sha256: string; names: string[] } }
  | { t: 'tool_call'; at: number; callId: string; name: string; argsSha256: string; argsBytes: number; argsPreview?: string }
  | { t: 'tool_result'; at: number; callId: string; isError: boolean; bytes: number; durationMs?: number }
  | { t: 'assistant'; at: number; turn: number; textBytes: number; usage?: TokenUsage }
  | { t: 'output'; at: number; structured?: unknown; text: string; source: 'native-schema' | 'submit-tool' | 'parsed-text' }
  | { t: 'finished'; at: number; status: 'COMPLETED' | 'TRUNCATED' | 'ABORTED' | 'FAILED';
      stopReason: 'completed' | 'aborted' | 'timeout' | 'max_turns' | 'budget' | 'schema_failed' | 'error';
      usage: TokenUsage; cost: { usd?: number; source: 'self-reported' | 'price-table' | 'proxy' | 'unknown' };
      turns: number; toolCalls: number; artifacts: Artifact[] }

interface TokenUsage { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number }
interface Artifact { kind: 'transcript-native' | 'transcript-normalized' | 'stdout' | 'stderr' | 'workdir-diff'; path: string; sha256: string }

interface LoopRun {
  readonly id: string                    // == spec.attemptId
  readonly events: AsyncIterable<LoopEvent>   // ends with exactly one 'finished'
  readonly result: Promise<Extract<LoopEvent, { t: 'finished' }>>   // never rejects after `start` resolved
  cancel(reason: string): void           // cooperative: interrupt → grace → tree kill
  dispose(): Promise<void>               // idempotent; process quiescence; secrets deleted, artifacts kept
}

interface LoopProvider {
  readonly name: string                  // 'dsh' | 'claude-code' | 'codex' | 'pi'
  readonly harnessFacts: HarnessFacts    // static; stored per attempt as facts_sha — rows with different facts are not A/B-comparable
  readonly capabilities: { perAttemptBaseUrl: boolean; perAttemptEnv: boolean; nativeSchema: 'none' | 'tool' | 'validator'; toolFilter: boolean; nativeMaxTurns: boolean }
  start(spec: AttemptSpec): Promise<LoopRun>   // rejects only before publication, after cleaning partial resources
}

interface HarnessFacts {
  systemPromptMode: string               // 'dsh-persona' | 'preset:claude_code' | 'codex-base' | 'pi-default' | 'none'
  skillDelivery: 'agents-skills-dir' | 'plugin-slash' | 'prompt-inline'
  schemaEnforcement: 'scoped-tool+retry' | 'cli-validator+retry' | 'provider-strict' | 'permissive-tool'
  permission: string
  reasoning: Record<string, unknown>
  envelope: { config: Fidelity; system: Fidelity; tools: Fidelity }   // how faithfully this loop reports each envelope field; static, so part of facts_sha
  version: { loop: string; sdk?: string }   // dsh pin / claude-agent-sdk version / codex version
}

type Fidelity = 'exact' | 'proxy' | 'absent'
```

Status mapping: `COMPLETED` = the loop ended by itself with a submit; `TRUNCATED` = max_turns / budget / timeout / max tokens (kept, scored as failure); `ABORTED` = cancelled by the host; `FAILED` = loop or provider error (kept in the ledger, excluded from gate statistics).

## Event mapping per loop

- **dsh**: `tool/call` → `tool_call`; `tool/result` → `tool_result`; `assistant/message` (+usage) → `assistant`; first `request/header` → `envelope` (exact on every field: canonical call config, rendered system text, tool schemas); the submit tool's call → `output{source:'submit-tool'}`; `turn/end.reason` → `finished`.
- **claude-code**: assistant `tool_use` blocks → `tool_call`; `tool_result` blocks → `tool_result`; `system/init` → `envelope` (proxy on every field: `{provider, model}` with the model from init; preset id + SDK version + append for the system text the SDK never exposes; tool names, not schemas); `ResultMessage` → `finished{cost.source:'self-reported'}`; the submit file written by the agent → `output{source:'submit-tool'}`.
- codex / pi: later (s4 §3–4 have the mapping).

## Envelope

dsh logs every model request's envelope as a `request/header` event — an `EpochHeader` of `config`, `system` and `tools` — under the invariant that anything model-visible is reconstructable from the session log. Every LLM harness has the same three things in every request; dsh is the one that writes them down. The `envelope` event is a loop reporting them in that shape, once per attempt, from the first request.

The ledger records it for two uses the static diff scan cannot serve: a run-time check that a challenger differs from the champion in exactly one envelope field (the model-visible surfaces of `architecture.md` § Surfaces), and the token cost of a model-visible patch without a model call. The event and its fidelity are in place; the check and the costing are not yet wired into the gate.

**Loops are adapters we own, and they do not claim equivalence.** A loop reports each field with the fidelity it can honestly claim, declared statically in `HarnessFacts.envelope`:

| Fidelity | Meaning | Example |
|---|---|---|
| `exact` | the harness exposes the content; the hash is over the content | dsh: `request/header` |
| `proxy` | an identifier and a version stand in for content the harness does not expose; the hash is over the stand-in | Claude Code: preset id + SDK version + append for `system`; tool names for `tools` |
| `absent` | the loop shows the model nothing of the kind | the null loop |

Fidelity is part of `facts_sha`, so it is a ledger coordinate the gate already honours: two attempts under the same loop are comparable at the fidelity they share, and an `exact` field on one loop is never compared to a `proxy` field on another. `harness_sha` derived from the envelope is a harness hash only where every field is `exact`; elsewhere the ledger says so rather than pretending.

A proxy is only as good as its stand-in. The SDK version is in the hash because a preset changes between versions; a loop whose stand-in can drift without a version change must say so in `harnessFacts` rather than report `proxy`.

## What the host does around a loop

1. `workdir.materialize` seals the directory (pack `materialize` + skill snapshot + `.task/token.json` + TMPDIR).
2. `loops.start(spec)`; the ledger tails `events` and stores `facts_sha`, usage, cost, tool calls, artifacts. The registry hashes the skill snapshot (`spec.skill.dir`) before the provider starts and again at `finished`: a snapshot that changed under the loop downgrades the attempt to `FAILED`/`error`, so the skill an attempt is attributed to is the one it ran with.
3. On `finished`, the host reads `<workdir>/<submit>.json`, validates it against the pack contract (`output.valid`), then runs pack `truth` and `score`.
4. `dispose()`; the workdir is kept as an artifact until the attempt's retention expires.

A loop never sees the ledger, truth, or scores; it sees only the sealed workdir and its spec.
