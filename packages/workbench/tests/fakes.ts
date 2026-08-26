// Fakes for the tools tests: the dsh seams the tools call (tools registry,
// jobs, approval, the calling agent) and the service verbs they delegate to,
// over the lifecycle package's in-memory ledger and loops.

import { cpSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createBook } from '@oldbulb/samsara-book'
import { EMPTY_STATE } from '@oldbulb/samsara-champion'
import { JobId, SessionId, type Agent, type ApprovalOutcome, type ApprovalRequest, type JobHooks, type JobStart, type ToolDefinition, type ToolRunContext } from '@oldbulb/samsara-kernel'
import { challengerId, type ChallengerProposal, type NoiseFloorRow, type NotebookRow } from '@oldbulb/samsara-ledger'
import type { CalibrateInput, CampaignHooks, CampaignInput, CampaignResult, ControlHooks, ControlInput, ControlResult, LifecycleStatus, NextAction } from '@oldbulb/samsara-lifecycle'
import { loadPack } from '@oldbulb/samsara-pack'
import type { Proposal, ProposeInput, ProposerAdapter } from '@oldbulb/samsara-proposers'
import { championProposal, type RouteConfig } from '@oldbulb/samsara-runner'
import { FakeLedger, fakeLoops, sha, PACK } from '../../lifecycle/tests/fakes.ts'
import { createTools, settingsOf, type Settings, type ToolDeps } from '../src/tools.ts'

export { FakeLedger, sha, PACK } from '../../lifecycle/tests/fakes.ts'

/** The lifecycle fake plus the notebook table the tools write `job/done` rows to (append-only by id, as the ledger). */
export class WorkbenchLedger extends FakeLedger {
  notebook: NotebookRow[] = []
  async recordNotebook(row: NotebookRow): Promise<string> {
    if (!this.notebook.some((r) => r.id === row.id)) this.notebook.push(row)
    return row.id
  }
}

/** The fixture pack's parent is the packs directory: one pack, named `fixture`. */
export const PACKS_DIR = resolve(PACK, '..')
export const ROUTE: RouteConfig = { provider: 'p', model: 'attempt-model', credentialRef: 'cred' }
export const OPERATOR_ROUTE = { provider: 'p', model: 'operator-model' }

// ------------------------------------------------------------------ dsh

export class FakeTools {
  registered = new Map<string, ToolDefinition>()
  register(def: ToolDefinition): () => void {
    this.registered.set(def.name, def)
    return () => { this.registered.delete(def.name) }
  }
}

export interface StartedJob {
  id: JobId
  spec: JobStart
  hooks: JobHooks
}

export class FakeJobs {
  started: StartedJob[] = []
  killed: { id: JobId; reason?: string }[] = []
  start(spec: JobStart): JobId {
    const id = JobId(`${spec.kind}-${this.started.length + 1}`)
    const hooks = spec.run()
    this.started.push({ id, spec, hooks })
    return id
  }
  kill(id: JobId, caller?: Agent, reason?: string): 'requested' | 'already-finished' {
    const job = this.started.find((j) => j.id === id)
    if (!job) throw new Error(`no job ${id}`)
    if (job.spec.owner !== caller) throw new Error(`job ${id} belongs to another session`)
    this.killed.push({ id, ...(reason !== undefined ? { reason } : {}) })
    job.hooks.cancel(reason)
    return 'requested'
  }
}

export class FakeApproval {
  requests: ApprovalRequest[] = []
  /** Runs while the question is pending (a turn cancelled under it, say). */
  pending?: (req: ApprovalRequest) => void
  constructor(public outcome: ApprovalOutcome = 'allowed-once') {}
  async request(req: ApprovalRequest): Promise<ApprovalOutcome> {
    this.requests.push(req)
    this.pending?.(req)
    return this.outcome
  }
}

/** The calling agent as the tools read it: its session id, the route its session runs on, and a log of `seq` events. */
export function fakeAgent(route: { provider: string; model: string } | undefined = OPERATOR_ROUTE, id = 'op-1', seq = 0): Agent {
  return { id: SessionId(id), session: { requestContext: () => route, events: Array.from({ length: seq }) } } as unknown as Agent
}

export function fakeExec(agent?: Agent, signal = new AbortController().signal): ToolRunContext {
  return {
    callId: 'call-1', rootCallId: 'call-1', name: 'samsara', arguments: {}, token: Symbol('exec'),
    ...(agent ? { agent } : {}),
    signal, deferContext() {}, concludeTurn() {},
  } as unknown as ToolRunContext
}

// ------------------------------------------------------------ lifecycle

export class FakeLifecycle {
  statusValue: LifecycleStatus = { champion: EMPTY_STATE, rounds: [], pending: [], noiseFloors: [], experiments: [] }
  actions: NextAction[] = [{ kind: 'drop' }]
  asked: string[] = []
  calibrated: CalibrateInput[] = []
  campaigns: { input: CampaignInput; hooks: CampaignHooks }[] = []
  controls: { input: ControlInput; hooks: ControlHooks }[] = []
  campaignResult: CampaignResult = { stopped: 'max_rounds', rounds: [], promoted: [] }
  /** Set to hold a campaign open until its signal aborts. */
  campaignWaits = false

