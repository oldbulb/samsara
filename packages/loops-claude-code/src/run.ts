// One attempt: build the SDK query, put its CLI process under the kernel's
// subprocess owner (inside our own effect, E4), consume every SDKMessage into
// the native transcript and the seam's events, settle exactly one `finished`.

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { query, type Options, type Query, type SDKMessage, type SpawnOptions } from '@anthropic-ai/claude-agent-sdk'
import { scrubbedParentEnv, type Context, type SubprocessHandle, type SubprocessSpawnSpec } from '@samsara/kernel'
import { buildEnv, configDir } from './env.ts'
import { classifyResult, MessageMapper, sha256, tokenUsage } from './mapper.ts'
import { claudeSpawnSpec, ManagedClaudeCodeProcess } from './process.ts'
import { EventQueue } from './queue.ts'
import type { Artifact, AttemptSpec, FinishedEvent, LoopEvent, LoopRun } from './seam.ts'
import { readSubmit, stripFrontmatter, submitFileInstruction } from './submit.ts'

export const STREAM_FILE = 'claude-stream.jsonl'

export interface RunDeps {
  ctx: Pick<Context, 'effect' | 'subprocess'>
  credentialValue: string
  graceMs: number
  /** Test seam: replaces the SDK's `query`. */
  queryFn?: typeof query
}

