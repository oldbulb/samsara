// Plugin: mounts a subprocess gate (CommandGatePolicy) on `ctx.gate` for the
// lifetime of its scope. Once mounted after gate-default it is the policy that
// judges; running rounds under it needs a `gate_change` consent (architecture.md
// § Ledger).

import { Context, Schema } from '@oldbulb/samsara-kernel'
import { CommandGatePolicy, DEFAULT_COMMAND_GATE_TIMEOUT_MS } from './command.ts'

export const name = 'gate-command'
export const inject = ['gate']

export interface Config {
  command: string
  args?: string[]
  name: string
  version: string
  timeoutMs?: number
}

export const Config: Schema<Config> = Schema.object({
  command: Schema.string().required(),
  args: Schema.array(Schema.string()).default([]),
  name: Schema.string().required(),
  version: Schema.string().required(),
  timeoutMs: Schema.number().default(DEFAULT_COMMAND_GATE_TIMEOUT_MS),
})

export function apply(ctx: Context, config: Config): void {
  const policy = new CommandGatePolicy({
    command: config.command,
    args: config.args ?? [],
    name: config.name,
    version: config.version,
    timeoutMs: config.timeoutMs ?? DEFAULT_COMMAND_GATE_TIMEOUT_MS,
  })
  ctx.effect(() => ctx.gate.register(policy), 'gate-command')
}