  status(): LifecycleStatus { return this.statusValue }
  nextActions(id: string): NextAction[] {
    this.asked.push(id)
    return this.actions
  }
  async calibrate(input: CalibrateInput): Promise<NoiseFloorRow> {
    this.calibrated.push(input)
    input.run.log?.('calibrating')
    return {
      id: sha('floor'), eval_config_sha: sha('ec'), champion_id: challengerId(input.champion), loop: input.champion.route.loop, metric: input.metric,
      measured_at: '2026-08-26T00:00:00.000Z', unit: 'entity', sd_paired: 0.1234, n_reruns: input.reruns, n_tasks: 4, tier: input.set,
    }
  }
  async campaign(input: CampaignInput, hooks: CampaignHooks): Promise<CampaignResult> {
    this.campaigns.push({ input, hooks })
    hooks.onEvent({ kind: 'round:opened', roundId: sha('round'), championId: challengerId(input.champion().proposal), resumed: false })
    if (this.campaignWaits) {
      await new Promise<void>((done) => { hooks.signal.addEventListener('abort', () => done(), { once: true }) })
      return { stopped: 'aborted', rounds: [], promoted: [] }
    }
    return this.campaignResult
  }
  async control(input: ControlInput, hooks: ControlHooks): Promise<ControlResult> {
    this.controls.push({ input, hooks })
    hooks.onEvent({ kind: 'round:opened', roundId: sha('round'), championId: challengerId(input.champion.proposal), resumed: false })
    const id = sha('control')
    return {
      control: input.kind, roundId: sha('round'), challengerId: id,
      compare: {
        challenger_id: id, vs_id: challengerId(input.champion.proposal), tier: 'holdout', truth_snapshot_id: sha('t'), per_task: [], mean: 0.01, ci: [-0.1, 0.12],
        method: 'm', cluster_key: 'e', n_eff: 4, mde: 0.1, rule_fired: 'hold:ci', verdict: { value: 'hold', by: 'gate-default@0', rule: 'hold:ci' }, at: '2026-08-26T00:00:00.000Z',
      },
    }
  }
}

// ------------------------------------------------------------ proposers

/** A proposer that copies the fixture skill into its work directory; `config.model` (and a provider) when it declares a route (as claude-p does); under claude-p's name when a test needs the model proposer itself. */
export class FakeAdapter implements ProposerAdapter {
  readonly name: string
  readonly version = '1'
  readonly configSha = sha('proposer-config')
  config?: { model: string; provider?: string }
  proposed: ProposeInput[] = []
  constructor(route: { model?: string; provider?: string } = {}, name = 'fake-proposer') {
    this.name = name
    if (route.model !== undefined) this.config = { model: route.model, ...(route.provider !== undefined ? { provider: route.provider } : {}) }
  }
  async propose(input: ProposeInput): Promise<Proposal> {
    this.proposed.push(input)
    const skillDir = resolve(input.workDir, 'skill')
    mkdirSync(input.workDir, { recursive: true })
    cpSync(loadPack(PACK).skillDir, skillDir, { recursive: true })
    return {
      parent: input.parent ?? '', surface: 'skill', patch: { surface: 'skill', skill_dir: skillDir }, intent: 'a fake improvement',
      prediction: { metric: 'm', direction: 'up' }, proposer: { name: this.name, version: this.version, config_sha: this.configSha },
    }
  }
}

// ---------------------------------------------------------------- setup

export interface Harness {
  tools: Map<string, ToolDefinition>
  deps: ToolDeps
  settings: Settings
  ledger: WorkbenchLedger
  lifecycle: FakeLifecycle
  jobs: FakeJobs
  approval: FakeApproval
  adapter: FakeAdapter
  out: string
  /** The champion row the tools compute for the fixture pack on the fake loop and a set, and its id. */
  champion(set: 'smoke' | 'holdin' | 'holdout'): { id: string; proposal: ChallengerProposal }
  championId(set: 'smoke' | 'holdin' | 'holdout'): string
}

export function openHarness(over: { approval?: ApprovalOutcome; webServer?: false; adapterModel?: string; adapterProvider?: string; adapterName?: string } = {}): Harness {
  const out = mkdtempSync(join(tmpdir(), 'samsara-workbench-'))
  const ledger = new WorkbenchLedger()
  const lifecycle = new FakeLifecycle()
  const jobs = new FakeJobs()
  const approval = new FakeApproval(over.approval)
  const adapter = new FakeAdapter({ ...(over.adapterModel !== undefined ? { model: over.adapterModel } : {}), ...(over.adapterProvider !== undefined ? { provider: over.adapterProvider } : {}) }, over.adapterName)
  const loops = fakeLoops()
  const settings = settingsOf({ packsDir: PACKS_DIR, out, pack: 'fixture', loop: 'fake', metric: 'm' })
  const deps: ToolDeps = {
    lifecycle, ledger, jobs, approval, loops, proposers: { get: (name) => (name === adapter.name ? adapter : undefined) },
    route: () => ROUTE,
    ...(over.webServer === false ? {} : { webServer: () => ({ host: '127.0.0.1', port: 8080 }) }),
  }
  const tools = new Map(createTools(deps, settings).map((t) => [t.name, t]))
  const def = loadPack(PACK)
  const book = createBook({
    sets: { smoke: def.taskSets.smoke.tasks, holdin: def.taskSets.holdin.tasks, holdout: def.taskSets.holdout.tasks },
    entityKey: 'entity_key',
    holdoutPolicy: { mde: def.manifest.holdout?.mde ?? 0.05, budget: def.manifest.holdout?.budget ?? 0 },
  })
  const champion = (set: 'smoke' | 'holdin' | 'holdout') => {
    const proposal = championProposal(
      def, book,
      { pack: def.dir, loop: 'fake', set, repeat: 1, out, maxTurns: settings.maxTurns, maxMinutes: settings.maxMinutes },
      { loops, route: ROUTE, championSkillDir: def.skillDir },
    )
    return { id: challengerId(proposal), proposal }
  }
  return { tools, deps, settings, ledger, lifecycle, jobs, approval, adapter, out, champion, championId: (set) => champion(set).id }
}
