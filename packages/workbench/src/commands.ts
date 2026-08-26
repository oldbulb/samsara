// @oldbulb/samsara-workbench/commands — the human `/samsara …` commands.
//
// Host plane, global: the web UI dispatches a typed line to the handler and
// renders the result as a card; nothing here enters model history. These
// commands are the person's channel — pre-registration, consent (approve,
// demote, gate, reveal), budget and stop — and the operator agent cannot call
// them. A consent is still a sign-off over the socket (the key stays outside
// the host, E2): the handler opens the pending sign-off, waits for the proof,
// records the consents row and hands the transition to ctx.lifecycle; the
// operator learns of it through a followup notice on its next turn.

import { createUserMessage, type CommandInvocation, type Context } from '@oldbulb/samsara-kernel'
import type { ConsentRow, ExperimentRow, ServingRow } from '@oldbulb/samsara-ledger'
import { gateRefOf, roundPolicy } from '@oldbulb/samsara-lifecycle'
import { loadPack } from '@oldbulb/samsara-pack'
import { formatExperiment, formatStatus } from '@oldbulb/samsara-runner'
import { DEFAULTS } from '@oldbulb/samsara-runner/startup'
import type { ConsentRecord, Signoff, SignoffAction } from '@oldbulb/samsara-signoff'
import type {} from '@oldbulb/samsara-champion'
import type {} from '@oldbulb/samsara-gate'
import { describeError } from './errors.ts'
import { jobTags, jobsOfRound } from './jobs.ts'
import { abortRound, staleRounds } from './startup.ts'

export const name = 'workbench-commands'
export const inject = ['commands', 'lifecycle', 'ledger', 'signoff', 'champion', 'jobs']

export const USAGE = [
  'Usage: /samsara status',
  '       /samsara predict new "<hypothesis>" --pack <dir> --metric <m> --direction up|down [--magnitude <x>] [--budget-usd <u>] [--budget-rounds <r>] [--gate <name>] [--n-eff-floor <n>] [--auto-reveal]',
  '       /samsara predict <experiment-id>',
  '       /samsara approve <challenger-id> [--wait <seconds>]',
  '       /samsara demote <champion-id> "<reason>" [--wait <seconds>]',
  '       /samsara gate <name@version|./command> [--wait <seconds>]',
  '       /samsara reveal <challenger-id> [--wait <seconds>]',
  '       /samsara budget <experiment-id> --usd <u>|--rounds <r>',
  '       /samsara stop <job-id|round-id>',
  '       /samsara reconcile [<round-id>]',
].join('\n')

export type CommandResult = { kind: 'success'; text: string } | { kind: 'error'; text: string }

export type SamsaraCommand =
  | { kind: 'status' }
  | { kind: 'predict-show'; experimentId: string }
  | { kind: 'predict-new'; hypothesis: string; pack: string; metric: string; direction: 'up' | 'down'; magnitude?: number; budgetUsd?: number; budgetRounds?: number; gate?: string; nEffFloor: number; autoReveal?: boolean }
  | { kind: 'approve'; challengerId: string; wait?: number }
  | { kind: 'demote'; championId: string; reason: string; wait?: number }
  | { kind: 'gate'; gate: string; wait?: number }
  | { kind: 'reveal'; challengerId: string; wait?: number }
  | { kind: 'budget'; experimentId: string; usd?: number; rounds?: number }
  | { kind: 'stop'; id: string }
  | { kind: 'reconcile'; roundId?: string }

/** A line the grammar rejects; the card shows the message and the usage. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

/** Whitespace-separated words; a double-quoted run is one word (the hypothesis, the reason). */
export function tokenize(input: string): string[] {
  const out: string[] = []
  for (const m of input.matchAll(/"([^"]*)"|(\S+)/g)) out.push(m[1] ?? m[2]!)
  return out
}

interface Words {
  positional: string[]
  options: Map<string, string>
}

