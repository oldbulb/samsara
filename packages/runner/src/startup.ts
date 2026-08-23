// samsara-run-startup: parse `dsh --profile host <command> ...` and publish the
// parsed values as the ordinary cordis service `samsaraRun`. Modelled on
// @deepseek-ai/dsh-headless/startup: the runner plugin injects the service,
// so nothing runs on --help or on a usage error.

import { Command, parseCmdline, type Context } from '@samsara/kernel'
import { TASK_SETS, type TaskSet } from '@samsara/book'
import type { RunRequest } from './run.ts'
import type { ChallengeRequest, GatePolicyName } from './challenge.ts'
import type { RoundRequest } from './round.ts'
import type { CertifyRequest } from './certify.ts'

export const name = 'samsara-run-startup'
export const inject = ['cmdlineArgs']
export const SAMSARA_RUN_SERVICE = 'samsaraRun'

export interface PromoteRequest {
  challengerId: string
  /** Seconds to wait for a sign-off over the socket when the ledger holds no consent yet. */
  wait?: number
}

export interface DemoteRequest {
  challengerId: string
  reason: string
}

export type SamsaraRunValues =
  | ({ command: 'run' } & RunRequest)
  | ({ command: 'challenge' } & ChallengeRequest)
  | ({ command: 'round' } & RoundRequest)
  | ({ command: 'certify' } & CertifyRequest)
  | ({ command: 'promote' } & PromoteRequest)
  | ({ command: 'demote' } & DemoteRequest)
  | { command: 'serve' }

export const DEFAULTS = { repeat: 1, out: 'data/runs', maxTurns: 50, maxMinutes: 20, nEffFloor: 3 } as const

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

const GATE_POLICIES: readonly GatePolicyName[] = ['default', 'permissive']

function gatePolicyName(v: string): GatePolicyName {
  if (!(GATE_POLICIES as readonly string[]).includes(v)) throw new Error(`--gate-policy must be one of ${GATE_POLICIES.join('|')}, got ${v}`)
  return v as GatePolicyName
}

/** The options `run`, `challenge`, `round` and `certify` share (`certify` names its loops itself). */
function withRunOptions(cmd: Command, loopOption = true): Command {
  cmd.requiredOption('--pack <dir>', 'pack directory containing pack.yaml')
  if (loopOption) cmd.requiredOption('--loop <name>', 'loop provider name (as registered on ctx.loops)')
  return cmd
    .requiredOption('--set <smoke|holdin|holdout>', 'task set', set)
    .option('--limit <n>', 'only the first n tasks of the set', int('--limit'))
    .option('--repeat <r>', 'attempts per task', int('--repeat'), DEFAULTS.repeat)
    .option('--out <dir>', 'output directory; attempts under <out>/attempts', DEFAULTS.out)
    .option('--max-turns <n>', 'per-attempt turn limit', int('--max-turns'), DEFAULTS.maxTurns)
    .option('--max-minutes <m>', 'per-attempt wall-clock limit', num('--max-minutes'), DEFAULTS.maxMinutes)
    .option('--allow <tools>', 'comma-separated tool allowlist (default: provider default)', list)
}

