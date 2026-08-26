// samsara-runner: the cordis plugin that turns the parsed `samsaraRun` request
// into work. It waits for the loader so every loop provider has registered,
// resolves the route from agentDefaultModel + this plugin's config, dispatches
// on the command (run / challenge / round / certify / propose / calibrate /
// control / campaign / experiment new / status / promote / demote / serve /
// export / gate bench / gate change), prints a summary, and exits through
// ctx.appExit. It mounts `runSet` as ctx.executor, the attempt executor
// ctx.lifecycle runs attempts through; every command that changes a
// challenger or a round calls the service and performs no transition itself.

import { dirname, resolve } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { Schema, type Context } from '@oldbulb/samsara-kernel'
import type {} from '@oldbulb/samsara-loops'
import type {} from '@oldbulb/samsara-environments'
import { backupSqlite, type ConsentRow } from '@oldbulb/samsara-ledger'
import type {} from '@oldbulb/samsara-scope'
import type {} from '@oldbulb/samsara-gate'
import type {} from '@oldbulb/samsara-champion'
import type {} from '@oldbulb/samsara-proposers'
import type {} from '@oldbulb/samsara-lifecycle'
import type { ConsentRecord, Signoff, SignoffAction } from '@oldbulb/samsara-signoff'
import { runSet, type RouteConfig } from './run.ts'
import { readRunRecord } from './steps.ts'
import { challenge, formatChallenge } from './challenge.ts'
import { round, formatRound } from './round.ts'
import { certify, formatCertify } from './certify.ts'
import { formatSummary } from './summary.ts'
import { exportRun, formatExport, type ExportRequest } from './export.ts'
import { benchRun, formatBench, type BenchRequest } from './bench.ts'
import { propose, formatPropose, isCommandProposer, type ProposeDeps, type ProposeRequest } from './propose.ts'
import { calibrate, formatCalibrate } from './calibrate.ts'
import { control, formatControl } from './control.ts'
import { experimentNew, formatExperiment } from './experiment.ts'
import { formatStatus } from './status.ts'
import { campaign, formatCampaign } from './campaign.ts'
import { SAMSARA_RUN_SERVICE, type DemoteRequest, type GateChangeRequest, type LedgerBackupRequest, type PromoteRequest, type SamsaraRunValues } from './startup.ts'
import { createAdapter as createCommandAdapter } from '@oldbulb/samsara-proposers/plugin-command'

export const name = 'samsara-runner'
// subprocess: `propose --proposer ./command` spawns through the kernel's seam (E4) from this plugin's own context.
// environments: one environment per attempt is opened on the registry (`--env`, local by default).
export const inject = [SAMSARA_RUN_SERVICE, 'loops', 'agentDefaultModel', 'ledger', 'lifecycle', 'subprocess', 'environments']

export interface Config {
  /** Per-attempt base URL handed to the loop (route.baseUrl); empty = provider default. */
  baseUrl?: string
  /** Credential reference resolved by the loop through ctx.credentials (E5); never a secret. */
  credentialRef?: string
  /** Optional lane tag forwarded under route.reasoning.lane for proxies that key on it. */
  lane?: string
  /**
   * What the ledger records as `route.base_url_kind`. A base URL is not by
   * itself evidence of a proxy — a vendor may serve a second wire on its own
   * host — so a deployment that sets `baseUrl` for that reason declares
   * `direct` here. Omitted, the kind is inferred from `baseUrl`.
   */
  baseUrlKind?: 'direct' | 'proxy'
}

export const Config: Schema<Config> = Schema.object({
  baseUrl: Schema.string(),
  credentialRef: Schema.string(),
  lane: Schema.string(),
  baseUrlKind: Schema.union(['direct', 'proxy'] as const),
})