/** `--key value` pairs and the rest in order; every option takes a value, a flag takes none. */
function split(words: readonly string[], allowed: readonly string[], flags: readonly string[] = []): Words {
  const positional: string[] = []
  const options = new Map<string, string>()
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    if (!w.startsWith('--')) { positional.push(w); continue }
    if (flags.includes(w)) { options.set(w, 'true'); continue }
    if (!allowed.includes(w)) throw new UsageError(`unknown option ${w}`)
    const value = words[i + 1]
    if (value === undefined || value.startsWith('--')) throw new UsageError(`${w} needs a value`)
    options.set(w, value)
    i++
  }
  return { positional, options }
}

function num(options: Map<string, string>, key: string): number | undefined {
  const raw = options.get(key)
  if (raw === undefined) return undefined
  const n = Number(raw)
  if (!Number.isFinite(n)) throw new UsageError(`${key} must be a number, got "${raw}"`)
  return n
}

function need(words: Words, key: string): string {
  const v = words.options.get(key)
  if (v === undefined) throw new UsageError(`${key} is required`)
  return v
}

function one(words: Words, what: string): string {
  const [v, extra] = words.positional
  if (v === undefined) throw new UsageError(`${what} is required`)
  if (extra !== undefined) throw new UsageError(`unexpected "${extra}"`)
  return v
}

/** Parse only the grammar `/samsara` owns; anything else is a usage error. */
export function parseCommand(rawInput: string): SamsaraCommand {
  const [sub, ...rest] = tokenize(rawInput)
  switch (sub) {
    case 'status': {
      if (rest.length) throw new UsageError('status takes no arguments')
      return { kind: 'status' }
    }
    case 'predict': {
      const words = split(rest, ['--pack', '--metric', '--direction', '--magnitude', '--budget-usd', '--budget-rounds', '--gate', '--n-eff-floor'], ['--auto-reveal'])
      const [target, hypothesis, extra] = words.positional
      if (target === undefined) throw new UsageError('predict needs new "<hypothesis>" or an experiment id')
      if (target !== 'new') {
        if (hypothesis !== undefined || words.options.size) throw new UsageError('an experiment is fixed once pre-registered; /samsara predict new … opens another')
        return { kind: 'predict-show', experimentId: target }
      }
      if (hypothesis === undefined) throw new UsageError('predict new needs a "<hypothesis>"')
      if (extra !== undefined) throw new UsageError(`unexpected "${extra}" (quote the hypothesis)`)
      const direction = need(words, '--direction')
      if (direction !== 'up' && direction !== 'down') throw new UsageError(`--direction must be up or down, got "${direction}"`)
      const magnitude = num(words.options, '--magnitude')
      const budgetUsd = num(words.options, '--budget-usd')
      const budgetRounds = num(words.options, '--budget-rounds')
      const gate = words.options.get('--gate')
      return {
        kind: 'predict-new', hypothesis, pack: need(words, '--pack'), metric: need(words, '--metric'), direction,
        ...(magnitude !== undefined ? { magnitude } : {}),
        ...(budgetUsd !== undefined ? { budgetUsd } : {}),
        ...(budgetRounds !== undefined ? { budgetRounds } : {}),
        ...(gate !== undefined ? { gate } : {}),
        nEffFloor: num(words.options, '--n-eff-floor') ?? DEFAULTS.nEffFloor,
        ...(words.options.has('--auto-reveal') ? { autoReveal: true } : {}),
      }
    }
    case 'approve': {
      const words = split(rest, ['--wait'])
      const wait = num(words.options, '--wait')
      return { kind: 'approve', challengerId: one(words, 'a challenger id'), ...(wait !== undefined ? { wait } : {}) }
    }
    case 'demote': {
      const words = split(rest, ['--wait'])
      const [championId, reason, extra] = words.positional
      if (championId === undefined) throw new UsageError('a champion id is required')
      if (reason === undefined) throw new UsageError('a "<reason>" is required')
      if (extra !== undefined) throw new UsageError(`unexpected "${extra}" (quote the reason)`)
      const wait = num(words.options, '--wait')
      return { kind: 'demote', championId, reason, ...(wait !== undefined ? { wait } : {}) }
    }
    case 'gate': {
      const words = split(rest, ['--wait'])
      const wait = num(words.options, '--wait')
      return { kind: 'gate', gate: one(words, 'a gate (name@version or ./command)'), ...(wait !== undefined ? { wait } : {}) }
    }
    case 'reveal': {
      const words = split(rest, ['--wait'])
      const wait = num(words.options, '--wait')
      return { kind: 'reveal', challengerId: one(words, 'a challenger id'), ...(wait !== undefined ? { wait } : {}) }
    }
    case 'budget': {
      const words = split(rest, ['--usd', '--rounds'])
      const experimentId = one(words, 'an experiment id')
      const usd = num(words.options, '--usd')
      const rounds = num(words.options, '--rounds')
      if (usd === undefined && rounds === undefined) throw new UsageError('budget needs --usd or --rounds')
      if (rounds !== undefined && !Number.isInteger(rounds)) throw new UsageError('--rounds must be an integer')
      return { kind: 'budget', experimentId, ...(usd !== undefined ? { usd } : {}), ...(rounds !== undefined ? { rounds } : {}) }
    }
    case 'stop': {
      const words = split(rest, [])
      return { kind: 'stop', id: one(words, 'a job or round id') }
    }
    case 'reconcile': {
      const words = split(rest, [])
      const [roundId, extra] = words.positional
      if (extra !== undefined) throw new UsageError(`unexpected "${extra}"`)
      return { kind: 'reconcile', ...(roundId !== undefined ? { roundId } : {}) }
    }
    case undefined:
      throw new UsageError('a subcommand is required')
    default:
      throw new UsageError(`unknown subcommand "${sub}"`)
  }
}

