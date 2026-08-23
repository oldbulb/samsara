// @samsara/loops-dsh — the 'dsh' loop provider: one attempt runs as an
// in-process dsh child agent created through ctx.agents (s5 §A.5 / §B.3),
// composed in its creation window (restricted tools, submit tool, skill and
// submit prompt sections, deny guard, limits) and driven for exactly one turn.
//
// The framework sees only the LoopProvider seam (docs/design/loops.md); the
// agent sees only the sealed workdir and its spec.

import { randomUUID } from 'node:crypto'
import {
  DSH_PIN,
  Schema,
  SessionId,
  createUserMessage,
  type Agent,
  type AgentHandle,
  type Context,
  type SessionEvent,
} from '@samsara/kernel'
import type { AttemptSpec, HarnessFacts, LoopEvent, LoopProvider, LoopRun } from '@samsara/loops'
import { createSubmitTool, submitInstruction } from '@samsara/submit'
import { matchesDeny, serializeArgs } from './deny.ts'
import { createEventMapper, finish } from './events.ts'
import { createLimits, type PriceTable } from './limits.ts'
import { EventQueue } from './queue.ts'
import { readSkill } from './skill.ts'

export { createEventMapper, finish, sha256 } from './events.ts'
export { createLimits, addUsage, priceUsage, type Limits, type PriceTable } from './limits.ts'
export { matchesDeny, serializeArgs } from './deny.ts'
export { EventQueue } from './queue.ts'
export { skillBody, readSkill } from './skill.ts'

export const name = 'loops-dsh'
export const inject = ['loops', 'agents', 'sessions']

export interface Config {
  /** USD per million tokens; when present `finished.cost` is `price-table`, else `unknown`. */
  pricePerMtok?: PriceTable
}

export const Config: Schema<Config> = Schema.object({
  // Nested objects default to {} under schemastery, so the fields stay optional
  // here and the table counts only when both prices are present (see priceTable).
  pricePerMtok: Schema.object({
    input: Schema.number(),
    output: Schema.number(),
    cacheRead: Schema.number(),
  }),
}) as unknown as Schema<Config>

function priceTable(config: Config): PriceTable | undefined {
  const table = config.pricePerMtok
  if (table === undefined || typeof table.input !== 'number' || typeof table.output !== 'number') return undefined
  return table
}

export const PROVIDER_NAME = 'dsh'

/** Tool names dsh-base registers for the file/search/shell surface (see README). */
export const DEFAULT_TOOL_ALLOW: readonly string[] = ['read', 'write', 'edit', 'grep', 'glob', 'bash']

export const HARNESS_FACTS: HarnessFacts = {
  systemPromptMode: 'dsh-persona',
  skillDelivery: 'prompt-inline',
  schemaEnforcement: 'scoped-tool+retry',
  permission: 'approval/policy=never',
  reasoning: {},
  version: { loop: DSH_PIN },
}

