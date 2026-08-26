// `campaign`: rounds under a pre-registered experiment through
// ctx.lifecycle.campaign. This command assembles the input — the champion
// (re-read before every round, so a promotion is followed), the proposer from
// ctx.proposers under the E9 sandbox policy, the tiers and the stop rules —
// and the hooks: events to the log, the abort signal, consents through the
// sign-off path, the proposer view through renderView. The driver sequences
// the service's transitions; nothing here performs one.

import { homedir } from 'node:os'
import type { TaskSet } from '@oldbulb/samsara-book'
import type { ConsentRow, Ledger } from '@oldbulb/samsara-ledger'
import type { CampaignEvent, CampaignProposer, CampaignResult, CampaignRunOptions, ConsentAction, Lifecycle } from '@oldbulb/samsara-lifecycle'
import { loadPack } from '@oldbulb/samsara-pack'
import type { ProposerAdapter } from '@oldbulb/samsara-proposers'
import { policyFor } from '@oldbulb/samsara-sandbox'
import { hashDir, policyPaths } from '@oldbulb/samsara-workdir'
import type { ChallengeDeps } from './challenge.ts'
import { adapterOf, renderView, viewEnvironmentOf } from './round.ts'
import { bookOf, championProposal, type RunRequest } from './run.ts'

export interface CampaignRequest extends RunRequest {
  /** The pre-registered experiment the rounds are charged to. */
  experiment: string
  /** Adapter name on ctx.proposers. */
  proposer: string
  metric: string
  nEffFloor: number
  /** Stop after this many rounds. */
  rounds: number
  /** Run holdout after a held-in hold without a `holdout_reveal` consent. */
  autoHoldout: boolean
  stopOnPromote: boolean
  maxConsecutiveHolds?: number
  /** Replicates the held-in tier may grow to while underpowered. */
  maxRepeat?: number
  /** Attempts per task at holdout; defaults to `repeat`. */
  holdoutRepeat?: number
  budgetUsd?: number
  shadowGates?: string[]
  /** Seconds to wait for each consent a round needs over the socket; absent, a missing consent pauses the campaign. */
  wait?: number
}

export interface CampaignDeps extends Pick<ChallengeDeps, 'loops' | 'route' | 'championSkillDir' | 'signal' | 'log'> {
  lifecycle: Pick<Lifecycle, 'campaign'>
  /** The proposer view is rendered from its reads. */
  ledger: Pick<Ledger, 'read'>
  proposers: { get(name: string): ProposerAdapter | undefined }
  /** The sign-off path for a consent a round needs (a `promote` bound to the round); absent (or resolving undefined) pauses the campaign. */
  consent?: (action: ConsentAction, subject: string, roundId: string) => Promise<ConsentRow | undefined>
  /** The champion's kept skill now (ctx.champion.current().skill_ref), read before every round so a promotion is followed; defaults to `championSkillDir`. */
  currentSkillDir?: () => string | undefined
}

/** The per-attempt limits and route every tier of a campaign (or a control) runs under. */
export function campaignRunOf(req: Pick<RunRequest, 'maxTurns' | 'maxMinutes' | 'allow' | 'parallel'>, deps: Pick<ChallengeDeps, 'route'>): CampaignRunOptions {
  return {
    maxTurns: req.maxTurns, maxMinutes: req.maxMinutes, route: deps.route,
    ...(req.allow !== undefined ? { allow: req.allow } : {}),
    ...(req.parallel !== undefined ? { parallel: req.parallel } : {}),
  }
}

function stripCampaign(req: CampaignRequest): RunRequest {
  const { experiment: _e, proposer: _p, metric: _m, nEffFloor: _n, rounds: _r, autoHoldout: _a, stopOnPromote: _s, maxConsecutiveHolds: _h, maxRepeat: _x, holdoutRepeat: _o, budgetUsd: _b, shadowGates: _g, wait: _w, ...run } = req
  return run
}