// ------------------------------------------------------------------ consent

function waitForConsent(signoff: Pick<Signoff, 'onConfirm'>, subject: string, action: SignoffAction, seconds: number, signal: AbortSignal, roundId: string | undefined): Promise<ConsentRecord> {
  return new Promise((resolve, reject) => {
    const settle = (fn: () => void) => { clearTimeout(timer); off(); signal.removeEventListener('abort', onAbort); fn() }
    const off = signoff.onConfirm((c) => {
      if (c.challenger_id !== subject || c.action !== action || c.round_id !== roundId) return
      settle(() => resolve(c))
    })
    const onAbort = () => settle(() => reject(new Error(`the ${action} sign-off for ${subject} was cancelled before a proof arrived`)))
    const timer = setTimeout(() => settle(() => reject(new Error(`no ${action} consent for ${subject} arrived within ${seconds}s`))), seconds * 1000)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * The latest consent of `action` for `subject` on the ledger; with `--wait`,
 * a sign-off is opened and the proof that answers it over the socket becomes
 * that consent (recorded before the transition it authorizes).
 */
async function consentFor(ctx: Context, invocation: CommandInvocation, subject: string, action: SignoffAction, wait: number | undefined, hint: string, roundId?: string): Promise<ConsentRow> {
  // A promote consent is bound to the round it decides (E2): one signed for another round does not count.
  let consent: ConsentRow | undefined = ctx.ledger.consentsOf(subject).filter((c) => c.action === action && (roundId === undefined || c.round_id === roundId)).sort((a, b) => (a.at < b.at ? 1 : -1))[0]
  if (!consent && wait !== undefined) {
    const signoff = ctx.signoff
    await signoff.ready
    signoff.request(subject, action, roundId !== undefined ? { roundId } : {})
    const record = signoff.onConfirm((c: ConsentRecord) => { void ctx.ledger.recordConsent(c).catch(() => {}) })
    try {
      consent = await waitForConsent(signoff, subject, action, wait, invocation.signal, roundId)
      await ctx.ledger.recordConsent(consent)
    } finally {
      record()
    }
  }
  if (!consent) throw new Error(`no ${action} consent on the ledger for ${subject}; run \`${hint} --wait <seconds>\` and confirm with samsara-signoff`)
  return consent
}

/** One line in front of the operator's next turn: what the person just decided. */
function notify(invocation: CommandInvocation, text: string): void {
  invocation.agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

/** A service the command needs beyond the plugin's inject list; absent means its row did not mount. */
function mounted<K extends 'gate'>(ctx: Context, key: K): Context[K] {
  const v = ctx.get(key) as Context[K] | undefined
  if (v === undefined) throw new Error(`ctx.${key} is not mounted (is its row enabled in the profile, and did it start?)`)
  return v
}

/** The round a challenger is decided in: the open round against its parent that lists it (the latest one otherwise). */
function roundIdOf(ctx: Context, challengerId: string, parent: string | undefined): string {
  const rounds = parent !== undefined ? ctx.ledger.roundsOf(parent).filter((r) => r.sibling_ids.includes(challengerId)) : []
  const found = rounds.find((r) => r.status !== 'decided') ?? rounds.at(-1)
  if (!found) throw new Error(`challenger ${challengerId} is in no round`)
  return found.id
}

function formatServing(s: ServingRow): string {
  return `serving    ${s.id}  champion ${s.champion_id}  by ${s.by}${s.consent_id !== undefined ? `  consent ${s.consent_id}` : ''}  from ${s.from}${s.to !== undefined ? `  to ${s.to}` : ''}  profile ${s.profile_sha.slice(0, 12)}`
}

/** The tool call the operator starts the campaign with, on the pre-registered rounds budget. */
function campaignArgs(e: ExperimentRow): string {
  return `samsara_campaign_start ${JSON.stringify({ experiment_id: e.id, proposer: '<proposer>', rounds: e.budget.rounds ?? DEFAULTS.rounds })}`
}

/** The experiment as the card shows it: the row, what it pre-registered about the reveal, the campaign call. */
function experimentCard(e: ExperimentRow): string {
  return [
    formatExperiment(e),
    ...(e.auto_reveal ? ['auto-reveal pre-registered: the campaign runs the held-out tier after a held-in hold without a /samsara reveal per round'] : []),
    campaignArgs(e),
  ].join('\n')
}

// ----------------------------------------------------------------- handlers

async function predictNew(ctx: Context, invocation: CommandInvocation, cmd: Extract<SamsaraCommand, { kind: 'predict-new' }>): Promise<CommandResult> {
  const def = loadPack(cmd.pack)
  const gate = mounted(ctx, 'gate')
  const provider = cmd.gate !== undefined ? gate.list().find((p) => p.name === cmd.gate || `${p.name}@${p.version}` === cmd.gate) : gate.current()
  if (!provider) throw new Error(cmd.gate !== undefined ? `no mounted gate policy named ${cmd.gate}` : 'no gate policy is mounted on ctx.gate')
  const row = await ctx.lifecycle.preregister({
    hypothesis: cmd.hypothesis,
    prediction: { metric: cmd.metric, direction: cmd.direction, ...(cmd.magnitude !== undefined ? { magnitude: cmd.magnitude } : {}) },
    pack: def.name,
    gate: gateRefOf(provider, roundPolicy(cmd.nEffFloor, def.manifest.holdout?.mde)),
    budget: { ...(cmd.budgetUsd !== undefined ? { usd: cmd.budgetUsd } : {}), ...(cmd.budgetRounds !== undefined ? { rounds: cmd.budgetRounds } : {}) },
    created_by: { channel: 'command', session_id: invocation.agent.id, command_id: invocation.commandId },
    // Typed by the person: the held-out reveals of this experiment are consented here, once, instead of per round.
    ...(cmd.autoReveal ? { auto_reveal: true } : {}),
  })
  return { kind: 'success', text: experimentCard(row) }
}

function predictShow(ctx: Context, experimentId: string): CommandResult {
  const row = ctx.ledger.experiment(experimentId)
  if (!row) throw new Error(`no experiment ${experimentId} on the ledger`)
  return { kind: 'success', text: experimentCard(row) }
}

async function approve(ctx: Context, invocation: CommandInvocation, cmd: Extract<SamsaraCommand, { kind: 'approve' }>): Promise<CommandResult> {
  const { challengerId } = cmd
  const row = ctx.ledger.challenger(challengerId)
  if (!row) throw new Error(`no challenger ${challengerId} on the ledger`)
  if (row.verdict?.value !== 'promote') throw new Error(`challenger ${challengerId} has verdict ${row.verdict?.value ?? 'none'}, not promote`)
  const roundId = roundIdOf(ctx, challengerId, row.parent_ids[0])
  const consent = await consentFor(ctx, invocation, challengerId, 'promote', cmd.wait, `/samsara approve ${challengerId}`, roundId)
  const outcome = await ctx.lifecycle.decide(roundId)
  if (outcome.pending) throw new Error(`round ${roundId}: its candidate is ${outcome.candidate}, not ${challengerId}; consent that row or drop it before promoting this one`)
  if (outcome.promoted !== challengerId) throw new Error(`round ${roundId} decided without promoting ${challengerId}${outcome.promoted !== undefined ? ` (promoted ${outcome.promoted})` : ''}`)
  const serving = ctx.ledger.servings().filter((s) => s.champion_id === challengerId).at(-1)
  const line = `promoted ${challengerId} with consent ${outcome.consentId ?? consent.id} (round ${roundId})`
  notify(invocation, line)
  return { kind: 'success', text: [line, serving ? formatServing(serving) : 'serving    (no row yet)', `kept       ${ctx.champion.current().rows.join(', ') || '(none)'}`].join('\n') }
}

async function demote(ctx: Context, invocation: CommandInvocation, cmd: Extract<SamsaraCommand, { kind: 'demote' }>): Promise<CommandResult> {
  const consent = await consentFor(ctx, invocation, cmd.championId, 'demote', cmd.wait, `/samsara demote ${cmd.championId} "${cmd.reason}"`)
  await ctx.lifecycle.demote(cmd.championId, cmd.reason, consent.id)
  const line = `demoted ${cmd.championId} with consent ${consent.id}: ${cmd.reason}`
  notify(invocation, line)
  return { kind: 'success', text: `${line}\nkept       ${ctx.champion.current().rows.join(', ') || '(none)'}` }
}

async function gateChange(ctx: Context, invocation: CommandInvocation, cmd: Extract<SamsaraCommand, { kind: 'gate' }>): Promise<CommandResult> {
  const consent = await consentFor(ctx, invocation, cmd.gate, 'gate_change', cmd.wait, `/samsara gate ${cmd.gate}`)
  const line = `gate_change consent ${consent.id} names ${cmd.gate} (by ${consent.who} at ${consent.at})`
  notify(invocation, line)
  return { kind: 'success', text: line }
}

/** The subject of a holdout_reveal consent is the challenger the campaign paused on: what its driver reads back before running the held-out tier. */
async function reveal(ctx: Context, invocation: CommandInvocation, cmd: Extract<SamsaraCommand, { kind: 'reveal' }>): Promise<CommandResult> {
  const { challengerId } = cmd
  if (!ctx.ledger.challenger(challengerId)) throw new Error(`no challenger ${challengerId} on the ledger`)
  const consent = await consentFor(ctx, invocation, challengerId, 'holdout_reveal', cmd.wait, `/samsara reveal ${challengerId}`)
  const line = `holdout_reveal consent ${consent.id} names challenger ${challengerId} (by ${consent.who} at ${consent.at})`
  notify(invocation, line)
  return { kind: 'success', text: line }
}

/** The new budget lands on the row with who set it (session, command) and when appended to its change record. */
async function budget(ctx: Context, invocation: CommandInvocation, cmd: Extract<SamsaraCommand, { kind: 'budget' }>): Promise<CommandResult> {
  const e = ctx.ledger.experiment(cmd.experimentId)
  if (!e) throw new Error(`no experiment ${cmd.experimentId} on the ledger`)
  const next = { ...e.budget, ...(cmd.usd !== undefined ? { usd: cmd.usd } : {}), ...(cmd.rounds !== undefined ? { rounds: cmd.rounds } : {}) }
  const updated = await ctx.lifecycle.setExperimentBudget(e.id, next, { session_id: invocation.agent.id, command_id: invocation.commandId })
  const at = updated.budget_changes?.at(-1)?.at ?? new Date().toISOString()
  return { kind: 'success', text: `${formatExperiment(updated)}\nbudget set by session ${invocation.agent.id} (command ${invocation.commandId}) at ${at}` }
}

/** By job id, or by a round id: the job that opened the round, else one charged to the round's experiment (its campaign). */
function stop(ctx: Context, invocation: CommandInvocation, cmd: Extract<SamsaraCommand, { kind: 'stop' }>): CommandResult {
  const jobs = ctx.jobs
  const mine = jobs.list(invocation.agent).filter((j) => j.kind.startsWith('samsara'))
  const tagged = jobsOfRound(cmd.id, ctx.ledger.round(cmd.id)?.experiment_id)
  const job = mine.find((j) => j.id === cmd.id) ?? mine.find((j) => tagged.includes(j.id))
  if (!job) throw new Error(`no samsara job ${cmd.id} is owned by this session`)
  const result = jobs.kill(job.id, invocation.agent, 'stopped by /samsara stop')
  return { kind: 'success', text: `${job.id} (${job.label}): ${result}` }
}

/**
 * The rounds left open with a running sibling, or one of them closed aborted.
 * The ledger cannot say which process owns a round, so the person decides:
 * without an id the card lists them; with one, the round closes unless a job
 * of this host is driving it (stop that first).
 */
async function reconcile(ctx: Context, cmd: Extract<SamsaraCommand, { kind: 'reconcile' }>): Promise<CommandResult> {
  const stale = staleRounds(ctx.lifecycle, ctx.ledger)
  if (cmd.roundId === undefined) {
    if (stale.length === 0) return { kind: 'success', text: 'no round is open with a running sibling' }
    const lines = stale.map((s) => `round ${s.round_id}: running ${s.challenger_ids.join(', ')}`)
    return { kind: 'success', text: [...lines, 'when nothing drives one (no job here, no campaign in another host on this ledger), /samsara reconcile <round-id> closes it aborted'].join('\n') }
  }
  const target = stale.find((s) => s.round_id === cmd.roundId)
  if (!target) throw new Error(`round ${cmd.roundId} is not open with a running sibling; nothing to reconcile`)
  const driving = [...jobTags].filter(([, tag]) => tag.round_ids.includes(target.round_id)).map(([id]) => id)
  if (driving.length) throw new Error(`round ${target.round_id} is driven by job ${driving.join(', ')} of this host; /samsara stop it first`)
  const lines: string[] = []
  await abortRound(ctx.lifecycle, target, (line) => lines.push(line))
  return { kind: 'success', text: lines.join('\n') }
}

/** Execute one `/samsara` line; every failure is an error card (a service or ledger refusal with its sentence and next action), never a thrown handler. */
export async function execute(ctx: Context, invocation: CommandInvocation): Promise<CommandResult> {
  let cmd: SamsaraCommand
  try {
    cmd = parseCommand(invocation.rawInput)
  } catch (e) {
    return { kind: 'error', text: `${e instanceof Error ? e.message : String(e)}\n${USAGE}` }
  }
  try {
    switch (cmd.kind) {
      case 'status': return { kind: 'success', text: formatStatus(ctx.lifecycle.status()) }
      case 'predict-new': return await predictNew(ctx, invocation, cmd)
      case 'predict-show': return predictShow(ctx, cmd.experimentId)
      case 'approve': return await approve(ctx, invocation, cmd)
      case 'demote': return await demote(ctx, invocation, cmd)
      case 'gate': return await gateChange(ctx, invocation, cmd)
      case 'reveal': return await reveal(ctx, invocation, cmd)
      case 'budget': return await budget(ctx, invocation, cmd)
      case 'stop': return stop(ctx, invocation, cmd)
      case 'reconcile': return await reconcile(ctx, cmd)
    }
  } catch (e) {
    return { kind: 'error', text: describeError(e) }
  }
}

export function apply(ctx: Context): void {
  ctx.commands.register({
    name: 'samsara',
    description: 'the samsara workbench: status, predict, approve, demote, gate, reveal, budget, stop, reconcile',
    input: { hint: 'status | predict … | approve <id> | demote <id> "<reason>" | gate <name@version> | reveal <id> | budget <experiment> | stop <job|round> | reconcile [<round>]' },
    handler: (invocation) => execute(ctx, invocation),
  })
}
