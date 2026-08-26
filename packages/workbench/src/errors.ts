// @oldbulb/samsara-workbench/errors — every LifecycleError code and every
// LedgerError code as a sentence the operator can read and the next action
// it calls for. The tools throw through `describeError` and the commands
// render their error card through it, so a refusal of the service never
// reaches the agent or the person as a bare code.

import type { LedgerErrorCode } from '@oldbulb/samsara-ledger'
import { LedgerError } from '@oldbulb/samsara-ledger'
import type { LifecycleErrorCode } from '@oldbulb/samsara-lifecycle'
import { LifecycleError } from '@oldbulb/samsara-lifecycle'

/** What the caller knows that sharpens the next action: the calibrate quote when it has one. */
export interface Hints {
  /** The calibrate tool call with its cost (`samsara_calibrate … ≈ $x`). */
  calibrate?: string
}

export interface Explanation {
  code: string
  sentence: string
  next: string
}

interface Entry {
  sentence: string
  next: string | ((hints: Hints) => string)
}

const CALIBRATE_CALL = 'samsara_calibrate { pack, loop, set: "holdin", reruns: 3 }'

export const LIFECYCLE_ERRORS: Record<LifecycleErrorCode, Entry> = {
  NOT_COMPARABLE: {
    sentence: 'The challenger and its champion differ on a coordinate rule 0 requires equal, so no statistic is computed across them.',
    next: 'propose the row against the champion it was evaluated with (same pack, harness, environment, task set and route), or open a new round on the champion served now.',
  },
  GATE_NOT_CONSENTED: {
    sentence: 'The gate policy is not gate-default and no gate_change consent names it; nothing opens under it.',
    next: 'ask the person to type /samsara gate <name@version> --wait <seconds> and confirm with samsara-signoff, or mount gate-default.',
  },
  GATE_MISMATCH: {
    sentence: 'The gate this process would judge with is not the one the round or the experiment pinned (another name, version or policy), or it is not mounted.',
    next: 'open the round under the pre-registered gate (the experiment names it), or ask the person to pre-register another experiment with /samsara predict new … --gate <name>.',
  },
  PROFILE_CHANGED: {
    sentence: 'The champion state changed while the scope opened or since the round opened (E1): nothing in the round was judged against what is served now.',
    next: 'start the campaign again on the same experiment: it closes the stale round and opens one on the champion served now.',
  },
  NO_NOISE_FLOOR: {
    sentence: 'Nothing is judged at holdout without a noise floor for this champion, loop and metric (S1): the MDE cannot be computed.',
    next: (hints) => `calibrate first: ${hints.calibrate ?? CALIBRATE_CALL}`,
  },
  ROUND_CLOSED: {
    sentence: 'The round (or the experiment) is no longer open: it was decided or closed, or it already judged a sibling at a frozen Holm k.',
    next: 'open a new round (samsara_round or samsara_campaign_start on the experiment); a decided round is never reopened.',
  },
  NOT_IN_ROUND: {
    sentence: 'The row belongs to no round against its parent, so no transition can run on it.',
    next: 'propose it into an open round on its champion (its parent must be the round\'s champion), or open one.',
  },
  BAD_TRANSITION: {
    sentence: 'The transition is not valid from the row\'s current status, or the input is off the contract; the message says what was expected.',
    next: 'samsara_next_actions { challenger_id } lists what the row can do next.',
  },
  NO_CONSENT: {
    sentence: 'The change needs a consent that is not on the ledger (a demotion without the pack\'s auto_demote).',
    next: 'ask the person to type /samsara demote <champion-id> "<reason>" --wait <seconds> and confirm with samsara-signoff.',
  },
  BUDGET_EXCEEDED: {
    sentence: 'A budget is spent: the experiment\'s usd, attempts, rounds or holdout reveals, or the pack\'s holdout budget.',
    next: 'ask the person to raise it with /samsara budget <experiment-id> --usd <u>|--rounds <r>, or to pre-register another experiment; the pack\'s holdout budget is the pack\'s to raise.',
  },
  OPERATOR_IS_PROPOSER: {
    sentence: 'The operator session runs on the route the proposer declares; the same model cannot propose and operate a round.',
    next: 'choose a proposer on another model (configure model on its row), or run the operator session on another model.',
  },
  UNKNOWN: {
    sentence: 'No row with that id is on the ledger (challenger, round or experiment).',
    next: 'check the id with samsara_ledger_view or /samsara status; an experiment is pre-registered with /samsara predict new.',
  },
}

export const LEDGER_ERRORS: Record<LedgerErrorCode, Entry> = {
  VERDICT_EXISTS: {
    sentence: 'A verdict already exists for these coordinates and replicates: first verdict wins, the ledger keeps it.',
    next: 'judge over more replicates (samsara_next_actions: replicate), or read the recorded verdict with samsara_compare { challenger_id }.',
  },
  ATTEMPT_EXISTS: {
    sentence: 'The attempt id already belongs to another challenger; an attempt is recorded under one row only.',
    next: 'run again under a fresh run id; the recorded row stays.',
  },
  UNKNOWN_CHALLENGER: {
    sentence: 'No challenger with that id is on the ledger.',
    next: 'check the id with samsara_ledger_view { view: "challengers" }.',
  },
  UNKNOWN_ROUND: {
    sentence: 'No round with that id is on the ledger.',
    next: 'check the id with samsara_ledger_view { view: "rounds" } or /samsara status.',
  },
  UNKNOWN_EXPERIMENT: {
    sentence: 'No experiment with that id is on the ledger.',
    next: '/samsara predict <experiment-id> shows one; /samsara predict new … pre-registers one.',
  },
  NOT_OPEN: {
    sentence: 'The ledger domain is not open: the host is starting or shutting down.',
    next: 'retry once the host is up; if it persists, check the ledger row in the profile.',
  },
}

/** The sentence and the next action for a code of either table; undefined for a code neither names. */
export function explain(code: string, hints: Hints = {}): Explanation | undefined {
  const table = Object.hasOwn(LIFECYCLE_ERRORS, code) ? LIFECYCLE_ERRORS : Object.hasOwn(LEDGER_ERRORS, code) ? LEDGER_ERRORS : undefined
  const entry = table ? (table as Record<string, Entry>)[code] : undefined
  if (!entry) return undefined
  return { code, sentence: entry.sentence, next: typeof entry.next === 'function' ? entry.next(hints) : entry.next }
}

/** The code of a service or ledger error; undefined for any other value. */
export function codeOf(e: unknown): string | undefined {
  return e instanceof LifecycleError || e instanceof LedgerError ? e.code : undefined
}

/** A message under a code the tables know, with the sentence and the next action; the message alone for any other code. */
export function explained(code: string, message: string, hints: Hints = {}): string {
  const explanation = explain(code, hints)
  if (!explanation) return message
  return `${message} [${explanation.code}]\n${explanation.sentence}\nNext: ${explanation.next}`
}

/**
 * The message the operator reads: a service or ledger error becomes its own
 * message, the sentence for its code and the next action; anything else is
 * its message unchanged.
 */
export function describeError(e: unknown, hints: Hints = {}): string {
  const message = e instanceof Error ? e.message : String(e)
  const code = codeOf(e)
  return code !== undefined ? explained(code, message, hints) : message
}
