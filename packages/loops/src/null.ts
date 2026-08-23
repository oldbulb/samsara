// The built-in null loop: starts, says one empty assistant turn, finishes
// COMPLETED. Touches neither the workdir nor any model. Exists so the host
// plumbing (scope, workdir, ledger tailing) can be exercised end-to-end with
// no spend.

import type { AttemptSpec, HarnessFacts, LoopCapabilities, LoopEvent, LoopProvider, LoopRun, FinishedEvent } from './types.ts'

export const NULL_HARNESS_FACTS: HarnessFacts = {
  systemPromptMode: 'none',
  skillDelivery: 'prompt-inline',
  schemaEnforcement: 'permissive-tool',
  permission: 'none',
  reasoning: {},
  version: { loop: 'null@0' },
  sandbox: 'none',
}

export class NullLoopProvider implements LoopProvider {
  readonly name = 'null'
  readonly harnessFacts = NULL_HARNESS_FACTS
  readonly capabilities: LoopCapabilities = {
    perAttemptBaseUrl: false,
    perAttemptEnv: false,
    nativeSchema: 'none',
    toolFilter: false,
    nativeMaxTurns: false,
  }

  async start(spec: AttemptSpec): Promise<LoopRun> {
    const at = Date.now()
    const finished: FinishedEvent = {
      t: 'finished',
      at,
      status: 'COMPLETED',
      stopReason: 'completed',
      usage: { inputTokens: 0, outputTokens: 0 },
      cost: { source: 'unknown' },
      turns: 0,
      toolCalls: 0,
      artifacts: [],
    }
    const events: LoopEvent[] = [
      { t: 'started', at, native: { kind: 'null', id: spec.attemptId } },
      { t: 'assistant', at, turn: 0, textBytes: 0, usage: { inputTokens: 0, outputTokens: 0 } },
      finished,
    ]
    return {
      id: spec.attemptId,
      events: (async function* () { yield* events })(),
      result: Promise.resolve(finished),
      cancel() {},
      async dispose() {},
    }
  }
}
