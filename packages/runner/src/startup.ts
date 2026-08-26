// samsara-run-startup: parse `dsh --profile host <command> ...` and publish the
// parsed values as the ordinary cordis service `samsaraRun`. Modelled on
// @deepseek-ai/dsh-headless/startup: the runner plugin injects the service,
// so nothing runs on --help or on a usage error.

import { Command, parseCmdline, type Context } from '@oldbulb/samsara-kernel'
import { TASK_SETS, type TaskSet } from '@oldbulb/samsara-book'
import type { RunRequest } from './run.ts'
import { gatePolicyNames, gatePresetOf, type ChallengeRequest, type GatePolicyName } from './challenge.ts'
import type { RoundRequest } from './round.ts'
import type { CertifyRequest } from './certify.ts'
import type { ExportRequest, ExportFormat } from './export.ts'
import type { BenchRequest } from './bench.ts'
import type { ProposeRequest } from './propose.ts'
import type { CalibrateRequest } from './calibrate.ts'
import type { ControlKind, ControlRequest } from './control.ts'
import type { ExperimentNewRequest } from './experiment.ts'
import type { CampaignRequest } from './campaign.ts'

export const name = 'samsara-run-startup'
export const inject = ['cmdlineArgs']
export const SAMSARA_RUN_SERVICE = 'samsaraRun'

export interface PromoteRequest {
  challengerId: string
  /** Seconds to wait for a sign-off over the socket when the ledger holds no consent yet. */
  wait?: number
  /** The round to decide; defaults to the open round listing the challenger. */
  round?: string
}

export interface DemoteRequest {
  challengerId: string
  reason: string
  /** Seconds to wait for a sign-off over the socket when the ledger holds no consent yet. */
  wait?: number
}

export interface GateChangeRequest {
  /** The gate policy's `name@version`: the consent's subject. */
  gate: string
  /** Seconds to wait for a sign-off over the socket when the ledger holds no consent yet. */
  wait?: number
}