function runRequestOf(opts: Record<string, unknown>): RunRequest {
  return {
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
}

/** Build the program; `onRun` receives the parsed values. Fresh per call so tests can parse repeatedly. */
export function runProgram(onRun: (values: SamsaraRunValues) => void): Command {
  const program = new Command()
    .name('dsh --profile host')
    .description('samsara host: run a pack task set through a loop as champion attempts; evaluate, promote and demote challengers.')
    .helpOption('-h, --help', 'show this help')
  const checkRepeat = (values: RunRequest) => {
    if (values.repeat < 1) program.error('error: --repeat must be >= 1')
  }

  withRunOptions(program.command('run'))
    .description('run every task of one set (× repeat) and write <out>/attempts.jsonl')
    .addHelpText('after', `
Examples:
  dsh --profile host run --pack packs/<name> --loop dsh --set smoke --limit 2
`)
    .action((opts: Record<string, unknown>) => {
      const values = runRequestOf(opts)
      checkRepeat(values)
      onRun({ command: 'run', ...values })
    })

  withRunOptions(program.command('challenge'))
    .description('propose a challenger, diff-scan it, run it in a scope, judge it against the champion on the same tasks')
    .requiredOption('--surface <name>', 'the one surface the patch touches (v1: skill)')
    .requiredOption('--skill-dir <dir>', 'the challenger skill snapshot directory')
    .requiredOption('--intent <text>', 'what the patch is meant to change')
    .requiredOption('--metric <name>', 'primary metric of kind reality the gate decides on')
    .option('--n-eff-floor <n>', 'minimum distinct entities with paired data (S2)', int('--n-eff-floor'), DEFAULTS.nEffFloor)
    .option('--with-champion', 'also run the champion on the same tasks in this command', false)
    .option('--gate-policy <default|permissive>', 'TEST ONLY: permissive always promotes (recorded as gate-permissive@test)', gatePolicyName, 'default')
    .addHelpText('after', `
Examples:
  dsh --profile host challenge --pack packs/<name> --loop null --set smoke --limit 2 \\
    --surface skill --skill-dir /tmp/skill --intent "shorter instructions" --metric <metric> --with-champion
`)
    .action((opts: Record<string, unknown>) => {
      const values = runRequestOf(opts)
      checkRepeat(values)
      if (opts['surface'] !== 'skill') program.error(`error: --surface ${String(opts['surface'])} is not a v1 challenger surface (only skill)`)
      onRun({
        command: 'challenge',
        ...values,
        surface: 'skill',
        skillDir: opts['skillDir'] as string,
        intent: opts['intent'] as string,
        metric: opts['metric'] as string,
        nEffFloor: opts['nEffFloor'] as number,
        withChampion: opts['withChampion'] as boolean,
        gatePolicy: opts['gatePolicy'] as GatePolicyName,
      })
    })

  withRunOptions(program.command('round'))
    .description('render the proposer view, run a proposer, then diff-scan, run and judge its proposal as a challenger')
    .requiredOption('--proposer <name>', 'proposer adapter name (as registered on ctx.proposers; human may take --skill-dir/--intent)')
    .requiredOption('--metric <name>', 'primary metric of kind reality the gate decides on; the proposal must predict it')
    .option('--skill-dir <dir>', 'human proposer: the replacement skill directory')
    .option('--intent <text>', 'human proposer: what the patch is meant to change')
    .option('--n-eff-floor <n>', 'minimum distinct entities with paired data (S2)', int('--n-eff-floor'), DEFAULTS.nEffFloor)
    .option('--with-champion', 'also run the champion on the same tasks in this command', false)
    .option('--gate-policy <default|permissive>', 'TEST ONLY: permissive always promotes (recorded as gate-permissive@test)', gatePolicyName, 'default')
    .addHelpText('after', `
Examples:
  dsh --profile host round --pack packs/<name> --loop null --proposer human --set holdin --limit 2 \
    --skill-dir /tmp/skill --intent "shorter instructions" --metric <metric> --out data/runs/round-1
  dsh --profile host round --pack packs/<name> --loop claude-code --proposer claude-p --set holdin --metric <metric>
`)
    .action((opts: Record<string, unknown>) => {
      const values = runRequestOf(opts)
      checkRepeat(values)
      if ((opts['skillDir'] === undefined) !== (opts['intent'] === undefined)) program.error('error: --skill-dir and --intent go together')
      onRun({
        command: 'round',
        ...values,
        proposer: opts['proposer'] as string,
        metric: opts['metric'] as string,
        nEffFloor: opts['nEffFloor'] as number,
        withChampion: opts['withChampion'] as boolean,
        gatePolicy: opts['gatePolicy'] as GatePolicyName,
        ...(opts['skillDir'] !== undefined ? { humanSkillDir: opts['skillDir'] as string } : {}),
        ...(opts['intent'] !== undefined ? { intent: opts['intent'] as string } : {}),
      })
    })

  withRunOptions(program.command('certify'), false)
    .description('run one skill snapshot as a challenger on each loop in turn and print the per-loop certification table')
    .requiredOption('--skill-dir <dir>', 'the skill snapshot directory to certify')
    .requiredOption('--loops <a,b[,c]>', 'comma-separated loop provider names, certified in order', list)
    .option('--metric <name>', 'primary metric of kind reality the gate decides on', 'pass_rate')
    .option('--n-eff-floor <n>', 'minimum distinct entities with paired data (S2)', int('--n-eff-floor'), DEFAULTS.nEffFloor)
    .option('--gate-policy <default|permissive>', 'TEST ONLY: permissive always promotes (recorded as gate-permissive@test)', gatePolicyName, 'default')
    .addHelpText('after', `
Examples:
  dsh --profile host certify --pack packs/<name> --skill-dir /tmp/skill --loops dsh,claude-code --set smoke --limit 3
`)
    .action((opts: Record<string, unknown>) => {
      const { loop: _loop, ...values } = runRequestOf({ ...opts, loop: '' })
      checkRepeat({ ...values, loop: '' })
      const loops = opts['loops'] as string[]
      if (loops.length < 1) program.error('error: --loops needs at least one loop name')
      onRun({
        command: 'certify',
        ...values,
        skillDir: opts['skillDir'] as string,
        loops,
        metric: opts['metric'] as string,
        nEffFloor: opts['nEffFloor'] as number,
        gatePolicy: opts['gatePolicy'] as GatePolicyName,
      })
    })

  program
    .command('promote')
    .description('promote a judged challenger with the latest promote consent on the ledger')
    .argument('<challengerId>', 'challenger row id')
    .option('--wait <seconds>', 'open a sign-off and wait this long for a proof over the socket', num('--wait'))
    .action((challengerId: string, opts: Record<string, unknown>) => {
      onRun({ command: 'promote', challengerId, ...(opts['wait'] !== undefined ? { wait: opts['wait'] as number } : {}) })
    })

  program
    .command('demote')
    .description('remove a kept challenger from the champion')
    .argument('<challengerId>', 'challenger row id')
    .requiredOption('--reason <text>', 'why')
    .action((challengerId: string, opts: Record<string, unknown>) => {
      onRun({ command: 'demote', challengerId, reason: opts['reason'] as string })
    })

  program
    .command('serve')
    .description('keep the host alive (sign-off socket open, consents recorded) until SIGTERM/SIGINT')
    .action(() => { onRun({ command: 'serve' }) })

  return program
}

export function apply(ctx: Context): void {
  const program = runProgram((values) => {
    ctx.provide(SAMSARA_RUN_SERVICE, values)
  })
  parseCmdline(ctx, program)
}
