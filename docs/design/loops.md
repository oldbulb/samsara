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
  | { t: 'system_prompt'; at: number; sha256: string; bytes: number; tools: string[] }
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
  version: { loop: string; sdk?: string }   // dsh pin / claude-agent-sdk version / codex version
}
```

Status mapping: `COMPLETED` = the loop ended by itself with a submit; `TRUNCATED` = max_turns / budget / timeout / max tokens (kept, scored as failure); `ABORTED` = cancelled by the host; `FAILED` = loop or provider error (kept in the ledger, excluded from gate statistics).

## Event mapping per loop

- **dsh**: `tool/call` → `tool_call`; `tool/result` → `tool_result`; `assistant/message` (+usage) → `assistant`; first `request/header` → `system_prompt`; the submit tool's call → `output{source:'submit-tool'}`; `turn/end.reason` → `finished`.
- **claude-code**: assistant `tool_use` blocks → `tool_call`; `tool_result` blocks → `tool_result`; `system/init` tool list → `system_prompt` (hash of preset id + append); `ResultMessage` → `finished{cost.source:'self-reported'}`; the submit file written by the agent → `output{source:'submit-tool'}`.
- codex / pi: later (s4 §3–4 have the mapping).

## What the host does around a loop

1. `workdir.materialize` seals the directory (pack `materialize` + skill snapshot + `.task/token.json` + TMPDIR).
2. `loops.start(spec)`; the ledger tails `events` and stores `facts_sha`, usage, cost, tool calls, artifacts.
3. On `finished`, the host reads `<workdir>/<submit>.json`, validates it against the pack contract (`output.valid`), then runs pack `truth` and `score`.
4. `dispose()`; the workdir is kept as an artifact until the attempt's retention expires.

A loop never sees the ledger, truth, or scores; it sees only the sealed workdir and its spec.
