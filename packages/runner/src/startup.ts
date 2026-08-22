// samsara-run-startup: parse `dsh --profile host run ...` and publish the
// parsed values as the ordinary cordis service `samsaraRun`. Modelled on
// @deepseek-ai/dsh-headless/startup: the runner plugin injects the service,
// so nothing runs on --help or on a usage error.

import { Command, parseCmdline, type Context } from '@samsara/kernel'
import { TASK_SETS, type TaskSet } from '@samsara/book'
import type { RunRequest } from './run.ts'

export const name = 'samsara-run-startup'
export const inject = ['cmdlineArgs']
export const SAMSARA_RUN_SERVICE = 'samsaraRun'

export type SamsaraRunValues = RunRequest

export const DEFAULTS = { repeat: 1, out: 'data/runs', maxTurns: 50, maxMinutes: 20 } as const

function int(label: string) {
  return (v: string): number => {
    const n = Number(v)
    if (!Number.isInteger(n) || n < 0) throw new Error(`${label} must be a non-negative integer, got ${v}`)
    return n
  }
}

function num(label: string) {
  return (v: string): number => {
    const n = Number(v)
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${label} must be a positive number, got ${v}`)
    return n
  }
}

function set(v: string): TaskSet {
  if (!(TASK_SETS as readonly string[]).includes(v)) throw new Error(`--set must be one of ${TASK_SETS.join('|')}, got ${v}`)
  return v as TaskSet
}

function list(v: string): string[] {
  return v.split(',').map((s) => s.trim()).filter(Boolean)
}

/** Build the program; `onRun` receives the parsed values. Fresh per call so tests can parse repeatedly. */
export function runProgram(onRun: (values: SamsaraRunValues) => void): Command {
  const program = new Command()
    .name('dsh --profile host')
    .description('samsara host: run a pack task set through a loop as champion attempts.')
    .helpOption('-h, --help', 'show this help')
  program
    .command('run')
    .description('run every task of one set (× repeat) and write <out>/attempts.jsonl')
    .requiredOption('--pack <dir>', 'pack directory containing pack.yaml')
    .requiredOption('--loop <name>', 'loop provider name (as registered on ctx.loops)')
    .requiredOption('--set <smoke|holdin|holdout>', 'task set', set)
    .option('--limit <n>', 'only the first n tasks of the set', int('--limit'))
    .option('--repeat <r>', 'attempts per task', int('--repeat'), DEFAULTS.repeat)
    .option('--out <dir>', 'output directory; attempts under <out>/attempts', DEFAULTS.out)
    .option('--max-turns <n>', 'per-attempt turn limit', int('--max-turns'), DEFAULTS.maxTurns)
    .option('--max-minutes <m>', 'per-attempt wall-clock limit', num('--max-minutes'), DEFAULTS.maxMinutes)
    .option('--allow <tools>', 'comma-separated tool allowlist (default: provider default)', list)
    .addHelpText('after', `
Examples:
  dsh --profile host run --pack packs/<name> --loop dsh --set smoke --limit 2
`)
    .action((opts: Record<string, unknown>) => {
      const values: SamsaraRunValues = {
        pack: opts['pack'] as string,
        loop: opts['loop'] as string,
        set: opts['set'] as TaskSet,
        repeat: opts['repeat'] as number,
        out: opts['out'] as string,
        maxTurns: opts['maxTurns'] as number,
        maxMinutes: opts['maxMinutes'] as number,
        ...(opts['limit'] !== undefined ? { limit: opts['limit'] as number } : {}),
        ...(opts['allow'] !== undefined ? { allow: opts['allow'] as string[] } : {}),
      }
      if (values.repeat < 1) program.error('error: --repeat must be >= 1')
      onRun(values)
    })
  return program
}

export function apply(ctx: Context): void {
  const program = runProgram((values) => {
    ctx.provide(SAMSARA_RUN_SERVICE, values)
  })
  parseCmdline(ctx, program)
}
