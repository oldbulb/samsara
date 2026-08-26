// The built-in null loop: starts, says one empty assistant turn, finishes
// COMPLETED. Calls no model. Exists so the host plumbing (scope, workdir,
// ledger tailing) can be exercised end-to-end with no spend. With a canned
// `submit` it also leaves that value as the attempt's submission (the
// @oldbulb/samsara-submit file convention), so a pack whose truth does not
// depend on the answer can run the whole challenger path — smoke's validity
// rule included — through it.

import { writeSubmit } from '@oldbulb/samsara-submit'
import type { AttemptSpec, HarnessFacts, LoopCapabilities, LoopEvent, LoopProvider, LoopRun, FinishedEvent } from './types.ts'

export const NULL_HARNESS_FACTS: HarnessFacts = {
  systemPromptMode: 'none',
  skillDelivery: 'prompt-inline',
  schemaEnforcement: 'permissive-tool',
  permission: 'none',
  reasoning: {},
  envelope: { config: 'absent', system: 'absent', tools: 'absent' },
  version: { loop: 'null@0' },
  sandbox: 'none',
}

export interface NullLoopOptions {
  /** Written as the submission of every attempt; null (the default) submits nothing. */
  submit?: Record<string, unknown> | null
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
    installed: false,
  }

  constructor(private readonly options: NullLoopOptions = {}) {}

  async start(spec: AttemptSpec): Promise<LoopRun> {
    const at = Date.now()
    const submit = this.options.submit ?? null
    if (submit !== null) writeSubmit(spec.workdir, spec.tools.submitTool.name, submit)
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
      ...(submit !== null ? [{ t: 'output', at, structured: submit, text: JSON.stringify(submit), source: 'submit-tool' } as const] : []),
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