export { runSet, readSubmit, submitToolName, sanitizeId, newRunId, championProposal, envLockOf, writeEnvLock, environmentSpecOf, declaredEnvironmentSha, PACK_STAGE_CAP, HEARTBEAT_MS } from './run.ts'
export { Semaphore, WriterQueue, runPool } from './pool.ts'
export { STEPS, STEPS_DIR, RUN_RECORD, readStep, writeStep, completedSteps, isComplete, readRunRecord, writeRunRecord, stepPath } from './steps.ts'
export type { Step, StepMarker, StepData, RunRecord } from './steps.ts'
export type { RunRequest, RunDeps, RunResult, AttemptRow, ScoreLine, RouteConfig, Loops, LedgerSink, Materialize } from './run.ts'
export { challenge, formatChallenge, challengerProposalOf, scoredAttemptsOf, gateFor, roundFor, runOptionsOf, GATE_DEFAULT, GATE_FAST, GATE_PERMISSIVE, GATE_PRESETS, gatePolicyNames, gatePresetOf } from './challenge.ts'
export type { ChallengeRequest, ChallengeDeps, ChallengeLedger, ChallengeLifecycle, ChallengeResult, GatePolicyName, GateSelection } from './challenge.ts'
export { calibrate, formatCalibrate } from './calibrate.ts'
export type { CalibrateRequest, CalibrateDeps } from './calibrate.ts'
export { control, formatControl } from './control.ts'
export type { ControlKind, ControlRequest, ControlDeps } from './control.ts'
export { experimentNew, formatExperiment } from './experiment.ts'
export type { ExperimentNewRequest, ExperimentNewDeps } from './experiment.ts'
export { formatStatus } from './status.ts'
export { campaign, campaignRunOf, formatCampaign, formatEvent } from './campaign.ts'
export type { CampaignRequest, CampaignDeps } from './campaign.ts'
export { round, formatRound, renderView, adapterOf, checkProposal, viewEnvironmentOf, formatEnvironment, VIEW_DIR, PROPOSER_DIR, VIEW_VERSION, VIEW_FILES, ENVIRONMENT_FILE } from './round.ts'
export type { RoundRequest, RoundDeps, RoundResult, ViewEnvironment, SkillProposal } from './round.ts'
export { propose, formatPropose, isCommandProposer } from './propose.ts'
export type { ProposeRequest, ProposeDeps, ProposeResult } from './propose.ts'
export { benchRun, benchGatesOf, readJsonl, formatBench, GATE_COMMAND_VERSION } from './bench.ts'
export type { BenchRequest } from './bench.ts'
export { certify, formatCertify, utilizationOf } from './certify.ts'
export type { CertifyRequest, CertifyDeps, CertifyResult, CertifyRow, CrossCheck } from './certify.ts'
export { summarize, formatSummary } from './summary.ts'
export { exportRun, findEventFiles, readEvents, formatExport } from './export.ts'
export type { ExportRequest, ExportResult, ExportFormat } from './export.ts'

export interface Io {
  stdout: { write(chunk: string): unknown }
  stderr: { write(chunk: string): unknown }
  exit(code: number): void
}

export const internals: { stdout: Io['stdout']; stderr: Io['stderr'] } = { stdout: process.stdout, stderr: process.stderr }

export function routeOf(selection: { provider: string; model: string; reasoningEffort?: unknown }, config: Config): RouteConfig {
  const reasoning: Record<string, unknown> = {}
  if (selection.reasoningEffort !== undefined) reasoning['effort'] = selection.reasoningEffort
  if (config.lane) reasoning['lane'] = config.lane
  return {
    provider: selection.provider,
    model: selection.model,
    credentialRef: config.credentialRef ?? '',
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    ...(config.baseUrlKind ? { baseUrlKind: config.baseUrlKind } : {}),
    ...(Object.keys(reasoning).length ? { reasoning } : {}),
  }
}

/** A service the command needs beyond the plugin's inject list; absent means its row did not mount. */
function need<K extends 'gate' | 'champion' | 'signoff' | 'proposers' | 'subprocess'>(ctx: Context, key: K): Context[K] {
  const v = ctx.get(key) as Context[K] | undefined
  if (v === undefined) throw new Error(`ctx.${key} is not mounted (is its row enabled in the profile, and did it start?)`)
  return v
}