export class DshLoopProvider implements LoopProvider {
  readonly name = PROVIDER_NAME
  readonly harnessFacts = HARNESS_FACTS
  readonly capabilities = {
    perAttemptBaseUrl: false,
    perAttemptEnv: false,
    nativeSchema: 'tool' as const,
    toolFilter: true,
    nativeMaxTurns: false,
  }

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
  ) {}

  async start(spec: AttemptSpec): Promise<LoopRun> {
    if (spec.signal.aborted) throw new Error(`loops-dsh: attempt ${spec.attemptId} aborted before start`)
    const skill = readSkill(spec.skill.dir)
    const submitName = spec.tools.submitTool.name
    const events = new EventQueue<LoopEvent>()
    const mapper = createEventMapper({ submitToolName: submitName })
    const price = priceTable(this.config)
    const limits = createLimits({
      maxTurns: spec.limits.maxTurns,
      ...(spec.limits.maxBudgetUsd !== undefined ? { maxBudgetUsd: spec.limits.maxBudgetUsd } : {}),
      ...(price ? { price } : {}),
    })
    const sessionId = SessionId(randomUUID())
    const hostCtx = this.ctx
    let agent: Agent | undefined
    const cancel = (stop: 'timeout' | 'budget' | 'aborted', reason: string) => {
      if (!limits.trip(stop)) return
      agent?.cancel(stop === 'aborted' ? { kind: 'parent' } : { kind: 'hook', reason })
    }

    const handle: AgentHandle = await hostCtx.agents.create({
      sessionId,
      meta: { cwd: spec.workdir },
      agentOptions: { provider: spec.route.provider, model: spec.route.model },
      signal: spec.signal,
      setup(agentCtx: Context) {
        // 1. preset join first (order is load-bearing, s5 §B.4), then per-attempt registrations.
        agentCtx.get('agentPresets')?.composeFrom?.(agentCtx, hostCtx)
        if (spec.tools.allow.length > 0) agentCtx.tools.restrict({ allow: spec.tools.allow })
        agentCtx.tools.register(createSubmitTool({ ...spec.tools.submitTool, workdir: spec.workdir }))
        agentCtx.systemPrompt.section({ name: 'samsara:skill', order: 150, text: skill })
        agentCtx.systemPrompt.section({
          name: 'samsara:submit',
          order: 190,
          text: submitInstruction(submitName, spec.tools.submitTool.schema),
        })
        if (spec.tools.deny.length > 0) {
          agentCtx.tools.guard((exec) => {
            const hit = matchesDeny(serializeArgs(exec.arguments), spec.tools.deny)
            return hit === undefined ? undefined : `denied by attempt policy (pattern: ${hit})`
          })
        }
        // 2. observation: the committed session log → LoopEvents.
        agentCtx.on('session/event', (_session, event: SessionEvent) => {
          for (const mapped of mapper.map(event)) events.push(mapped)
          if (event.type === 'assistant/message' && limits.observeUsage(mapper.usage)) {
            agent?.cancel({ kind: 'hook', reason: 'budget' })
          }
        })
        // 3. limits: steps (maxTurns) and wall clock (maxDurationMs).
        agentCtx.on('agent/pre-step', (_payload, next) => {
          if (limits.preStep() === 'reject') return Promise.resolve({ kind: 'reject' as const })
          return next()
        })
        agentCtx.effect(() => {
          const timer = setTimeout(() => cancel('timeout', 'maxDurationMs'), spec.limits.maxDurationMs)
          return () => clearTimeout(timer)
        }, 'loops-dsh.maxDuration')
      },
    })
    agent = handle.agent

    const onAbort = () => cancel('aborted', 'host')
    spec.signal.addEventListener('abort', onAbort, { once: true })
    if (spec.signal.aborted) onAbort()

    events.push({ t: 'started', at: Date.now(), native: { kind: 'dsh-agent', id: String(sessionId) } })

    const result = (async () => {
      let error: unknown
      try {
        handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: spec.prompt }], source: { kind: 'user' } }))
        await handle.agent.whenIdle()
        await hostCtx.sessions.flush(handle.agent.session)
      } catch (e) {
        error = e ?? new Error('loops-dsh: drive failed')
      }
      const finished = finish({ at: Date.now(), mapper, limits, skillDelivery: this.harnessFacts.skillDelivery, ...(error !== undefined ? { error } : {}) })
      events.push(finished)
      events.close()
      return finished
    })()

    let disposed: Promise<void> | undefined
    return {
      id: spec.attemptId,
      events,
      result,
      cancel: (reason: string) => cancel('aborted', reason),
      dispose: () => {
        disposed ??= (async () => {
          spec.signal.removeEventListener('abort', onAbort)
          const settled = await Promise.allSettled([handle.dispose(), result])
          events.close()
          if (settled[0].status === 'rejected') throw settled[0].reason
        })()
        return disposed
      },
    }
  }
}

export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => ctx.loops.register(new DshLoopProvider(ctx, config)), 'loops-dsh.register')
}