function thrown(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

export function systemPromptAppend(spec: AttemptSpec): string {
  const skillPath = join(spec.skill.dir, 'SKILL.md')
  const body = existsSync(skillPath) ? stripFrontmatter(readFileSync(skillPath, 'utf8')).trim() : ''
  return [body, submitFileInstruction(spec)].filter((s) => s.length > 0).join('\n\n')
}

export function queryOptions(
  spec: AttemptSpec,
  env: Record<string, string>,
  append: string,
  controller: AbortController,
  spawn: (s: SubprocessSpawnSpec) => SubprocessHandle,
  graceMs: number,
  capture: (child: SubprocessHandle) => void,
): Options {
  const opts: Options = {
    abortController: controller,
    cwd: spec.workdir,
    env: { ...scrubbedParentEnv(), ...env },
    persistSession: false,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    maxTurns: spec.limits.maxTurns,
    disallowedTools: ['AskUserQuestion', ...spec.tools.deny],
    systemPrompt: { type: 'preset', preset: 'claude_code', append },
    onElicitation: () => Promise.resolve({ action: 'decline' }),
    onUserDialog: () => Promise.resolve({ behavior: 'cancelled' as const }),
    supportedDialogKinds: ['refusal_fallback_prompt'],
    spawnClaudeCodeProcess: (options: SpawnOptions) => {
      const child = spawn(claudeSpawnSpec(options, graceMs))
      capture(child)
      return new ManagedClaudeCodeProcess(child)
    },
  }
  if (spec.limits.maxBudgetUsd !== undefined) opts.maxBudgetUsd = spec.limits.maxBudgetUsd
  return opts
}

export async function startRun(spec: AttemptSpec, deps: RunDeps): Promise<LoopRun> {
  if (spec.signal.aborted) throw new Error('loops-claude-code: attempt was aborted before startup')
  const queryFn = deps.queryFn ?? query

  mkdirSync(configDir(spec), { recursive: true })
  const streamPath = join(spec.tmpdir, STREAM_FILE)
  writeFileSync(streamPath, '')

  const append = systemPromptAppend(spec)
  const env = buildEnv(spec, deps.credentialValue)

  const controller = new AbortController()
  let cancelled = false
  let timedOut = false
  const abort = (why: string): void => {
    if (!controller.signal.aborted) controller.abort(new Error(`loops-claude-code: ${why}`))
  }
  const onSignal = (): void => {
    cancelled = true
    abort('attempt signal aborted')
  }
  spec.signal.addEventListener('abort', onSignal, { once: true })

  // E4: the child lives inside our effect; disposing the scope reaches it.
  let child: SubprocessHandle | undefined
  let disposeEffect: (() => unknown) | undefined
  const spawn = (s: SubprocessSpawnSpec): SubprocessHandle => {
    let spawned: SubprocessHandle | undefined
    disposeEffect = deps.ctx.effect(() => {
      spawned = deps.ctx.subprocess.spawn(s)
      return () => {
        spawned?.terminate()
      }
    }, 'loops-claude-code:child')
    return spawned!
  }

  let q: Query | undefined
  try {
    q = queryFn({
      prompt: spec.prompt,
      options: queryOptions(spec, env, append, controller, spawn, deps.graceMs, (c) => (child = c)),
    })
    if (child === undefined || child.pid <= 0) {
      throw new Error('loops-claude-code: the SDK did not publish a controllable Claude Code process')
    }
  } catch (error: unknown) {
    spec.signal.removeEventListener('abort', onSignal)
    abort('startup failed')
    try {
      q?.close()
    } catch {}
    if (child !== undefined) {
      child.terminate()
      await child.done.catch(() => undefined)
    }
    await Promise.resolve(disposeEffect?.()).catch(() => undefined)
    rmSync(configDir(spec), { recursive: true, force: true })
    throw thrown(error)
  }

  const publishedQuery = q
  const publishedChild = child
  const queue = new EventQueue<LoopEvent>()
  const mapper = new MessageMapper({ systemPromptAppend: append, pid: publishedChild.pid })

  const timer = setTimeout(() => {
    timedOut = true
    abort(`exceeded maxDurationMs=${spec.limits.maxDurationMs}`)
  }, spec.limits.maxDurationMs)

  const finish = (): FinishedEvent => {
    const at = Date.now()
    const result = mapper.result
    const { status, stopReason } = classifyResult(result, cancelled || controller.signal.aborted, timedOut)
    const artifacts: Artifact[] = [{ kind: 'transcript-native', path: streamPath, sha256: sha256(readFileSync(streamPath, 'utf8')) }]
    return {
      t: 'finished',
      at,
      status,
      stopReason,
      usage: tokenUsage(result?.usage),
      cost: result ? { usd: result.total_cost_usd, source: 'self-reported' } : { source: 'unknown' },
      turns: result?.num_turns ?? 0,
      toolCalls: mapper.toolCalls,
      artifacts,
    }
  }

  const consume = async (): Promise<FinishedEvent> => {
    try {
      for await (const message of publishedQuery as AsyncIterable<SDKMessage>) {
        appendFileSync(streamPath, JSON.stringify(message) + '\n')
        for (const ev of mapper.map(message)) queue.push(ev)
      }
    } catch {
      // Reported through `finished.status`, never as a rejection.
    }
    clearTimeout(timer)
    const submit = readSubmit(spec.workdir, spec.tools.submitTool.name)
    const at = Date.now()
    if (submit) {
      queue.push({ t: 'output', at, structured: submit.structured, text: submit.text, source: 'submit-tool' })
    } else {
      const text = mapper.result?.subtype === 'success' ? mapper.result.result : ''
      queue.push({ t: 'output', at, text, source: 'parsed-text' })
    }
    const finished = finish()
    queue.push(finished)
    queue.close()
    return finished
  }
  const result = consume()

  let disposed: Promise<void> | undefined
  const dispose = (): Promise<void> => {
    disposed ??= (async () => {
      spec.signal.removeEventListener('abort', onSignal)
      abort('disposed')
      try {
        publishedQuery.close()
      } catch {}
      publishedChild.terminate()
      await publishedChild.waitForExit().catch(() => undefined)
      await publishedChild.done.catch(() => undefined)
      await result
      await Promise.resolve(disposeEffect?.()).catch(() => undefined)
      rmSync(configDir(spec), { recursive: true, force: true })
    })()
    return disposed
  }

  return {
    id: spec.attemptId,
    events: queue,
    result,
    cancel(reason: string) {
      cancelled = true
      abort(`cancelled: ${reason}`)
    },
    dispose,
  }
}