/** `propose`: a registered adapter needs ctx.proposers; a `./command` proposer needs ctx.subprocess (E4) and nothing else. */
function proposeDeps(ctx: Context, req: ProposeRequest): Pick<ProposeDeps, 'proposers' | 'commandAdapter'> {
  if (isCommandProposer(req.proposer)) {
    need(ctx, 'subprocess')
    return { proposers: { get: () => undefined }, commandAdapter: (config) => createCommandAdapter(ctx, config) }
  }
  return { proposers: need(ctx, 'proposers'), commandAdapter: () => { throw new Error('propose: a registered proposer takes no command') } }
}

/** Every consent confirmed over the socket becomes a ledger row. */
function recordConsents(ctx: Context, signoff: Signoff): () => void {
  return signoff.onConfirm((c: ConsentRecord) => {
    void ctx.ledger.recordConsent(c).catch(() => {})
  })
}

function waitForConsent(signoff: Signoff, subject: string, action: SignoffAction, seconds: number, roundId: string | undefined): Promise<ConsentRecord> {
  return new Promise((resolve, reject) => {
    const off = signoff.onConfirm((c) => {
      if (c.challenger_id !== subject || c.action !== action || c.round_id !== roundId) return
      clearTimeout(timer)
      off()
      resolve(c)
    })
    const timer = setTimeout(() => {
      off()
      reject(new Error(`no ${action} consent for ${subject} arrived within ${seconds}s`))
    }, seconds * 1000)
  })
}

/**
 * The latest consent of `action` for `subject` on the ledger — for a
 * `promote`, the one bound to `roundId` (E2); with `wait`, a sign-off is
 * opened and the proof that answers it over the socket becomes that consent.
 * `hint` names the command line that opens one.
 */
async function consentFor(ctx: Context, subject: string, action: SignoffAction, wait: number | undefined, hint: string, io: Io, roundId?: string): Promise<ConsentRow> {
  let consent: ConsentRow | undefined = ctx.ledger.consentsOf(subject).filter((c) => c.action === action && (roundId === undefined || c.round_id === roundId)).sort((a, b) => (a.at < b.at ? 1 : -1))[0]
  if (!consent && wait !== undefined) {
    const signoff = need(ctx, 'signoff')
    await signoff.ready
    const pending = signoff.request(subject, action, roundId !== undefined ? { roundId } : {})
    io.stderr.write(`sign-off pending on ${signoff.config.socketPath} until ${pending.expiresAt}; waiting ${wait}s\n`)
    const record = recordConsents(ctx, signoff)
    try {
      consent = await waitForConsent(signoff, subject, action, wait, roundId)
      await ctx.ledger.recordConsent(consent)
    } finally {
      record()
    }
  }
  if (!consent) {
    throw new Error(`no ${action} consent on the ledger for ${subject}; run \`${hint} --wait <seconds>\` and confirm with samsara-signoff`)
  }
  return consent
}

/** The round a challenger is decided in: `--round`, else the open round against its parent that lists it (the latest one otherwise). */
function roundIdOf(ctx: Context, challengerId: string, round: string | undefined): string {
  if (round !== undefined) {
    if (!ctx.ledger.round(round)) throw new Error(`no round ${round}`)
    return round
  }
  const row = ctx.ledger.challenger(challengerId)
  if (!row) throw new Error(`no challenger ${challengerId} on the ledger`)
  const parent = row.parent_ids[0]
  const rounds = parent !== undefined ? ctx.ledger.roundsOf(parent).filter((r) => r.sibling_ids.includes(challengerId)) : []
  const found = rounds.find((r) => r.status !== 'decided') ?? rounds.at(-1)
  if (!found) throw new Error(`challenger ${challengerId} is in no round; pass --round <id>`)
  return found.id
}

/**
 * `promote <id>`: the promote consent for the row (waited for over the socket
 * with --wait), then `lifecycle.decide` on its round — the service promotes
 * the round's candidate, which must be this row.
 */
