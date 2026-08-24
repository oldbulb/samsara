// Projection from the kernel's managed subprocess handle to the Claude Agent
// SDK's custom-spawn interface. Same shape as dsh's own subagent-claude-code
// provider: the SDK keeps the stream-json framing, the kernel keeps the tree.

import { EventEmitter } from 'node:events'
import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk'
import { scrubbedParentEnv, type SubprocessHandle, type SubprocessOutcome, type SubprocessSpawnSpec } from '@oldbulb/samsara-kernel'

function thrown(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

/**
 * The SDK hands over a complete child env; the subprocess seam merges `env`
 * onto `scrubbedParentEnv()`. Tombstone every ambient name the SDK removed so
 * the merge reproduces the SDK's intent exactly.
 */
export function sdkEnvironmentOverlay(env: SpawnOptions['env']): NodeJS.ProcessEnv {
  const overlay: NodeJS.ProcessEnv = { ...env }
  for (const name of Object.keys(scrubbedParentEnv())) {
    if (!(name in env)) overlay[name] = undefined
  }
  return overlay
}

export function claudeSpawnSpec(options: SpawnOptions, graceMs: number): SubprocessSpawnSpec {
  if (options.cwd === undefined || options.cwd.length === 0) {
    throw new Error('loops-claude-code: SDK spawn request omitted its workspace')
  }
  return {
    argv: [options.command, ...options.args],
    cwd: options.cwd,
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
    graceMs,
    signal: options.signal,
    env: sdkEnvironmentOverlay(options.env),
  }
}

type ExitListener = (code: number | null, signal: NodeJS.Signals | null) => void
type ErrorListener = (error: Error) => void

export class ManagedClaudeCodeProcess implements SpawnedProcess {
  readonly stdin
  readonly stdout
  private readonly events = new EventEmitter()
  private outcomeValue: SubprocessOutcome | undefined
  private killRequested = false

  constructor(private readonly child: SubprocessHandle) {
    this.stdin = child.stdin as NonNullable<SubprocessHandle['stdin']>
    this.stdout = child.stdout as NonNullable<SubprocessHandle['stdout']>
    this.events.on('error', () => {})
    void child.done.then(
      (outcome) => {
        this.outcomeValue = outcome
        this.events.emit('exit', outcome.exitCode, outcome.signal)
      },
      (error: unknown) => {
        this.events.emit('error', thrown(error))
      },
    )
  }

  get killed(): boolean {
    return this.killRequested
  }

  get exitCode(): number | null {
    return this.outcomeValue?.exitCode ?? null
  }

  get signalCode(): NodeJS.Signals | null {
    return this.outcomeValue?.signal ?? null
  }

  get outcome(): SubprocessOutcome | undefined {
    return this.outcomeValue
  }

  kill(_signal: NodeJS.Signals): boolean {
    if (this.killRequested || this.outcomeValue !== undefined) return false
    this.killRequested = true
    this.child.terminate()
    return true
  }

  on(event: 'exit' | 'error', listener: ExitListener | ErrorListener): void {
    this.events.on(event, listener)
  }

  once(event: 'exit' | 'error', listener: ExitListener | ErrorListener): void {
    this.events.once(event, listener)
  }

  off(event: 'exit' | 'error', listener: ExitListener | ErrorListener): void {
    this.events.off(event, listener)
  }
}
