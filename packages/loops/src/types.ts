// @oldbulb/samsara-loops — the seam types, verbatim from docs/design/loops.md.
//
// A loop runs one attempt of one task under one configuration. The framework
// never talks to a loop except through these shapes.

import { createHash } from 'node:crypto'

export interface AttemptSpec {
  attemptId: string
  challengerId: string
  workdir: string
  skill: { name: string; dir: string; sha: string }
  prompt: string
  route: { provider: string; model: string; baseUrl?: string; credentialRef: string; reasoning?: Record<string, unknown> }
  outputSchema: object
  tools: { allow: string[]; deny: string[]; submitTool: { name: string; schema: object } }
  limits: { maxTurns: number; maxDurationMs: number; maxBudgetUsd?: number; maxOutputTokens?: number }
  env?: Record<string, string>
  tmpdir: string
  signal: AbortSignal
  /** Filesystem policy for the loop's subprocesses (composed by @oldbulb/samsara-sandbox); absent = unconfined. */
  sandbox?: { readOnly: string[]; readWrite: string[]; denied: string[] }
}

/**
 * Disjoint counts: `inputTokens` is the prompt the provider actually billed as
 * input, with any cached prefix already excluded and reported as
 * `cacheReadTokens`. A provider that reports them overlapping must subtract
 * before it fills this in, not after.
 */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

export interface Artifact {
  kind: 'transcript-native' | 'transcript-normalized' | 'stdout' | 'stderr' | 'workdir-diff'
  path: string
  sha256: string
}

export type FinishStatus = 'COMPLETED' | 'TRUNCATED' | 'ABORTED' | 'FAILED'
export type StopReason = 'completed' | 'aborted' | 'timeout' | 'max_turns' | 'budget' | 'schema_failed' | 'error'
export type CostSource = 'self-reported' | 'price-table' | 'proxy' | 'unknown'

export type LoopEvent =
  | { t: 'started'; at: number; native: { kind: string; id: string; pid?: number } }
  | {
      t: 'envelope'
      at: number
      /** What the model was shown, in dsh's request-envelope terms (`request/header`: config / system / tools). How faithfully each field is known is `HarnessFacts.envelope`. */
      config: { sha256: string; provider: string; model: string }
      system: { sha256: string; bytes: number }
      tools: { sha256: string; names: string[] }
    }
  | { t: 'tool_call'; at: number; callId: string; name: string; argsSha256: string; argsBytes: number; argsPreview?: string }
  | { t: 'tool_result'; at: number; callId: string; isError: boolean; bytes: number; durationMs?: number }
  | { t: 'assistant'; at: number; turn: number; textBytes: number; usage?: TokenUsage }
  | { t: 'output'; at: number; structured?: unknown; text: string; source: 'native-schema' | 'submit-tool' | 'parsed-text' }
  | {
      t: 'finished'
      at: number
      status: FinishStatus
      stopReason: StopReason
      usage: TokenUsage
      cost: { usd?: number; source: CostSource }
      turns: number
      toolCalls: number
      artifacts: Artifact[]
      /** Was the skill delivered and read: 'inline' when it is a prompt section (1.0 by construction), else the read fraction for this attempt. */
      skillUtilization?: number | 'inline'
    }

export type FinishedEvent = Extract<LoopEvent, { t: 'finished' }>

export interface LoopRun {
  readonly id: string
  readonly events: AsyncIterable<LoopEvent>
  readonly result: Promise<FinishedEvent>
  cancel(reason: string): void
  dispose(): Promise<void>
}

/**
 * How faithfully a loop reports one field of the request envelope:
 * `exact` — the harness exposes the content itself (dsh logs it as `request/header`);
 * `proxy` — an identifier and a version stand in for it (a preset id, a tool-name list);
 * `absent` — the loop shows the model nothing of the kind.
 */
export type EnvelopeFidelity = 'exact' | 'proxy' | 'absent'

export interface HarnessFacts {
  systemPromptMode: string
  skillDelivery: 'agents-skills-dir' | 'plugin-slash' | 'prompt-inline'
  schemaEnforcement: 'scoped-tool+retry' | 'cli-validator+retry' | 'provider-strict' | 'permissive-tool'
  permission: string
  reasoning: Record<string, unknown>
  /** Fidelity of each `envelope` field this loop reports. Static per provider, so it is part of facts_sha: rows whose envelopes were seen differently are not A/B-comparable. */
  envelope: { config: EnvelopeFidelity; system: EnvelopeFidelity; tools: EnvelopeFidelity }
  version: { loop: string; sdk?: string }
  /** Filesystem enforcement the provider's processes ran under on this host. */
  sandbox?: 'landlock' | 'none'
}

export interface LoopCapabilities {
  perAttemptBaseUrl: boolean
  perAttemptEnv: boolean
  nativeSchema: 'none' | 'tool' | 'validator'
  toolFilter: boolean
  nativeMaxTurns: boolean
}

export interface LoopProvider {
  readonly name: string
  readonly harnessFacts: HarnessFacts
  readonly capabilities: LoopCapabilities
  start(spec: AttemptSpec): Promise<LoopRun>
}

// ---------------------------------------------------------------- factsSha

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key]
      if (v !== undefined) out[key] = canonical(v)
    }
    return out
  }
  return value
}

/** Canonical JSON (sorted keys, undefined dropped): the form every envelope and facts hash is taken over. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value))
}

/** sha256 of the canonical JSON of a provider's harness facts. */
export function factsSha(facts: HarnessFacts): string {
  return createHash('sha256').update(canonicalJson(facts)).digest('hex')
}