export async function promote(ctx: Context, req: PromoteRequest, io: Io): Promise<void> {
  const champion = need(ctx, 'champion')
  const { challengerId } = req
  const row = ctx.ledger.challenger(challengerId)
  if (row?.verdict?.value !== 'promote') throw new Error(`challenger ${challengerId} has verdict ${row?.verdict?.value ?? 'none'}, not promote`)
  const roundId = roundIdOf(ctx, challengerId, req.round)
  const consent = await consentFor(ctx, challengerId, 'promote', req.wait, `promote ${challengerId}`, io, roundId)
  const outcome = await ctx.lifecycle.decide(roundId)
  if (outcome.pending) throw new Error(`round ${roundId}: its candidate is ${outcome.candidate}, not ${challengerId}; consent that row or drop it before promoting this one`)
  if (outcome.promoted !== challengerId) throw new Error(`round ${roundId} decided without promoting ${challengerId}${outcome.promoted !== undefined ? ` (promoted ${outcome.promoted})` : ''}`)
  const state = champion.current()
  const replay = champion.replayCheck()
  io.stdout.write(`promoted ${challengerId} with consent ${outcome.consentId ?? consent.id} (round ${roundId})\nkept: ${state.rows.join(', ') || '(none)'}\nreplay check: ${replay.equal ? 'ok' : `FAILED ${JSON.stringify(replay)}`}\n`)
}

/**
 * `gate change <name@version>`: the gate_change consent whose subject is that
 * policy — the row `challenge` / `round` / `certify` and `champion.promote`
 * look for before a gate other than gate-default may judge for real.
 */
export async function gateChange(ctx: Context, req: GateChangeRequest, io: Io): Promise<ConsentRow> {
  const { gate } = req
  const consent = await consentFor(ctx, gate, 'gate_change', req.wait, `gate change ${gate}`, io)
  io.stdout.write(`gate_change consent ${consent.id} names ${gate} (by ${consent.who} at ${consent.at})\n`)
  return consent
}

/** `demote <id>`: the demote consent for the row (waited for with --wait, like promote), then `lifecycle.demote`. */
export async function demote(ctx: Context, req: DemoteRequest, io: Io): Promise<void> {
  const champion = need(ctx, 'champion')
  const consent = await consentFor(ctx, req.challengerId, 'demote', req.wait, `demote ${req.challengerId} --reason "${req.reason}"`, io)
  await ctx.lifecycle.demote(req.challengerId, req.reason, consent.id)
  const state = champion.current()
  io.stdout.write(`demoted ${req.challengerId} with consent ${consent.id}\nkept: ${state.rows.join(', ') || '(none)'}\n`)
}

async function serve(ctx: Context, io: Io): Promise<void> {
  const signoff = need(ctx, 'signoff')
  await signoff.ready
  const record = recordConsents(ctx, signoff)
  const web = (ctx as unknown as { get(name: string): { port?: number; host?: string } | undefined }).get('webServer')
  const url = web?.port ? `http://${web.host ?? '127.0.0.1'}:${web.port}/samsara` : 'no web server mounted'
  io.stdout.write(`samsara host serving; ui ${url}; sign-off socket ${signoff.config.socketPath} (pid ${process.pid})\n`)
  try {
    await new Promise<void>((done) => {
      process.once('SIGTERM', () => done())
      process.once('SIGINT', () => done())
    })
  } finally {
    record()
  }
}

/** `ledger backup`: the sqlite online backup API over a second read-only handle, so the running host's writes stay consistent (E6). */
export async function ledgerBackup(req: LedgerBackupRequest, io: Io): Promise<void> {
  const out = resolve(req.out)
  mkdirSync(dirname(out), { recursive: true })
  const pages = await backupSqlite(resolve(req.db), out)
  io.stdout.write(`ledger backup: ${pages} page(s) of ${resolve(req.db)} copied to ${out}\n`)
}

async function exportCommand(req: ExportRequest, io: Io): Promise<void> {
  const out = resolve(req.out)
  const { resourceSpans, attempts, spans } = exportRun(req)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, JSON.stringify({ resourceSpans }, null, 2) + '\n')
  io.stdout.write(formatExport({ attempts, spans, out }) + '\n')
}