export interface LedgerBackupRequest {
  /** The ledger's sqlite file (the bundle's `storage-sqlite` path). */
  db: string
  /** Where the copy goes (overwritten). */
  out: string
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
  | ({ command: 'gate-bench' } & BenchRequest)
  | ({ command: 'gate-change' } & GateChangeRequest)
  | ({ command: 'ledger-backup' } & LedgerBackupRequest)
  | ({ command: 'propose' } & ProposeRequest)
  | ({ command: 'calibrate' } & CalibrateRequest)
  | ({ command: 'experiment-new' } & ExperimentNewRequest)
  | ({ command: 'campaign' } & CampaignRequest)
  | ({ command: 'control' } & ControlRequest)
  | { command: 'status' }
  | { command: 'serve' }

export const DEFAULTS = { repeat: 1, parallel: 1, out: 'data/runs', maxTurns: 50, maxMinutes: 20, nEffFloor: 3, reruns: 3, rounds: 3, ledgerDb: 'data/ledger/samsara_ledger.sqlite' } as const

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

function direction(v: string): 'up' | 'down' {
  if (v !== 'up' && v !== 'down') throw new Error(`--direction must be up or down, got ${v}`)
  return v
}

function controlKind(v: string): ControlKind {
  if (v !== 'aa' && v !== 'inject') throw new Error(`control takes aa or inject, got ${v}`)
  return v
}

/** Commander hands parsers `(value, previous)`, so the flag is bound here rather than passed. */
function gateName(flag: string): (v: string) => GatePolicyName {
  return (v) => {
    try {
      gatePresetOf(v)
    } catch {
      throw new Error(`${flag} must be one of ${gatePolicyNames().join('|')}, got ${v}`)
    }
    return v
  }
}

const gatePolicyName = gateName('--gate-policy')

const GATE_POLICY_FLAG = '--gate-policy <name>'
const GATE_POLICY_HELP = `default (the gate mounted on ctx.gate, which alone can promote); fast: exploration preset at alpha 0.10 (gate-fast@0.1.0); permissive: TEST ONLY, always promotes (gate-permissive@test); or a catalog rule: ${gatePolicyNames().slice(3).join(', ')}. Any name but default judges as a shadow row (no verdict set) unless a gate_change consent names it`

function gateNames(v: string): GatePolicyName[] {
  return list(v).map(gateName('--gates'))
}

function exportFormat(v: string): ExportFormat {
  if (v !== 'otlp-json') throw new Error(`--format must be otlp-json, got ${v}`)
  return v
}

/**
 * The options `run`, `challenge`, `round`, `certify`, `calibrate`, `control` and `campaign` share (`certify` names its loops itself).
 * `resumable` (run only) makes --pack/--loop/--set plain options so `--resume <runDir>` can stand alone;
 * the action checks them by hand when --resume is absent. `set` makes --set optional with that default, or
 * leaves it out (`false`); `repeat: false` leaves --repeat out (calibrate takes --reruns instead).
 */
function withRunOptions(cmd: Command, opts: { loop?: boolean; resumable?: boolean; set?: TaskSet | false; repeat?: boolean } = {}): Command {
  const { loop: loopOption = true, resumable = false, set: defaultSet, repeat = true } = opts
  const required = (flags: string, description: string, parser?: (v: string) => unknown) =>
    resumable ? (parser ? cmd.option(flags, description, parser) : cmd.option(flags, description)) : (parser ? cmd.requiredOption(flags, description, parser) : cmd.requiredOption(flags, description))
  required('--pack <dir>', 'pack directory containing pack.yaml')
  if (loopOption) required('--loop <name>', 'loop provider name (as registered on ctx.loops)')
  if (defaultSet === undefined) required('--set <smoke|holdin|holdout>', 'task set', set)
  else if (defaultSet !== false) cmd.option('--set <smoke|holdin|holdout>', 'task set', set, defaultSet)
  cmd
    .option('--limit <n>', 'only the first n tasks of the set', int('--limit'))
    .option('--stratum <names>', 'comma-separated strata; only tasks of the set whose stratum is one of them', list)
  if (repeat) cmd.option('--repeat <r>', 'attempts per task', int('--repeat'), DEFAULTS.repeat)
  return cmd
    .option('--parallel <n>', 'attempts in flight at once (pack commands capped at 8)', int('--parallel'), DEFAULTS.parallel)
    .option('--out <dir>', 'output directory; attempts under <out>/attempts', DEFAULTS.out)
    .option('--max-turns <n>', 'per-attempt turn limit', int('--max-turns'), DEFAULTS.maxTurns)
    .option('--max-minutes <m>', 'per-attempt wall-clock limit', num('--max-minutes'), DEFAULTS.maxMinutes)
    .option('--allow <tools>', 'comma-separated tool allowlist (default: provider default)', list)
    .option('--env <provider>', 'environment provider the attempts run in (as registered on ctx.environments; default local)')
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
    ...(opts['stratum'] !== undefined ? { stratum: opts['stratum'] as string[] } : {}),
    ...(opts['allow'] !== undefined ? { allow: opts['allow'] as string[] } : {}),
    ...(opts['env'] !== undefined ? { env: opts['env'] as string } : {}),
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

  withRunOptions(program.command('run'), { resumable: true })
    .description('run every task of one set (× repeat) and write <out>/attempts.jsonl')
    .option('--skill-dir <dir>', "run this skill directory instead of the pack's (or the champion's) — e.g. a baseline to measure against")
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
      onRun({ command: 'run', ...values, ...(opts['skillDir'] !== undefined ? { skillDir: opts['skillDir'] as string } : {}) })
    })

  withRunOptions(program.command('challenge'))
    .description('propose a challenger, diff-scan it, run it in a scope, judge it against the champion on the same tasks')
    .requiredOption('--surface <name>', 'the one surface the patch touches (v1: skill)')
    .requiredOption('--skill-dir <dir>', 'the challenger skill snapshot directory')
    .requiredOption('--intent <text>', 'what the patch is meant to change')
    .requiredOption('--metric <name>', 'primary metric of kind reality the gate decides on')
    .option('--n-eff-floor <n>', 'minimum distinct entities with paired data (S2)', int('--n-eff-floor'), DEFAULTS.nEffFloor)
    .option('--with-champion', 'also run the champion on the same tasks in this command', false)
    .option(GATE_POLICY_FLAG, GATE_POLICY_HELP, gatePolicyName, 'default')
    .option('--round <id>', 'join this open round (its gate, shadows and experiment) instead of opening one; only before its first judgement (Holm\'s k freezes there), ROUND_CLOSED after it')
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
        ...(opts['round'] !== undefined ? { round: opts['round'] as string } : {}),
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
    .option(GATE_POLICY_FLAG, GATE_POLICY_HELP, gatePolicyName, 'default')
    .option('--round <id>', 'join this open round (its gate, shadows and experiment) instead of opening one; only before its first judgement (Holm\'s k freezes there), ROUND_CLOSED after it')
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
        ...(opts['round'] !== undefined ? { round: opts['round'] as string } : {}),
        ...(opts['skillDir'] !== undefined ? { humanSkillDir: opts['skillDir'] as string } : {}),
        ...(opts['intent'] !== undefined ? { intent: opts['intent'] as string } : {}),
      })
    })

  withRunOptions(program.command('certify'), { loop: false })
    .description('run one skill snapshot as a challenger on each loop in turn and print the per-loop certification table')
    .requiredOption('--skill-dir <dir>', 'the skill snapshot directory to certify')
    .requiredOption('--loops <a,b[,c]>', 'comma-separated loop provider names, certified in order', list)
    .requiredOption('--metric <name>', 'primary metric of kind reality the gate decides on')
    .option('--n-eff-floor <n>', 'minimum distinct entities with paired data (S2)', int('--n-eff-floor'), DEFAULTS.nEffFloor)
    .option(GATE_POLICY_FLAG, GATE_POLICY_HELP, gatePolicyName, 'default')
    .addHelpText('after', `
Examples:
  dsh --profile host certify --pack packs/<name> --skill-dir /tmp/skill --loops dsh,claude-code --set smoke --limit 3 --metric <metric>
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
    .description('decide the round of a judged challenger with the latest promote consent on the ledger: the service promotes the round\'s candidate')
    .argument('<challengerId>', 'challenger row id')
    .option('--wait <seconds>', 'open a sign-off and wait this long for a proof over the socket', num('--wait'))
    .option('--round <id>', 'the round to decide (default: the open round listing the challenger)')
    .action((challengerId: string, opts: Record<string, unknown>) => {
      onRun({
        command: 'promote', challengerId,
        ...(opts['wait'] !== undefined ? { wait: opts['wait'] as number } : {}),
        ...(opts['round'] !== undefined ? { round: opts['round'] as string } : {}),
      })
    })

  program
    .command('demote')
    .description('remove a kept challenger from the champion with the latest demote consent on the ledger')
    .argument('<challengerId>', 'challenger row id')
    .requiredOption('--reason <text>', 'why')
    .option('--wait <seconds>', 'open a sign-off and wait this long for a proof over the socket', num('--wait'))
    .action((challengerId: string, opts: Record<string, unknown>) => {
      onRun({ command: 'demote', challengerId, reason: opts['reason'] as string, ...(opts['wait'] !== undefined ? { wait: opts['wait'] as number } : {}) })
    })

  withRunOptions(program.command('calibrate'), { set: 'holdin', repeat: false })
    .description('measure the noise floor (S1): rerun the champion on one set with the null diff and record sd_paired per entity across reruns')
    .requiredOption('--metric <name>', 'primary metric of kind reality the floor is measured on')
    .option('--reruns <n>', 'same-config reruns of every task (>= 3)', int('--reruns'), DEFAULTS.reruns)
    .addHelpText('after', `
Examples:
  dsh --profile host calibrate --pack packs/<name> --loop dsh --set holdin --reruns 3 --metric <metric>
`)
    .action((opts: Record<string, unknown>) => {
      const { repeat: _r, ...values } = runRequestOf({ ...opts, repeat: 1 })
      checkRepeat({ ...values, repeat: 1 })
      if ((opts['reruns'] as number) < 3) program.error('error: --reruns must be >= 3')
      onRun({ command: 'calibrate', ...values, metric: opts['metric'] as string, reruns: opts['reruns'] as number })
    })

  const experiment = program
    .command('experiment')
    .description('experiments: pre-registered hypotheses with a prediction, a gate and a budget')
  experiment
    .command('new')
    .description('pre-register an experiment on the ledger before any spend; rounds opened with --experiment <id> are charged to it')
    .requiredOption('--pack <dir>', 'pack directory containing pack.yaml')
    .requiredOption('--hypothesis <text>', 'what is claimed')
    .requiredOption('--metric <name>', 'the metric the prediction is about')
    .option('--direction <up|down>', 'which way the metric should move', direction, 'up')
    .option('--magnitude <x>', 'the predicted size of the effect', num('--magnitude'))
    .option('--budget-usd <x>', 'spend cap in usd', num('--budget-usd'))
    .option('--budget-rounds <n>', 'rounds cap', int('--budget-rounds'))
    .option('--budget-attempts <n>', 'attempts cap', int('--budget-attempts'))
    .option('--budget-holdout-reveals <n>', 'holdout reveals cap', int('--budget-holdout-reveals'))
    .option('--n-eff-floor <n>', 'minimum distinct entities with paired data (S2) the rounds will run at', int('--n-eff-floor'), DEFAULTS.nEffFloor)
    .option('--who <name>', 'who registers it')
    .addHelpText('after', `
Examples:
  dsh --profile host experiment new --pack packs/<name> --hypothesis "shorter instructions raise the pass rate" \\
    --metric <metric> --direction up --magnitude 0.05 --budget-usd 20 --budget-rounds 5
`)
    .action((opts: Record<string, unknown>) => {
      onRun({
        command: 'experiment-new',
        pack: opts['pack'] as string,
        hypothesis: opts['hypothesis'] as string,
        metric: opts['metric'] as string,
        direction: opts['direction'] as 'up' | 'down',
        nEffFloor: opts['nEffFloor'] as number,
        ...(opts['magnitude'] !== undefined ? { magnitude: opts['magnitude'] as number } : {}),
        ...(opts['budgetUsd'] !== undefined ? { budgetUsd: opts['budgetUsd'] as number } : {}),
        ...(opts['budgetRounds'] !== undefined ? { budgetRounds: opts['budgetRounds'] as number } : {}),
        ...(opts['budgetAttempts'] !== undefined ? { budgetAttempts: opts['budgetAttempts'] as number } : {}),
        ...(opts['budgetHoldoutReveals'] !== undefined ? { budgetHoldoutReveals: opts['budgetHoldoutReveals'] as number } : {}),
        ...(opts['who'] !== undefined ? { who: opts['who'] as string } : {}),
      })
    })

  withRunOptions(program.command('campaign'), { set: 'holdin' })
    .description('run rounds under a pre-registered experiment until a stop rule: proposer → propose → open → run → judge → (holdout) → decide, per round')
    .requiredOption('--experiment <id>', 'the pre-registered experiment the rounds are charged to')
    .requiredOption('--proposer <name>', 'proposer adapter name (as registered on ctx.proposers)')
    .requiredOption('--metric <name>', 'primary metric of kind reality the rounds decide on')
    .option('--rounds <n>', 'stop after this many rounds', int('--rounds'), DEFAULTS.rounds)
    .option('--auto-holdout', 'go to holdout without a holdout_reveal consent when the screen passes', false)
    .option('--stop-on-promote', 'stop after the first promotion', false)
    .option('--max-consecutive-holds <n>', 'stop after this many holds in a row', int('--max-consecutive-holds'))
    .option('--max-repeat <r>', 'replicates the held-in tier may grow to when underpowered', int('--max-repeat'))
    .option('--holdout-repeat <r>', 'attempts per task at holdout (default: --repeat)', int('--holdout-repeat'))
    .option('--budget-usd <x>', 'stop once this much was spent', num('--budget-usd'))
    .option('--shadow-gates <names>', 'comma-separated mounted policies judged beside the gate, never deciding', list)
    .option('--n-eff-floor <n>', 'minimum distinct entities with paired data (S2)', int('--n-eff-floor'), DEFAULTS.nEffFloor)
    .option('--wait <seconds>', 'open a sign-off for each consent a round needs and wait this long; without it a missing consent pauses the campaign', num('--wait'))
    .addHelpText('after', `
Examples:
  dsh --profile host campaign --pack packs/<name> --loop dsh --experiment <id> --proposer claude-p --metric <metric> --rounds 5 --auto-holdout --stop-on-promote
`)
    .action((opts: Record<string, unknown>) => {
      const values = runRequestOf(opts)
      checkRepeat(values)
      if (values.set === 'holdout') program.error('error: campaign rounds screen on smoke or holdin; holdout is where they escalate')
      onRun({
        command: 'campaign',
        ...values,
        experiment: opts['experiment'] as string,
        proposer: opts['proposer'] as string,
        metric: opts['metric'] as string,
        rounds: opts['rounds'] as number,
        autoHoldout: opts['autoHoldout'] as boolean,
        stopOnPromote: opts['stopOnPromote'] as boolean,
        nEffFloor: opts['nEffFloor'] as number,
        ...(opts['maxConsecutiveHolds'] !== undefined ? { maxConsecutiveHolds: opts['maxConsecutiveHolds'] as number } : {}),
        ...(opts['maxRepeat'] !== undefined ? { maxRepeat: opts['maxRepeat'] as number } : {}),
        ...(opts['holdoutRepeat'] !== undefined ? { holdoutRepeat: opts['holdoutRepeat'] as number } : {}),
        ...(opts['budgetUsd'] !== undefined ? { budgetUsd: opts['budgetUsd'] as number } : {}),
        ...(opts['shadowGates'] !== undefined ? { shadowGates: opts['shadowGates'] as string[] } : {}),
        ...(opts['wait'] !== undefined ? { wait: opts['wait'] as number } : {}),
      })
    })

  withRunOptions(program.command('control'), { set: false })
    .description('a control round judged at holdout: aa runs the champion\'s own skill as the challenger (must not promote); inject runs --skill-dir with a known effect (must)')
    .argument('<aa|inject>', 'which control', controlKind)
    .requiredOption('--metric <name>', 'primary metric of kind reality the gate decides on')
    .option('--skill-dir <dir>', 'inject: the skill directory carrying the known effect')
    .option('--n-eff-floor <n>', 'minimum distinct entities with paired data (S2)', int('--n-eff-floor'), DEFAULTS.nEffFloor)
    .option('--experiment <id>', 'open the round under this pre-registered experiment')
    .option('--shadow-gates <names>', 'comma-separated mounted policies judged beside the gate, never deciding', list)
    .addHelpText('after', `
Examples:
  dsh --profile host control aa --pack packs/<name> --loop dsh --metric <metric>
  dsh --profile host control inject --pack packs/<name> --loop dsh --metric <metric> --skill-dir /tmp/skill-plus
`)
    .action((kind: ControlKind, opts: Record<string, unknown>) => {
      const { set: _set, ...values } = runRequestOf({ ...opts, set: 'holdout' })
      checkRepeat({ ...values, set: 'holdout' })
      if (kind === 'inject' && opts['skillDir'] === undefined) program.error('error: control inject needs --skill-dir')
      onRun({
        command: 'control',
        ...values,
        kind,
        metric: opts['metric'] as string,
        nEffFloor: opts['nEffFloor'] as number,
        ...(opts['skillDir'] !== undefined ? { skillDir: opts['skillDir'] as string } : {}),
        ...(opts['experiment'] !== undefined ? { experiment: opts['experiment'] as string } : {}),
        ...(opts['shadowGates'] !== undefined ? { shadowGates: opts['shadowGates'] as string[] } : {}),
      })
    })

  program
    .command('status')
    .description('the champion, the open rounds, the consents pending, the noise floors and the experiments, from ctx.lifecycle')
    .action(() => { onRun({ command: 'status' }) })

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

  const ledger = program
    .command('ledger')
    .description('ledger tooling: a consistent copy of the sqlite file while the host runs (E6)')
  ledger
    .command('backup')
    .description('copy the ledger sqlite file with the sqlite online backup API; safe while the host is writing')
    .option('--db <file>', `the ledger sqlite file (default ${DEFAULTS.ledgerDb}, the bundle's storage-sqlite path)`, DEFAULTS.ledgerDb)
    .requiredOption('--out <file>', 'destination file (overwritten)')
    .action((opts: Record<string, unknown>) => {
      onRun({ command: 'ledger-backup', db: opts['db'] as string, out: opts['out'] as string })
    })

  const gate = program
    .command('gate')
    .description('gate tooling: bench policies on recorded reruns, consent a policy into the promotion gate')
  gate
    .command('bench')
    .description('measure gate policies on recorded same-config reruns: null acceptance rate per gate, and the exact decisions on the real rerun pairs')
    .requiredOption('--attempts <file>', 'attempts.jsonl of >= 2 same-config reruns of one champion (every task scored on the metric)')
    .requiredOption('--tasks <file>', 'task rows (task_id, entity_key, stratum?) the bootstrap clusters by')
    .requiredOption('--metric <name>', 'the metric judged')
    .option('--gates <names>', `comma-separated gate names (default: default plus every catalog rule): ${gatePolicyNames().join(', ')}`, gateNames)
    .option('--gate-command <path>', 'also bench a gate written in any language, run as a subprocess (examples/gates/README.md)')
    .option('--resamples <n>', 'entity-cluster resamples per cell (default 200)', int('--resamples'))
    .option('--seed <n>', 'bootstrap seed (default 0)', int('--seed'))
    .option('--sesoi <x>', 'smallest effect worth a promotion, handed to every policy as its mde', num('--sesoi'))
    .option('--n-eff-floor <n>', 'minimum distinct entities with paired data (S2; default 20)', int('--n-eff-floor'))
    .option('--out <file>', 'also write the full bench result as JSON')
    .addHelpText('after', `
Examples:
  dsh --profile host gate bench --attempts data/runs/noise/attempts.jsonl --tasks packs/<name>/tasks/holdin.jsonl \\
    --metric <metric> --gates default,keep-better,miller --resamples 200 --out bench.json
`)
    .action((opts: Record<string, unknown>) => {
      onRun({
        command: 'gate-bench',
        attempts: opts['attempts'] as string,
        tasks: opts['tasks'] as string,
        metric: opts['metric'] as string,
        ...(opts['gates'] !== undefined ? { gates: opts['gates'] as GatePolicyName[] } : {}),
        ...(opts['gateCommand'] !== undefined ? { gateCommand: opts['gateCommand'] as string } : {}),
        ...(opts['resamples'] !== undefined ? { resamples: opts['resamples'] as number } : {}),
        ...(opts['seed'] !== undefined ? { seed: opts['seed'] as number } : {}),
        ...(opts['sesoi'] !== undefined ? { sesoi: opts['sesoi'] as number } : {}),
        ...(opts['nEffFloor'] !== undefined ? { nEffFloor: opts['nEffFloor'] as number } : {}),
        ...(opts['out'] !== undefined ? { out: opts['out'] as string } : {}),
      })
    })

  gate
    .command('change')
    .description('consent a gate policy into the promotion gate: a gate_change sign-off whose subject is its name@version')
    .argument('<name@version>', 'the gate policy, as gateMethodOf names it on the ledger')
    .option('--wait <seconds>', 'open a sign-off and wait this long for a proof over the socket', num('--wait'))
    .addHelpText('after', `
Examples:
  dsh --profile host gate change keep-better@0.1.0 --wait 600     # then: samsara-signoff confirm --row keep-better@0.1.0 --action gate_change ...
`)
    .action((gateName: string, opts: Record<string, unknown>) => {
      if (!/^[^@\s]+@[^@\s]+$/.test(gateName)) program.error(`error: gate change takes a policy name@version, got ${gateName}`)
      onRun({ command: 'gate-change', gate: gateName, ...(opts['wait'] !== undefined ? { wait: opts['wait'] as number } : {}) })
    })

  withRunOptions(program.command('propose'), { loop: false })
    .description('render the proposer view, run a proposer once, validate and diff-scan its proposal — and stop (--dry-run): no scope, no attempt, no spend')
    .requiredOption('--proposer <name|./command>', 'proposer adapter name (as registered on ctx.proposers), or a path to an executable run under the command contract')
    .requiredOption('--metric <name>', 'primary metric the proposal must predict (what a round would judge)')
    .option('--loop <name>', 'loop provider the view describes as the environment', 'null')
    .option('--skill-dir <dir>', 'human proposer: the replacement skill directory')
    .option('--intent <text>', 'human proposer: what the patch is meant to change')
    .option('--dry-run', 'stop after the diff scan (the only mode for now; `round` is the full path)', false)
    .addHelpText('after', `
Examples:
  dsh --profile host propose --pack packs/<name> --proposer ./examples/proposers/noop.py --set smoke --limit 2 --metric <metric> --dry-run
`)
    .action((opts: Record<string, unknown>) => {
      if (opts['dryRun'] !== true) program.error('error: propose runs only with --dry-run for now; the full path (scope, attempts, gate, ledger) is `round`')
      const values = runRequestOf(opts)
      checkRepeat(values)
      if ((opts['skillDir'] === undefined) !== (opts['intent'] === undefined)) program.error('error: --skill-dir and --intent go together')
      onRun({
        command: 'propose',
        ...values,
        proposer: opts['proposer'] as string,
        metric: opts['metric'] as string,
        dryRun: true,
        ...(opts['skillDir'] !== undefined ? { humanSkillDir: opts['skillDir'] as string } : {}),
        ...(opts['intent'] !== undefined ? { intent: opts['intent'] as string } : {}),
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
