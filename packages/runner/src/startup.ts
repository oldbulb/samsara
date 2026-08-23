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
import type { ExportRequest, ExportFormat } from './export.ts'

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
  /** `run --resume <runDir>`: the request is read from `<runDir>/run.json` (see steps.ts). */
  | { command: 'run'; resumeDir: string }
  | ({ command: 'challenge' } & ChallengeRequest)
  | ({ command: 'round' } & RoundRequest)
  | ({ command: 'certify' } & CertifyRequest)
  | ({ command: 'promote' } & PromoteRequest)
  | ({ command: 'demote' } & DemoteRequest)
  | ({ command: 'export' } & ExportRequest)
  | { command: 'serve' }

export const DEFAULTS = { repeat: 1, parallel: 1, out: 'data/runs', maxTurns: 50, maxMinutes: 20, nEffFloor: 3 } as const

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

function exportFormat(v: string): ExportFormat {
  if (v !== 'otlp-json') throw new Error(`--format must be otlp-json, got ${v}`)
  return v
}

/**
 * The options `run`, `challenge`, `round` and `certify` share (`certify` names its loops itself).
 * `resumable` (run only) makes --pack/--loop/--set plain options so `--resume <runDir>` can stand alone;
 * the action checks them by hand when --resume is absent.
 */
function withRunOptions(cmd: Command, loopOption = true, resumable = false): Command {
  const required = (flags: string, description: string, parser?: (v: string) => unknown) =>
    resumable ? (parser ? cmd.option(flags, description, parser) : cmd.option(flags, description)) : (parser ? cmd.requiredOption(flags, description, parser) : cmd.requiredOption(flags, description))
  required('--pack <dir>', 'pack directory containing pack.yaml')
  if (loopOption) required('--loop <name>', 'loop provider name (as registered on ctx.loops)')
  required('--set <smoke|holdin|holdout>', 'task set', set)
  return cmd
    .option('--limit <n>', 'only the first n tasks of the set', int('--limit'))
    .option('--repeat <r>', 'attempts per task', int('--repeat'), DEFAULTS.repeat)
    .option('--parallel <n>', 'attempts in flight at once (pack commands capped at 8)', int('--parallel'), DEFAULTS.parallel)
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
    parallel: opts['parallel'] as number,
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
    if ((values.parallel ?? 1) < 1) program.error('error: --parallel must be >= 1')
  }

  withRunOptions(program.command('run'), true, true)
    .description('run every task of one set (× repeat) and write <out>/attempts.jsonl')
    .option('--resume <runDir>', 're-enter the run recorded in <runDir>/run.json, skipping completed steps (no other option is read)')
    .addHelpText('after', `
Examples:
  dsh --profile host run --pack packs/<name> --loop dsh --set smoke --limit 2
  dsh --profile host run --resume data/runs/run-1     # finish a killed run: finished loops are never re-run
`)
    .action((opts: Record<string, unknown>) => {
      if (opts['resume'] !== undefined) {
        onRun({ command: 'run', resumeDir: opts['resume'] as string })
        return
      }
      for (const [key, flag] of [['pack', '--pack <dir>'], ['loop', '--loop <name>'], ['set', '--set <smoke|holdin|holdout>']] as const) {
        if (opts[key] === undefined) program.error(`error: required option '${flag}' not specified`)
      }
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
    .command('export')
    .description('write the loop events of every attempt under a run directory as OpenTelemetry GenAI spans')
    .requiredOption('--run <dir>', 'run directory (holds attempts/<attemptId>/events.jsonl)')
    .requiredOption('--out <file>', 'output file')
    .option('--format <otlp-json>', 'output format', exportFormat, 'otlp-json')
    .option('--challenger-id <id>', 'samsara.challenger_id on every span')
    .option('--tier <smoke|holdin|holdout|live>', 'samsara.tier on every span')
    .option('--model <id>', 'gen_ai.request.model on every span')
    .option('--provider <name>', 'gen_ai.provider.name on every span')
    .addHelpText('after', `
Examples:
  dsh --profile host export --run data/runs/run-1 --format otlp-json --out run-1.otlp.json
`)
    .action((opts: Record<string, unknown>) => {
      onRun({
        command: 'export',
        run: opts['run'] as string,
        out: opts['out'] as string,
        format: opts['format'] as ExportFormat,
        ...(opts['challengerId'] !== undefined ? { challengerId: opts['challengerId'] as string } : {}),
        ...(opts['tier'] !== undefined ? { tier: opts['tier'] as string } : {}),
        ...(opts['model'] !== undefined ? { model: opts['model'] as string } : {}),
        ...(opts['provider'] !== undefined ? { provider: opts['provider'] as string } : {}),
      })
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