async function benchCommand(req: BenchRequest, io: Io): Promise<void> {
  const result = await benchRun(req)
  if (req.out !== undefined) {
    const out = resolve(req.out)
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, JSON.stringify(result, null, 2) + '\n')
    io.stderr.write(`bench result written to ${out}\n`)
  }
  io.stdout.write(formatBench(result))
}

type ResolvedValues = Exclude<SamsaraRunValues, { resumeDir: string }>

/** `run --resume <dir>`: the request recorded in `<dir>/run.json` with `resume: true`; every other command passes through. */
export function resolveResume(values: SamsaraRunValues): ResolvedValues {
  if (values.command === 'run' && 'resumeDir' in values) {
    const dir = resolve(values.resumeDir)
    return { command: 'run', ...readRunRecord(dir).request, out: dir, resume: true }
  }
  return values as ResolvedValues
}

async function run(ctx: Context, config: Config, io: Io): Promise<void> {
  // Loader siblings mount concurrently; wait for the whole tree so every loop
  // provider has registered before the first start().
  await ctx.get('loader')?.await()
  const parsed = ctx.get(SAMSARA_RUN_SERVICE) as SamsaraRunValues | undefined
  const loops = ctx.get('loops')
  const defaultModel = ctx.get('agentDefaultModel')
  const ledger = ctx.get('ledger')
  const lifecycle = ctx.get('lifecycle')
  if (parsed === undefined || loops === undefined || defaultModel === undefined || ledger === undefined || lifecycle === undefined) return
  const req = resolveResume(parsed)

  if (req.command === 'promote') { await promote(ctx, req, io); io.exit(0); return }
  if (req.command === 'demote') { await demote(ctx, req, io); io.exit(0); return }
  if (req.command === 'serve') { await serve(ctx, io); io.exit(0); return }
  if (req.command === 'export') { await exportCommand(req, io); io.exit(0); return }
  if (req.command === 'gate-bench') { await benchCommand(req, io); io.exit(0); return }
  if (req.command === 'gate-change') { await gateChange(ctx, req, io); io.exit(0); return }
  if (req.command === 'ledger-backup') { await ledgerBackup(req, io); io.exit(0); return }
  if (req.command === 'status') { io.stdout.write(formatStatus(lifecycle.status()) + '\n'); io.exit(0); return }
  if (req.command === 'experiment-new') {
    io.stdout.write(formatExperiment(await experimentNew(req, { lifecycle, gate: need(ctx, 'gate') })) + '\n')
    io.exit(0)
    return
  }

  if (req.command !== 'certify' && loops.get(req.loop) === undefined) {
    throw new Error(`no loop provider named "${req.loop}" is registered (is its plugin enabled in the profile?)`)
  }
  // Where the attempts run: the registry the bundle mounts, the provider `--env` names (local by default).
  const environments = ctx.get('environments')
  const envName = req.env ?? 'local'
  if (environments === undefined) {
    if (req.env !== undefined) throw new Error(`--env ${req.env}: no environments registry is mounted (is its row enabled in the profile?)`)
  } else if (environments.get(envName) === undefined) {
    throw new Error(`no environment provider named "${envName}" is registered (is its plugin enabled in the profile?)`)
  }
  const controller = new AbortController()
  // dsh's own SIGINT handler disposes the tree; an async disposer makes that
  // disposal wait for the in-flight rows (and the summary) to land first.
  let inFlight: Promise<void> | undefined
  const disposeAbort = ctx.effect(() => async () => {
    controller.abort('scope disposed')
    await inFlight?.catch(() => {})
  })
  // Ctrl-C: cancel every in-flight attempt; their rows (ABORTED) are still written before the summary and exit.
  const onSigint = () => {
    io.stderr.write('SIGINT: cancelling in-flight attempts\n')
    controller.abort('SIGINT')
  }
  process.once('SIGINT', onSigint)
  // The champion's kept skill (promoted through the ledger + sign-off) is the default skill; the pack's is the fallback.
  const championSkillDir = ctx.get('champion')?.current().skill_ref
  const deps = {
    loops,
    ledger,
    route: routeOf(defaultModel.currentSelection(), config),
    signal: controller.signal,
    log: (line: string) => io.stderr.write(line + '\n'),
    ...(championSkillDir !== undefined ? { championSkillDir } : {}),
    ...(environments !== undefined ? { environments } : {}),
  }
  if (championSkillDir !== undefined) deps.log(`champion skill: ${championSkillDir}`)
  // The commands that transition rows do so through the service; the gate is read for the policy `--gate-policy` names.
  const chain = () => ({ ...deps, lifecycle, gate: need(ctx, 'gate') })
  let code = 0
  try {
    inFlight = (async () => {
      if (req.command === 'challenge') {
        const result = await challenge({ ...req, out: resolve(req.out) }, chain())
        io.stdout.write(formatChallenge(result) + '\n')
      } else if (req.command === 'certify') {
        const result = await certify({ ...req, out: resolve(req.out) }, chain())
        io.stdout.write(formatCertify(result) + '\n')
      } else if (req.command === 'round') {
        const result = await round({ ...req, out: resolve(req.out) }, { ...chain(), proposers: need(ctx, 'proposers') })
        io.stdout.write(formatRound(result) + '\n')
      } else if (req.command === 'control') {
        const result = await control({ ...req, out: resolve(req.out) }, chain())
        io.stdout.write(formatControl(result) + '\n')
      } else if (req.command === 'calibrate') {
        const result = await calibrate({ ...req, out: resolve(req.out) }, chain())
        io.stdout.write(formatCalibrate(result) + '\n')
      } else if (req.command === 'campaign') {
        // A consent a round needs: waited for over the socket with --wait; without it (or on timeout) the campaign pauses.
        const wait = req.wait
        const result = await campaign({ ...req, out: resolve(req.out) }, {
          ...chain(), proposers: need(ctx, 'proposers'),
          currentSkillDir: () => ctx.get('champion')?.current().skill_ref,
          ...(wait !== undefined ? { consent: (action, subject, roundId) => consentFor(ctx, subject, action, wait, `${action} ${subject}`, io, action === 'promote' ? roundId : undefined).catch(() => undefined) } : {}),
        })
        io.stdout.write(formatCampaign(result) + '\n')
      } else if (req.command === 'propose') {
        const result = await propose({ ...req, out: resolve(req.out) }, { ...deps, ...proposeDeps(ctx, req) })
        io.stdout.write(formatPropose(result) + '\n')
        code = result.scan.ok ? 0 : 1
      } else {
        const result = await runSet({ ...req, out: resolve(req.out) }, deps)
        io.stdout.write(formatSummary(result) + '\n')
      }
    })()
    await inFlight
    io.exit(controller.signal.aborted ? 130 : code)
  } finally {
    process.removeListener('SIGINT', onSigint)
    disposeAbort()
  }
}

