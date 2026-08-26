// CommandGatePolicy: a gate policy written in any language, run as a
// subprocess. The request goes in as JSON on stdin, the judgement comes back
// as JSON on stdout (docs: examples/gates/README.md), and the same request
// must yield the same output — the seed and everything else the gate needs
// are in the request, never in the environment.
//
// The child runs asynchronously with node:child_process, so a slow gate never
// blocks the host event loop. The gate is a fixed point on the host root tree,
// outside every challenger scope, so E4's `ctx.subprocess` rule for scoped
// effects does not apply; what does apply is E5: the child sees a minimal,
// explicit environment, never the parent's.

import { spawn } from 'node:child_process'
import { parseGateJudgement } from './spec.ts'
import type { CompareRequest, GateJudgement, GatePolicyProvider } from './types.ts'

export const DEFAULT_COMMAND_GATE_TIMEOUT_MS = 60_000
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024
/** The only parent variables that reach the child (E5); `options.env` adds to them. */
const PASSTHROUGH_ENV = ['PATH', 'HOME', 'LANG'] as const

export interface CommandGateOptions {
  command: string
  args?: string[]
  /** Reported as `name@version` in `gateMethod` on every verdict row. */
  name: string
  version: string
  timeoutMs?: number
  cwd?: string
  /** Extra variables for the child; explicit, never the parent env. */
  env?: Record<string, string>
}

export type GateCommandErrorCode = 'EXIT' | 'TIMEOUT' | 'BAD_OUTPUT'

export class GateCommandError extends Error {
  constructor(message: string, readonly code: GateCommandErrorCode, readonly stderr: string) {
    super(message)
    this.name = 'GateCommandError'
  }
}

function childEnv(extra: Record<string, string> | undefined): Record<string, string> {
  const env: Record<string, string> = {}
  for (const k of PASSTHROUGH_ENV) {
    const v = process.env[k]
    if (v !== undefined) env[k] = v
  }
  return { ...env, ...extra }
}

export class CommandGatePolicy implements GatePolicyProvider {
  readonly name: string
  readonly version: string
  private readonly command: string
  private readonly args: string[]
  private readonly timeoutMs: number
  private readonly cwd: string | undefined
  private readonly env: Record<string, string>

  constructor(options: CommandGateOptions) {
    this.name = options.name
    this.version = options.version
    this.command = options.command
    this.args = [...(options.args ?? [])]
    this.timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_GATE_TIMEOUT_MS
    this.cwd = options.cwd
    this.env = childEnv(options.env)
    if (!(Number.isFinite(this.timeoutMs) && this.timeoutMs > 0)) throw new RangeError(`gate/command: timeoutMs must be positive and finite, got ${options.timeoutMs}`)
  }

  judge(req: CompareRequest): Promise<GateJudgement> {
    const label = `${this.name}@${this.version} (${this.command})`
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, this.args, {
        env: this.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(this.cwd !== undefined ? { cwd: this.cwd } : {}),
      })
      const out: Buffer[] = []
      const err: Buffer[] = []
      let outBytes = 0
      let errBytes = 0
      let timedOut = false
      let overflowed = false
      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, this.timeoutMs)
      const collect = (into: Buffer[], count: (n: number) => number) => (chunk: Buffer) => {
        if (count(chunk.length) > MAX_OUTPUT_BYTES) {
          overflowed = true
          child.kill('SIGKILL')
          return
        }
        into.push(chunk)
      }
      child.stdout.on('data', collect(out, n => (outBytes += n)))
      child.stderr.on('data', collect(err, n => (errBytes += n)))
      // The child may exit before reading its stdin (a refusal, a crash): EPIPE here is not the failure to report.
      child.stdin.on('error', () => {})
      child.on('error', e => {
        clearTimeout(timer)
        reject(new GateCommandError(`gate ${label} failed to start: ${e.message}`, 'EXIT', Buffer.concat(err).toString('utf8')))
      })
      child.on('close', (status, signal) => {
        clearTimeout(timer)
        const stderr = Buffer.concat(err).toString('utf8')
        if (timedOut) return reject(new GateCommandError(`gate ${label} timed out after ${this.timeoutMs}ms (killed)`, 'TIMEOUT', stderr))
        if (overflowed) return reject(new GateCommandError(`gate ${label} wrote more than ${MAX_OUTPUT_BYTES} bytes (killed)`, 'EXIT', stderr))
        if (status !== 0) {
          const how = status !== null ? `exited ${status}` : `killed by ${signal}`
          return reject(new GateCommandError(`gate ${label} ${how}`, 'EXIT', stderr))
        }
        try {
          resolve(parseGateJudgement(Buffer.concat(out).toString('utf8')))
        } catch (e) {
          reject(new GateCommandError(`gate ${this.name}@${this.version}: ${(e as Error).message}`, 'BAD_OUTPUT', stderr))
        }
      })
      child.stdin.end(JSON.stringify(req))
    })
  }
}