export async function campaign(req: CampaignRequest, deps: CampaignDeps): Promise<CampaignResult> {
  if (req.set === 'holdout') throw new Error('campaign: the proposer view cannot be rendered from the held-out set (use smoke or holdin)')
  const def = loadPack(req.pack)
  const book = bookOf(def)
  const runReq = stripCampaign(req)
  const log = deps.log ?? (() => {})
  const signal = deps.signal ?? new AbortController().signal

  // The champion as served when the round opens: its kept skill after a promotion, the pack's as the fallback.
  const champion = () => {
    const skillDir = deps.currentSkillDir?.() ?? deps.championSkillDir ?? def.skillDir
    return { proposal: championProposal(def, book, runReq, { ...deps, championSkillDir: skillDir }), skillDir }
  }
  // E9: the proposer reads its rendered view, the pack's skill/ and loader/ and the runtimes; writes only its work directory.
  const adapter = adapterOf({ proposer: req.proposer, metric: req.metric }, deps)
  const proposer: CampaignProposer = {
    name: adapter.name, version: adapter.version, configSha: adapter.configSha,
    propose: (input) => adapter.propose({ ...input, sandbox: policyFor({ ...policyPaths(input.workDir, def), readOnly: [input.viewDir], homeDir: homedir() }) }),
  }
  return deps.lifecycle.campaign({
    experimentId: req.experiment,
    pack: req.pack,
    champion,
    proposer,
    metric: req.metric,
    nEffFloor: req.nEffFloor,
    set: req.set as Exclude<TaskSet, 'holdout'>,
    tiers: { holdin: { repeat: req.repeat, ...(req.maxRepeat !== undefined ? { maxRepeat: req.maxRepeat } : {}) }, holdout: { repeat: req.holdoutRepeat ?? req.repeat } },
    stop: { maxRounds: req.rounds, maxConsecutiveHolds: req.maxConsecutiveHolds ?? req.rounds, stopOnPromote: req.stopOnPromote, ...(req.budgetUsd !== undefined ? { budgetUsd: req.budgetUsd } : {}) },
    autoHoldout: req.autoHoldout,
    ...(req.shadowGates !== undefined ? { shadowGates: req.shadowGates } : {}),
    out: req.out,
    run: campaignRunOf(req, deps),
  }, {
    onEvent: (e) => log(formatEvent(e)),
    signal,
    ...(deps.consent !== undefined ? { consent: deps.consent } : {}),
    renderView: (dir, input) => renderView(dir, { ...input, ledger: deps.ledger, environment: viewEnvironmentOf(def, runReq, deps.loops) }),
    hashDir,
  })
}

function short(id: string): string {
  return id.slice(0, 12)
}

function spentOf(s: { usd: number; attempts: number; rounds: number; holdout_reveals: number }): string {
  return `spent usd ${s.usd.toFixed(2)} attempts ${s.attempts} rounds ${s.rounds} holdout reveals ${s.holdout_reveals}`
}

/** One log line per campaign event. */
export function formatEvent(e: CampaignEvent): string {
  switch (e.kind) {
    case 'round:opened': return `round ${short(e.roundId)} opened${e.resumed ? ' (resumed)' : ''}: champion ${e.championId}`
    case 'attempt:progress': return e.line
    case 'judged': return `round ${short(e.roundId)}: ${e.challengerId} judged at ${e.tier}: ${e.compare.verdict.value} (${e.compare.rule_fired}) mean ${e.compare.mean.toFixed(3)} ci [${e.compare.ci[0].toFixed(3)}, ${e.compare.ci[1].toFixed(3)}] n_eff ${e.compare.n_eff}; ${spentOf(e.spent)}`
    case 'decided': return `round ${short(e.roundId)}: decided${e.verdict !== undefined ? ` ${e.verdict}` : ''}${e.promoted !== undefined ? `, promoted ${e.promoted}` : ''}; ${spentOf(e.spent)}`
    case 'paused': return `round ${short(e.roundId)}: paused for a ${e.action} consent on ${e.candidate}`
    case 'stopped': return `campaign stopped: ${e.reason}; ${spentOf(e.spent)}`
  }
}

export function formatCampaign(r: CampaignResult): string {
  const out = [
    r.paused
      ? `campaign   paused: ${r.action} consent needed for ${r.candidate} (round ${r.roundId}); rerun with --wait, or consent and rerun`
      : `campaign   stopped: ${r.stopped}`,
    `promoted   ${r.promoted.join(', ') || '(none)'}`,
    `rounds     ${r.rounds.length}`,
  ]
  for (const round of r.rounds) {
    out.push(`  ${round.roundId}  ${round.challengerId ?? '(no challenger)'}  ${round.tier ?? '-'}  ${round.verdict ?? '-'}${round.promoted !== undefined ? '  promoted' : ''}`)
  }
  return out.join('\n')
}