/** Grace after the tree disposed before a stray handle is no longer allowed to keep the process alive. */
export const DRAIN_GRACE_MS = 3000

export function apply(ctx: Context, config: Config): void {
  const appExit = ctx.get('appExit')
  if (appExit === undefined) throw new Error('samsara-runner: the launcher must provide ctx.appExit before the tree mounts')
  // The attempt executor ctx.lifecycle runs attempts through (run / calibrate / campaign).
  ctx.provide('executor', { runSet })
  let exitCode: number | undefined
  // A fast one-shot can request exit while the launcher is still opening its
  // patch-file watchers; a watcher opened after the tree disposed keeps the
  // event loop alive forever. Once this plugin is disposed nothing of ours is
  // left, so after a short grace the exit is forced. unref: the timer itself
  // never holds the loop open.
  ctx.effect(() => () => {
    if (exitCode === undefined) return
    setTimeout(() => process.exit(exitCode), DRAIN_GRACE_MS).unref()
  }, 'samsara-runner.drain')
  const exit = (code: number) => {
    exitCode ??= code
    appExit(code)
  }
  const io: Io = { stdout: internals.stdout, stderr: internals.stderr, exit }
  void run(ctx, config, io).catch((error: unknown) => {
    io.stderr.write(`samsara-runner: ${error instanceof Error ? error.message : String(error)}\n`)
    io.exit(1)
  })
}
