// `propose --dry-run`: everything `round` does before it costs anything —
// render the proposer view, run the adapter, validate the Proposal, diff-scan
// the patch against the held-in task ids — and stop. No ledger write (the
// champion id is computed from its coordinates, never proposed), no scope, no
// attempt. The full path is `round`; `propose` without --dry-run refuses.

import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, resolve } from 'node:path'
import { challengerId, type Ledger } from '@oldbulb/samsara-ledger'
import { loadPack, surfaceBoundaries } from '@oldbulb/samsara-pack'
import type { CommandAdapter, ProposerAdapter } from '@oldbulb/samsara-proposers'
import { policyFor } from '@oldbulb/samsara-sandbox'
import { scan, type Violation } from '@oldbulb/samsara-scope'
import { hashDir, policyPaths } from '@oldbulb/samsara-workdir'
import { adapterOf, checkProposal, renderView, viewEnvironmentOf, PROPOSER_DIR, VIEW_DIR, type RoundDeps, type SkillProposal } from './round.ts'
import { bookOf, championProposal, selectTasks, type RunRequest } from './run.ts'

export interface ProposeRequest extends RunRequest {
  /** Adapter name on ctx.proposers, or a path (contains `/`) run through the command adapter. */
  proposer: string
  metric: string
  dryRun: true
  /** Human adapter inputs from the command line, as on `round`. */
  humanSkillDir?: string
  intent?: string
}

export interface ProposeDeps extends Pick<RoundDeps, 'loops' | 'route' | 'signal' | 'log' | 'championSkillDir' | 'proposers'> {
  /** Only the proposer view is read; nothing is written. */
  ledger: Pick<Ledger, 'read'>
  /** Builds the command adapter for a `./command` proposer (the plugin wires ctx.subprocess in; tests pass their own spawn). */
  commandAdapter: (config: { name: string; command: string }) => CommandAdapter
}

export interface ProposeResult {
  proposal: SkillProposal
  championId: string
  viewDir: string
  proposalPath: string
  patchSha: string
  scan: { ok: boolean; violations: Violation[] }
}

/** A `--proposer` value that names an executable rather than a registered adapter. */
export function isCommandProposer(name: string): boolean {
  return name.includes('/')
}

function stripPropose(req: ProposeRequest): RunRequest {
  const { proposer: _p, metric: _m, dryRun: _d, humanSkillDir: _h, intent: _i, ...run } = req
  return run
}

function proposerOf(req: ProposeRequest, deps: ProposeDeps): ProposerAdapter {
  if (isCommandProposer(req.proposer)) {
    const command = resolve(req.proposer)
    return deps.commandAdapter({ name: basename(command), command })
  }
  return adapterOf(req, deps)
}

export async function propose(req: ProposeRequest, deps: ProposeDeps): Promise<ProposeResult> {
  if (req.set === 'holdout') throw new Error('propose: the proposer view cannot be rendered from the held-out set (use smoke or holdin)')
  const def = loadPack(req.pack)
  const book = bookOf(def)
  const runReq = stripPropose(req)
  const tasks = selectTasks(book, req)
  const heldIn = [...book.tasks('smoke'), ...book.tasks('holdin')].map((t) => t.task_id)
  const log = deps.log ?? (() => {})

  // 1. the champion's coordinates give its id; nothing is written.
  const championId = challengerId(championProposal(def, book, runReq, deps))
  const championSkillDir = runReq.skillDir ?? deps.championSkillDir ?? def.skillDir

  // 2. the view, as round renders it.
  const viewDir = resolve(req.out, VIEW_DIR)
  renderView(viewDir, { championId, championSkillDir, metric: req.metric, tasks, ledger: deps.ledger, environment: viewEnvironmentOf(def, runReq, deps.loops) })
  log(`view rendered at ${viewDir} (${tasks.length} ${req.set} tasks, champion ${championId})`)

  // 3. the proposer, then the checks round makes before it opens a scope.
  const adapter = proposerOf(req, deps)
  const workDir = resolve(req.out, PROPOSER_DIR)
  mkdirSync(workDir, { recursive: true })
  const sandbox = policyFor({ ...policyPaths(workDir, def), readOnly: [viewDir], homeDir: homedir() })
  const proposal = await adapter.propose({ viewDir, workDir, signal: deps.signal ?? new AbortController().signal, parent: championId, sandbox })
  checkProposal(proposal, heldIn, req.metric)
  const proposalPath = resolve(req.out, 'proposal.json')
  writeFileSync(proposalPath, JSON.stringify(proposal, null, 2) + '\n')
  log(`proposal by ${proposal.proposer.name}@${proposal.proposer.version}: ${proposal.intent}`)

  // 4. the diff scan (E8/S5) exactly as scopes.open runs it, without the scope.
  const mount = def.manifest.skill.dir.replace(/\/+$/, '')
  const result = scan({ surface: 'skill', skill_dir: proposal.patch.skill_dir, mount }, surfaceBoundaries(def), tasks.map((t) => t.task_id))
  return { proposal, championId, viewDir, proposalPath, patchSha: hashDir(proposal.patch.skill_dir), scan: result }
}

export function formatPropose(r: ProposeResult): string {
  const p = r.proposal
  const pred = p.prediction
  const prediction = [
    `${pred.metric} ${pred.direction}`,
    ...(pred.magnitude !== undefined ? [`by ${pred.magnitude}`] : []),
    ...(pred.predicted_fixes?.length ? [`fixes ${pred.predicted_fixes.join(',')}`] : []),
    ...(pred.at_risk?.length ? [`at risk ${pred.at_risk.join(',')}`] : []),
  ].join(' ')
  const out = [
    `dry run    no scope opened, no attempt run`,
    `proposer   ${p.proposer.name}@${p.proposer.version} config ${p.proposer.config_sha.slice(0, 12)}`,
    `champion   ${r.championId}`,
    `surface    ${p.surface}`,
    `patch      ${r.patchSha.slice(0, 12)} ${p.patch.skill_dir}`,
    `intent     ${p.intent}`,
    `prediction ${prediction}`,
    `view       ${r.viewDir}`,
    `proposal   ${r.proposalPath}`,
    `scan       ${r.scan.ok ? 'ok' : `REJECTED (${r.scan.violations.length} violation(s))`}`,
  ]
  for (const v of r.scan.violations) out.push(`  ${v.code} ${v.where}: ${v.detail}`)
  return out.join('\n')
}
