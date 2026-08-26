// @oldbulb/samsara-workbench/tools — the model-facing `samsara_*` tools,
// mounted inside the operator preset so only agents on it see them. The
// read-only tools render ledger views through the operator viewer and the
// service's read-only verbs; the spending tools quote a cost, check the
// experiment's budget, ask the person through ctx.approval inside `execute`
// and run as ctx.jobs owned by the calling agent. Consent (sign-off, gate
// changes, budgets, predictions) never passes through here: it stays in the
// /samsara commands, and a paused campaign tells the operator which one to
// ask for.

import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, relative, resolve } from 'node:path'
import { createBook, type Book, type TaskSet } from '@oldbulb/samsara-book'
// Value import so the ctx.champion augmentation is installed.
import '@oldbulb/samsara-champion'
import { bench, type BenchAttemptRow, type BenchTaskRow } from '@oldbulb/samsara-gate-catalog/bench'
import {
  Context,
  JobId,
  Schema,
  defineTool,
  type Agent,
  type ApprovalOutcome,
  type ApprovalService,
  type ContentBlock,
  type InferArgs,
  type JobOutcome,
  type JobRegistry,
  type JsonValue,
  type ParameterSchemaSpec,
  type ToolDefinition,
  type ToolRunContext,
} from '@oldbulb/samsara-kernel'
import { canonicalJson, challengerId, evalConfigSha, sha256, type ChallengerProposal, type ExperimentRow, type Ledger, type NotebookRow, type RoundRow, type View } from '@oldbulb/samsara-ledger'
import { sameRoute, type CampaignInput, type CampaignProposer, type CampaignResult, type ControlKind, type Lifecycle, type ProposerRoute } from '@oldbulb/samsara-lifecycle'
import { loadPack, type PackDefinition } from '@oldbulb/samsara-pack'
import { CLAUDE_P_NAME, type ProposerAdapter, type Proposers } from '@oldbulb/samsara-proposers'
import { calibrate, campaignRunOf, championProposal, formatEvent, newRunId, routeOf, type Loops, type RouteConfig, type RunRequest } from '@oldbulb/samsara-runner'
import { benchGatesOf } from '@oldbulb/samsara-runner/bench'
import { propose, type ProposeDeps } from '@oldbulb/samsara-runner/propose'
import { adapterOf, renderView, viewEnvironmentOf } from '@oldbulb/samsara-runner/round'
import { policyFor } from '@oldbulb/samsara-sandbox'
import { hashDir, policyPaths } from '@oldbulb/samsara-workdir'
import { codeOf, describeError, explained, type Hints } from './errors.ts'
import { jobTags } from './jobs.ts'
import { notebookId } from './notebook.ts'

export { sameRoute, type ProposerRoute } from '@oldbulb/samsara-lifecycle'

export const name = 'workbench-tools'
export const inject = ['tools', 'lifecycle', 'ledger', 'jobs', 'approval', 'loops', 'proposers']

export interface Config {
  /** Directory the packs live under; every subdirectory with a pack.yaml is one. */
  packsDir?: string
  /** Directory the runs write under. */
  out?: string
  /** Default pack (a name under packsDir, or a directory) for the tools that take none. */
  pack?: string
  /** Default loop for the tools that take none. */
  loop?: string
  /** Primary metric (kind reality) floors are measured on and controls decide on; a campaign judges its experiment's own. */
  metric?: string
  nEffFloor?: number
  /** Replicates per tier. */
  repeat?: number
  maxTurns?: number
  maxMinutes?: number
  parallel?: number
  allow?: string[]
  /** The attempt route: provider and model default to the host's agentDefaultModel selection; the rest as on the runner row. */
  provider?: string
  model?: string
  baseUrl?: string
  baseUrlKind?: 'direct' | 'proxy'
  credentialRef?: string
  lane?: string
}

export const Config: Schema<Config> = Schema.object({
  packsDir: Schema.string().default('packs'),
  out: Schema.string().default('data/runs/workbench'),
  pack: Schema.string(),
  loop: Schema.string(),
  metric: Schema.string(),
  nEffFloor: Schema.number().default(3),
  repeat: Schema.number().default(1),
  maxTurns: Schema.number().default(50),
  maxMinutes: Schema.number().default(20),
  parallel: Schema.number(),
  allow: Schema.array(Schema.string()),
  provider: Schema.string(),
  model: Schema.string(),
  baseUrl: Schema.string(),
  baseUrlKind: Schema.union(['direct', 'proxy'] as const),
  credentialRef: Schema.string(),
  lane: Schema.string(),
})

/** The row's config with its defaults applied. */
export interface Settings {
  packsDir: string
  out: string
  pack?: string
  loop?: string
  metric?: string
  nEffFloor: number
  repeat: number
  maxTurns: number
  maxMinutes: number
  parallel?: number
  allow?: string[]
}

export function settingsOf(config: Config): Settings {
  return {
    packsDir: config.packsDir ?? 'packs',
    out: config.out ?? 'data/runs/workbench',
    nEffFloor: config.nEffFloor ?? 3,
    repeat: config.repeat ?? 1,
    maxTurns: config.maxTurns ?? 50,
    maxMinutes: config.maxMinutes ?? 20,
    ...(config.pack !== undefined ? { pack: config.pack } : {}),
    ...(config.loop !== undefined ? { loop: config.loop } : {}),
    ...(config.metric !== undefined ? { metric: config.metric } : {}),
    ...(config.parallel !== undefined ? { parallel: config.parallel } : {}),
    ...(config.allow?.length ? { allow: config.allow } : {}),
  }
}

/** The services the tools call, structural so tests compose fakes. */
export interface ToolDeps {
  lifecycle: Pick<Lifecycle, 'status' | 'nextActions' | 'calibrate' | 'campaign' | 'control'>
  ledger: Pick<Ledger, 'read' | 'experiment' | 'attemptsOf' | 'scoresOf' | 'noiseFloorFor' | 'recordNotebook'>
  jobs: Pick<JobRegistry, 'start' | 'kill'>
  approval: Pick<ApprovalService, 'request'>
  loops: Loops
  proposers: Pick<Proposers, 'get'>
  /** The attempt route, read per call (the host's default model may change). */
  route(): RouteConfig
  /** The champion's kept skill directory (ctx.champion.current().skill_ref), read per call; absent = the pack's. */
  championSkillDir?(): string | undefined
  /** The web server the evidence links point at, when one is mounted. */
  webServer?(): { host: string; port: number } | undefined
  /** Where a failure that changes no result goes (a notebook row not recorded). */
  warn?(line: string): void
}

export type RefusalCode = 'NO_AGENT' | 'BUDGET_EXCEEDED' | 'NOT_APPROVED' | 'OPERATOR_IS_PROPOSER' | 'NO_NOISE_FLOOR' | 'NOT_OWNER'

/** A spending tool that did nothing: no approval was granted, or a check before it failed. */
export interface Refusal {
  refused: true
  code: RefusalCode
  message: string
  approval?: ApprovalOutcome
}

export const VIEWS = ['challengers', 'compares', 'rounds', 'experiments', 'servings', 'noise_floors', 'consents'] as const
export const TIERS = ['smoke', 'holdin', 'holdout'] as const
/** Same-config reruns a noise floor needs (S1); the onboarding quote counts these. */
export const MIN_RERUNS = 3

const NO_AGENT: Refusal = { refused: true, code: 'NO_AGENT', message: 'no agent on this call: the spending tools run for the operator session only; nothing was started' }

/** A refusal reads as the service's would: the message, and for a code the errors table knows, the sentence and the next action. */
function refusal(code: RefusalCode, message: string, hints?: Hints): Refusal {
  return { refused: true, code, message: explained(code, message, hints) }
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function short(id: string): string {
  return id.slice(0, 12)
}

/** Lossless JSON of a result: `undefined` fields go, class instances flatten. */
function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

function linkIn(value: JsonValue): string | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && typeof value['link'] === 'string' ? value['link'] : undefined
}

/** One output contract for every tool: the canonical value as text, the evidence link (when any) first and in the presentation meta. */
const OUTPUT = {
  schema: { type: 'json' },
  render(_args: unknown, value: JsonValue): ContentBlock[] {
    const link = linkIn(value)
    return [{ type: 'text', text: `${link !== undefined ? `evidence: ${link}\n` : ''}${JSON.stringify(value, null, 2)}` }]
  },
  presentationMeta(_args: unknown, value: JsonValue): JsonValue {
    const link = linkIn(value)
    return link !== undefined ? { link } : null
  },
} as const

interface ToolSpec<S extends ParameterSchemaSpec> {
  name: string
  description: string
  parameters: S
  execute(args: InferArgs<S>, exec: ToolRunContext): Promise<unknown>
}

function tool<const S extends ParameterSchemaSpec>(spec: ToolSpec<S>): ToolDefinition {
  return defineTool({
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: OUTPUT,
    // A service or ledger refusal reaches the agent as a sentence and a next action, never as a bare code.
    execute: async (args, exec) => {
      try {
        return json(await spec.execute(args, exec))
      } catch (e) {
        if (codeOf(e) !== undefined) throw new Error(describeError(e), { cause: e })
        throw e
      }
    },
  })
}

// ------------------------------------------------------------- operator

/** The round row's `operator`: the calling agent's session and the route it runs on. */
export function operatorOf(agent: Pick<Agent, 'id' | 'session'>): NonNullable<RoundRow['operator']> {
  const route = agent.session.requestContext()
  return { session_id: agent.id, ...(route ? { provider: route.provider, model: route.model } : {}) }
}

/**
 * What an adapter declares of the route it proposes on, as `openRound` takes
 * it: the model proposer's configured model (claude-p's `config.model`, and a
 * provider when the adapter names one); `'unknown'` when it declares none —
 * the model proposer that leaves its model to its CLI's default, and the
 * command and human adapters, whose own route is opaque to the host.
 */
export function proposerRouteOf(adapter: ProposerAdapter): ProposerRoute | 'unknown' {
  const config = (adapter as { config?: { model?: unknown; provider?: unknown } }).config
  if (typeof config?.model === 'string') return { model: config.model, ...(typeof config.provider === 'string' ? { provider: config.provider } : {}) }
  return 'unknown'
}

/**
 * The operator session and the proposer must not be one route. The service
 * refuses the equal case itself (`OPERATOR_IS_PROPOSER` in `openRound`); here
 * it is refused before the person is asked, and so are the two cases the
 * service cannot compare while the proposer is a model: the model proposer
 * without a declared model, and an operator without a request context (a
 * check that cannot run is not a pass). Command and human proposers declare
 * nothing and pass as `'unknown'`.
 */
function routeRefusal(operator: NonNullable<RoundRow['operator']>, adapter: ProposerAdapter): Refusal | undefined {
  const route = proposerRouteOf(adapter)
  if (route === 'unknown') {
    if (adapter.name !== CLAUDE_P_NAME) return undefined
    return refusal('OPERATOR_IS_PROPOSER', `the model proposer ${adapter.name} declares no model (it runs its CLI's default), so the same-model check cannot run; configure model on its row`)
  }
  if (operator.model === undefined) return refusal('OPERATOR_IS_PROPOSER', `the operator session's route is unknown (no request context yet), so the same-model check against ${adapter.name} (${route.model}) cannot run`)
  if (sameRoute(operator, route)) return refusal('OPERATOR_IS_PROPOSER', `the operator session runs on ${operator.model}, the model proposer ${adapter.name} declares; the same model cannot propose and operate a round`)
  return undefined
}

/** `dir` is `root` or under it (both resolved). */
function within(root: string, dir: string): boolean {
  const rel = relative(root, dir)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

// ----------------------------------------------------------------- packs

/** Every pack directory under `packsDir`, sorted. */
export function packDirs(packsDir: string): string[] {
  const root = resolve(packsDir)
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(resolve(root, e.name, 'pack.yaml')))
    .map((e) => resolve(root, e.name))
    .sort()
}

/** A pack by directory, else by name under `packsDir`. */
export function packOf(settings: Settings, name: string | undefined): PackDefinition {
  const wanted = name ?? settings.pack
  if (wanted === undefined) throw new Error('no pack named: pass `pack`, or configure a default on the workbench-tools row')
  if (existsSync(resolve(wanted, 'pack.yaml'))) return loadPack(resolve(wanted))
  for (const dir of packDirs(settings.packsDir)) {
    const def = loadPack(dir)
    if (def.name === wanted) return def
  }
  throw new Error(`no pack "${wanted}" under ${resolve(settings.packsDir)} and no such directory`)
}

/** The book the runner's commands build for a pack (its `bookOf`, not exported): the three sets and the holdout policy. */
function bookOf(def: PackDefinition): Book {
  const book = createBook({
    sets: { smoke: def.taskSets.smoke.tasks, holdin: def.taskSets.holdin.tasks, holdout: def.taskSets.holdout.tasks },
    entityKey: 'entity_key',
    holdoutPolicy: { mde: def.manifest.holdout?.mde ?? 0.05, budget: def.manifest.holdout?.budget ?? 0 },
  })
  // S2/S7: a held-out set sharing an entity with the visible sets is refused (HoldoutNotDisjoint).
  book.assertDisjointHoldout()
  return book
}

function quote(what: string, attempts: number, usd: number | undefined): string {
  return usd !== undefined ? `${what} ≈ $${usd.toFixed(2)} (${attempts} attempts)` : `${what}: cost unknown (${attempts} attempts)`
}

/** Refuses before any approval: the experiment is closed, a budget line is spent, or the quote exceeds what is left in usd. */
function budgetOf(experiment: ExperimentRow, usd: number | undefined): Refusal | undefined {
  const { budget, spent } = experiment
  if (experiment.status !== 'active') return refusal('BUDGET_EXCEEDED', `experiment ${experiment.id} is ${experiment.status}; nothing runs under it`)
  for (const k of ['usd', 'attempts', 'rounds', 'holdout_reveals'] as const) {
    const limit = budget[k]
    if (limit !== undefined && spent[k] >= limit) return refusal('BUDGET_EXCEEDED', `experiment ${experiment.id} spent its ${limit} ${k} (${spent[k]}); raise it with /samsara budget before spending more`)
  }
  if (budget.usd !== undefined && usd !== undefined && spent.usd + usd > budget.usd) {
    return refusal('BUDGET_EXCEEDED', `experiment ${experiment.id} has ${(budget.usd - spent.usd).toFixed(2)} usd left of ${budget.usd}, the quote is ${usd.toFixed(2)}; raise it with /samsara budget or spend less`)
  }
  return undefined
}

function campaignDetail(result: CampaignResult): string {
  if (result.paused) {
    const command = `/samsara ${result.action === 'promote' ? 'approve' : 'reveal'} ${result.candidate}`
    return `paused: a ${result.action} consent is needed for ${result.candidate} (round ${result.roundId}); ask the person to type ${command}, then start the campaign again on the same experiment`
  }
  return `stopped: ${result.stopped}; ${result.rounds.length} round(s); promoted ${result.promoted.join(', ') || '(none)'}`
}

type Filter = { round_id?: string; experiment_id?: string; challenger_id?: string }

/** A row of any operator view against the filter: by the id field the view carries, or by the id lists it names. */
function matches(view: View, row: object, filter: Filter): boolean {
  const r = row as Record<string, unknown>
  const list = (k: string): unknown[] => (Array.isArray(r[k]) ? (r[k] as unknown[]) : [])
  const verdict = r['verdict'] as { round_id?: string } | undefined
  const { round_id, experiment_id, challenger_id } = filter
  if (round_id !== undefined && !(r['round_id'] === round_id || (view === 'rounds' && r['id'] === round_id) || list('round_ids').includes(round_id) || verdict?.round_id === round_id)) return false
  if (experiment_id !== undefined && !(r['experiment_id'] === experiment_id || (view === 'experiments' && r['id'] === experiment_id))) return false
  if (challenger_id !== undefined && !(
    r['challenger_id'] === challenger_id || r['champion_id'] === challenger_id || r['vs_id'] === challenger_id
    || (view === 'challengers' && r['id'] === challenger_id) || list('sibling_ids').includes(challenger_id)
  )) return false
  return true
}

// ----------------------------------------------------------------- tools

export function createTools(deps: ToolDeps, settings: Settings): ToolDefinition[] {
  const linkOf = (kind: 'challengers' | 'rounds' | 'experiments', id: string): string | undefined => {
    const web = deps.webServer?.()
    return web && web.port ? `http://${web.host}:${web.port}/samsara/${kind}/${encodeURIComponent(id)}` : undefined
  }
  const loopOf = (loop: string | undefined): string => {
    const name = loop ?? settings.loop
    if (name === undefined) throw new Error('no loop named: pass `loop`, or configure a default on the workbench-tools row')
    if (deps.loops.get(name) === undefined) throw new Error(`no loop provider named "${name}" is registered (is its plugin enabled in the profile?)`)
    return name
  }
  const metricOf = (metric: string | undefined): string => {
    const name = metric ?? settings.metric
    if (name === undefined) throw new Error('no metric named: pass `metric`, or configure a default on the workbench-tools row')
    return name
  }
  const runRequest = (def: PackDefinition, loop: string, set: TaskSet, repeat: number, out: string): RunRequest => ({
    pack: def.dir, loop, set, repeat, out, maxTurns: settings.maxTurns, maxMinutes: settings.maxMinutes,
    ...(settings.allow !== undefined ? { allow: settings.allow } : {}),
    ...(settings.parallel !== undefined ? { parallel: settings.parallel } : {}),
  })
  const skillDirOf = (def: PackDefinition): string => deps.championSkillDir?.() ?? def.skillDir
  /** The champion row for these coordinates, as the runner's commands compute it (its id is the same in every process). */
  const championOf = (def: PackDefinition, loop: string, set: TaskSet): ChallengerProposal =>
    championProposal(def, bookOf(def), runRequest(def, loop, set, settings.repeat, settings.out), { loops: deps.loops, route: deps.route(), championSkillDir: skillDirOf(def) })
  const floorOf = (champion: ChallengerProposal, metric: string) =>
    deps.ledger.noiseFloorFor(evalConfigSha(champion), challengerId(champion), champion.route.loop, metric)
  const meanUsd = (championId: string, tier: TaskSet): number | undefined => {
    const costs = deps.ledger.attemptsOf(championId).filter((a) => a.tier === tier && a.cost.usd !== undefined).map((a) => a.cost.usd!)
    return costs.length ? costs.reduce((s, x) => s + x, 0) / costs.length : undefined
  }
  const usdOf = (mean: number | undefined, attempts: number): number | undefined => (mean !== undefined ? mean * attempts : undefined)
  const calibrateQuote = (def: PackDefinition, loop: string, championId: string): string =>
    quote(`samsara_calibrate ${def.name}/${loop} on holdin x${MIN_RERUNS}`, def.taskSets.holdin.tasks.length * MIN_RERUNS, usdOf(meanUsd(championId, 'holdin'), def.taskSets.holdin.tasks.length * MIN_RERUNS))
  const outDir = (): string => resolve(settings.out, newRunId())
  const log = (lines: string[]) => (line: string) => { lines.push(line) }

  /**
   * The budget (when an experiment is charged) and the person's confirmation,
   * in that order; anything but a grant is a refusal. The call's signal
   * withdraws the question, and a grant that lands after the turn was
   * cancelled starts nothing.
   */
  const ask = async (exec: ToolRunContext, agent: Agent, toolName: string, reason: string, spend?: { experiment: ExperimentRow; usd: number | undefined }): Promise<Refusal | undefined> => {
    if (spend) {
      const over = budgetOf(spend.experiment, spend.usd)
      if (over) return over
    }
    const outcome = await deps.approval.request({ agent, toolName, callId: exec.callId, reason, signal: exec.signal })
    if (outcome !== 'allowed-once') return { ...refusal('NOT_APPROVED', `the person did not confirm "${reason}" (${outcome}); nothing was started`), approval: outcome }
    if (exec.signal.aborted) return { ...refusal('NOT_APPROVED', `the turn was cancelled while "${reason}" was being confirmed; nothing was started`), approval: 'cancelled' }
    return undefined
  }

  /**
   * The settled outcome of a job, on the notebook: the completion notice the
   * agent reads (the floor's sd, a campaign's verdicts, the consent to ask for)
   * reaches it through the jobs service, not a `samsara_*` result, so the
   * tools bind it to the record themselves. `seq` is the session's next
   * position when the job settled; the round is the last one the job opened.
   */
  const recordDone = (agent: Agent, id: JobId, kind: string, label: string, tag: { experiment_id?: string; round_ids: string[] }, outcome: JobOutcome): void => {
    const { session_id: _session, ...operator } = operatorOf(agent)
    const round_id = tag.round_ids.at(-1)
    const row = {
      session_id: String(agent.id), seq: agent.session.events.length, at: new Date().toISOString(), kind: 'job/done' as const, name: kind,
      args_sha: sha256(canonicalJson(label)), result_sha: sha256(canonicalJson({ status: outcome.status, detail: outcome.detail })),
      ...(round_id !== undefined ? { round_id } : {}),
      ...(tag.experiment_id !== undefined ? { experiment_id: tag.experiment_id } : {}),
      operator,
    } satisfies Omit<NotebookRow, 'id'>
    void deps.ledger.recordNotebook({ id: notebookId(row), ...row }).catch((e: unknown) => {
      deps.warn?.(`job ${id} (${kind}) settled ${outcome.status}; its notebook row was not recorded: ${messageOf(e)}`)
    })
  }

  /**
   * The work as a job the agent owns: its own AbortController, the event
   * lines as output, the outcome's detail as the completion notice and, on the
   * notebook, a `job/done` row. The job is tagged with the experiment it is
   * charged to and the rounds it opens (`onRound`) for as long as it runs,
   * which is how /samsara stop finds it by a round id and /samsara reconcile
   * knows a round is driven here.
   */
  const startJob = (agent: Agent, kind: string, label: string, experimentId: string | undefined, run: (signal: AbortSignal, log: (line: string) => void, onRound: (roundId: string) => void) => Promise<string>): JobId => {
    const tag = { ...(experimentId !== undefined ? { experiment_id: experimentId } : {}), round_ids: [] as string[] }
    let id: JobId | undefined
    const settle = (outcome: JobOutcome): JobOutcome => {
      if (id !== undefined) {
        jobTags.delete(id)
        recordDone(agent, id, kind, label, tag, outcome)
      }
      return outcome
    }
    id = deps.jobs.start({
      kind, label, owner: agent,
      run: () => {
        const ac = new AbortController()
        let lines: string[] = []
        const done = run(ac.signal, (line) => { lines.push(line) }, (roundId) => { tag.round_ids.push(roundId) }).then(
          (detail): JobOutcome => ({ status: 'completed', detail }),
          (e: unknown): JobOutcome => ({ status: ac.signal.aborted ? 'killed' : 'failed', detail: describeError(e) }),
        ).then(settle)
        return {
          cancel: (reason) => { ac.abort(reason ?? 'killed') },
          done,
          readOutput: () => {
            const text = lines.map((l) => `${l}\n`).join('')
            lines = []
            return text
          },
        }
      },
    })
    jobTags.set(id, tag)
    return id
  }

  /** What a campaign of `rounds` rounds costs and needs before it spends: the agent, a proposer on another route, a noise floor, the budget, the person. */
  const startCampaign = async (
    exec: ToolRunContext,
    toolName: string,
    kind: 'samsara-campaign' | 'samsara-round',
    args: { experiment_id: string; proposer: string; loop?: string; rounds: number; stop_on_promote?: boolean; shadow_gates?: string[]; holdout_replicates?: number },
  ) => {
    const agent = exec.agent
    if (!agent) return NO_AGENT
    const experiment = deps.ledger.experiment(args.experiment_id)
    if (!experiment) throw new Error(`no experiment ${args.experiment_id} on the ledger; pre-register one with /samsara predict`)
    const def = packOf(settings, experiment.pack)
    const loop = loopOf(args.loop)
    const metric = experiment.prediction.metric
    const adapter = adapterOf({ proposer: args.proposer, metric }, deps)
    const operator = operatorOf(agent)
    const sameModel = routeRefusal(operator, adapter)
    if (sameModel) return sameModel
    const champion = championOf(def, loop, 'holdin')
    const championId = challengerId(champion)
    if (!floorOf(champion, metric)) return refusal('NO_NOISE_FLOOR', `no noise floor for ${def.name}/${loop} on ${metric}; a round judged at holdout needs one`, { calibrate: calibrateQuote(def, loop, championId) })
    const { smoke, holdin, holdout } = def.taskSets
    const holdoutRepeat = args.holdout_replicates ?? settings.repeat
    if (!(Number.isInteger(holdoutRepeat) && holdoutRepeat >= 1)) throw new Error(`holdout_replicates must be a positive integer, got ${args.holdout_replicates}`)
    const perRound = smoke.tasks.length + holdin.tasks.length * settings.repeat + holdout.tasks.length * holdoutRepeat
    const attempts = perRound * args.rounds
    const usd = usdOf(meanUsd(championId, 'holdin'), attempts)
    const shadow = args.shadow_gates?.length ? ` shadow ${args.shadow_gates.join(',')}` : ''
    // The person confirms what the experiment pre-registered: with auto_reveal the held-out tier runs without a reveal consent per row.
    const reveal = experiment.auto_reveal ? ', held-out reveal pre-registered (auto_reveal: no /samsara reveal per round)' : ''
    const reason = quote(`${kind === 'samsara-round' ? 'one round' : `${args.rounds} round(s)`} on experiment ${short(experiment.id)}: ${def.name}/${loop} by ${adapter.name}, held-out x${holdoutRepeat}${shadow}${reveal}`, attempts, usd)
    const refused = await ask(exec, agent, toolName, reason, { experiment, usd })
    if (refused) return refused

    const out = outDir()
    const book = bookOf(def)
    const runReq = runRequest(def, loop, 'holdin', settings.repeat, out)
    const proposer: CampaignProposer = {
      name: adapter.name, version: adapter.version, configSha: adapter.configSha,
      // E9: the proposer reads its rendered view, the pack's skill/ and loader/ and the runtimes; writes only its work directory.
      propose: (input) => adapter.propose({ ...input, sandbox: policyFor({ ...policyPaths(input.workDir, def), readOnly: [input.viewDir], homeDir: homedir() }) }),
    }
    const input: CampaignInput = {
      experimentId: experiment.id,
      pack: def.dir,
      // The champion as served when each round opens: its kept skill after a promotion.
      champion: () => {
        const skillDir = skillDirOf(def)
        return { proposal: championProposal(def, book, runReq, { loops: deps.loops, route: deps.route(), championSkillDir: skillDir }), skillDir }
      },
      proposer,
      metric,
      nEffFloor: settings.nEffFloor,
      set: 'holdin',
      tiers: { holdin: { repeat: settings.repeat }, holdout: { repeat: holdoutRepeat } },
      stop: { maxRounds: args.rounds, maxConsecutiveHolds: args.rounds, stopOnPromote: args.stop_on_promote ?? kind === 'samsara-round' },
      // Never: a held-out reveal is the person's — the holdout_reveal consent (/samsara reveal) or the experiment's pre-registered auto_reveal — not an argument of the agent's.
      autoHoldout: false,
      ...(args.shadow_gates !== undefined ? { shadowGates: args.shadow_gates } : {}),
      out,
      run: campaignRunOf(runReq, { route: deps.route() }),
      operator,
      // The service refuses every round the operator would propose for itself.
      proposerRoute: proposerRouteOf(adapter),
    }
    const job_id = startJob(agent, kind, reason, experiment.id, (signal, log, onRound) => deps.lifecycle.campaign(input, {
      onEvent: (e) => {
        if (e.kind === 'round:opened') onRound(e.roundId)
        log(formatEvent(e))
      },
      signal,
      renderView: (dir, view) => renderView(dir, { ...view, ledger: deps.ledger, environment: viewEnvironmentOf(def, runReq, deps.loops) }),
      hashDir,
    }).then(campaignDetail))
    return { job_id, experiment_id: experiment.id, champion_id: championId, approval: 'allowed-once', quote: reason, out, link: linkOf('experiments', experiment.id) }
  }

  const campaignParameters = {
    experiment_id: { type: 'string', description: 'The pre-registered experiment the rounds are charged to (/samsara predict).', required: true },
    proposer: { type: 'string', description: 'A proposer adapter registered on the host (samsara_status lists none; the profile does).', required: true },
    loop: { type: 'string', description: 'The loop the attempts run on; defaults to the configured one.' },
    shadow_gates: { type: 'array', items: { type: 'string' }, description: 'name@version of mounted gate policies judged beside the promotion gate; their rows set no verdict.' },
    holdout_replicates: { type: 'integer', description: 'Replicates per held-out task (the design the held-out test is powered for; the MDE shrinks with its square root). Defaults to the configured repeat.' },
  } as const

  return [
    tool({
      name: 'samsara_status',
      description: 'The champion, the open rounds, the pending consents, the latest noise floor per evaluation configuration and the experiments; for the pack and loop (given or configured) whether a noise floor and an A/A control exist, with the calibrate cost when not.',
      parameters: {
        pack: { type: 'string', description: 'Pack name under the packs directory, or a pack directory; defaults to the configured one.' },
        loop: { type: 'string', description: 'Loop provider name; defaults to the configured one.' },
        metric: { type: 'string', description: 'Primary metric; defaults to the configured one.' },
      },
      async execute(args) {
        const status = deps.lifecycle.status()
        const notes: string[] = []
        let onboarding: Record<string, unknown> | undefined
        const known = (args.pack ?? settings.pack) !== undefined && (args.loop ?? settings.loop) !== undefined && (args.metric ?? settings.metric) !== undefined
        if (known) {
          const def = packOf(settings, args.pack)
          const loop = loopOf(args.loop)
          const metric = metricOf(args.metric)
          const champion = championOf(def, loop, 'holdin')
          const championId = challengerId(champion)
          const floor = floorOf(champion, metric)
          const aa = deps.ledger.read('challengers', 'operator').some((r) => r.parent_ids[0] === championId && r.intent === 'control:aa')
          const calibrate = calibrateQuote(def, loop, championId)
          if (!floor) notes.push(`no noise floor for ${def.name}/${loop} on ${metric}: nothing is judged at holdout until one is measured (${calibrate})`)
          if (!aa) notes.push(`no A/A control was run on champion ${championId}: samsara_control { kind: "aa" } reads the gate on a known null`)
          onboarding = { pack: def.name, loop, metric, champion_id: championId, noise_floor: floor?.id ?? null, aa_control: aa, calibrate }
        } else {
          notes.push('no pack, loop or metric to check a noise floor for: pass them, or configure defaults on the workbench-tools row')
        }
        return {
          champion: status.champion,
          rounds: status.rounds.map((r) => ({ ...r, link: linkOf('rounds', r.id) })),
          pending: status.pending,
          noise_floors: status.noiseFloors,
          experiments: status.experiments.map((e) => ({ ...e, link: linkOf('experiments', e.id) })),
          onboarding,
          notes,
        }
      },
    }),

    tool({
      name: 'samsara_packs',
      description: 'The packs under the configured packs directory: name, task set sizes, holdout policy, skill directory.',
      parameters: {},
      async execute() {
        const packs = packDirs(settings.packsDir).map((dir) => {
          const def = loadPack(dir)
          return {
            name: def.name, dir: def.dir, skill_dir: def.skillDir,
            sets: { smoke: def.taskSets.smoke.tasks.length, holdin: def.taskSets.holdin.tasks.length, holdout: def.taskSets.holdout.tasks.length },
            holdout: def.manifest.holdout ?? {},
          }
        })
        return { packs_dir: resolve(settings.packsDir), packs }
      },
    }),

    tool({
      name: 'samsara_ledger_view',
      description: 'Rows of one ledger view as the operator sees them (compares without per-task deltas, held-out attempts and scores only as aggregates), filtered by round, experiment or challenger.',
      parameters: {
        view: { type: 'string', enum: VIEWS, required: true },
        filter: {
          type: 'object', additionalProperties: false,
          properties: { round_id: { type: 'string' }, experiment_id: { type: 'string' }, challenger_id: { type: 'string' } },
        },
        limit: { type: 'integer', description: 'At most this many rows, the latest recorded; default 50.' },
      },
      async execute(args) {
        const filter: Filter = args.filter ?? {}
        const rows = deps.ledger.read(args.view, 'operator').filter((r) => matches(args.view, r, filter))
        const limit = args.limit ?? 50
        return { view: args.view, filter, total: rows.length, rows: rows.slice(Math.max(0, rows.length - limit)) }
      },
    }),

    tool({
      name: 'samsara_compare',
      description: 'The compare rows of a challenger: the promotion gate\'s judgements and the shadow judgements beside them, side by side.',
      parameters: { challenger_id: { type: 'string', required: true } },
      async execute(args) {
        const rows = deps.ledger.read('compares', 'operator').filter((c) => c.challenger_id === args.challenger_id)
        return {
          challenger_id: args.challenger_id,
          promotion: rows.filter((c) => !('shadow' in c && c.shadow)),
          shadow: rows.filter((c) => 'shadow' in c && c.shadow),
          link: linkOf('challengers', args.challenger_id),
        }
      },
    }),

    tool({
      name: 'samsara_next_actions',
      description: 'What can be done next with a challenger row: add replicates, go to holdout, drop, decide; with the numbers the verdict rule used and a cost estimate.',
      parameters: { challenger_id: { type: 'string', required: true } },
      async execute(args) {
        return { challenger_id: args.challenger_id, actions: deps.lifecycle.nextActions(args.challenger_id), link: linkOf('challengers', args.challenger_id) }
      },
    }),

    tool({
      name: 'samsara_bench_gates',
      description: 'Measure gate policies on the champion\'s recorded reruns of one task set (rerun-vs-rerun null and injected effects): promotion rates per gate and scenario. Pure over the ledger; nothing runs.',
      parameters: {
        pack: { type: 'string' },
        loop: { type: 'string' },
        tier: { type: 'string', enum: TIERS, description: 'The task set whose reruns are benched; default holdin.' },
        metric: { type: 'string' },
        gates: { type: 'array', items: { type: 'string' }, description: 'Gate presets or catalog rules; default: the promotion gate and every catalog rule.' },
        resamples: { type: 'integer' },
        seed: { type: 'integer' },
      },
      async execute(args) {
        const def = packOf(settings, args.pack)
        const loop = loopOf(args.loop)
        const metric = metricOf(args.metric)
        const tier = args.tier ?? 'holdin'
        const championId = challengerId(championOf(def, loop, tier))
        const attempts: BenchAttemptRow[] = deps.ledger.attemptsOf(championId).filter((a) => a.tier === tier).map((a) => ({
          attemptId: a.id, task_id: a.task_id, status: a.status, cost: a.cost.usd !== undefined ? { usd: a.cost.usd } : {},
          scores: deps.ledger.scoresOf(a.id).map((s) => ({ metric: s.metric, value: s.value, kind: s.kind, ...(s.stratum !== undefined ? { stratum: s.stratum } : {}) })),
        }))
        if (attempts.length === 0) throw new Error(`no attempts of champion ${championId} on ${tier}; samsara_calibrate records the reruns a bench needs`)
        const tasks: BenchTaskRow[] = def.taskSets[tier].tasks.map((t) => ({ task_id: t.task_id, entity_key: t.entity_key, ...(t.stratum !== undefined ? { stratum: t.stratum } : {}) }))
        const result = await bench({
          attempts, tasks, metric, tier,
          gates: benchGatesOf(args.gates !== undefined ? { gates: args.gates } : {}),
          policy: { nEffFloor: settings.nEffFloor, ...(def.manifest.holdout?.mde !== undefined ? { mde: def.manifest.holdout.mde } : {}) },
          ...(args.resamples !== undefined ? { resamples: args.resamples } : {}),
          ...(args.seed !== undefined ? { seed: args.seed } : {}),
        })
        return { champion_id: championId, tier, ...result }
      },
    }),

    tool({
      name: 'samsara_propose_dry_run',
      description: 'Everything a round does before it costs an attempt: render the proposer view, run the proposer, validate its proposal, diff-scan the patch. No ledger write, no scope, no attempt; the proposer\'s own call is the only spend, its cost is unknown to the host, and the person confirms it.',
      parameters: {
        pack: { type: 'string' },
        loop: { type: 'string' },
        proposer: { type: 'string', description: 'A proposer adapter registered on the host (never a path: the profile decides what runs).', required: true },
        set: { type: 'string', enum: ['smoke', 'holdin'], description: 'The set the view renders; default holdin.' },
        metric: { type: 'string' },
      },
      async execute(args, exec) {
        if (args.proposer.includes('/')) throw new Error(`proposer "${args.proposer}" is a path; the tools run registered adapters only (a ./command proposer is the CLI profile's)`)
        const agent = exec.agent
        if (!agent) return NO_AGENT
        const def = packOf(settings, args.pack)
        const loop = loopOf(args.loop)
        const metric = metricOf(args.metric)
        const adapter = adapterOf({ proposer: args.proposer, metric }, deps)
        const reason = `samsara_propose_dry_run ${def.name}/${loop} by ${adapter.name}: proposer call, cost unknown`
        const refused = await ask(exec, agent, 'samsara_propose_dry_run', reason)
        if (refused) return refused
        const lines: string[] = []
        const out = outDir()
        const pdeps: ProposeDeps = {
          loops: deps.loops, route: deps.route(), ledger: deps.ledger, signal: exec.signal, log: log(lines), proposers: deps.proposers,
          commandAdapter: () => { throw new Error('a ./command proposer is the CLI profile\'s; the tools run registered adapters only') },
          championSkillDir: skillDirOf(def),
        }
        const r = await propose({ ...runRequest(def, loop, args.set ?? 'holdin', 1, out), proposer: args.proposer, metric, dryRun: true }, pdeps)
        return {
          dry_run: true, cost: 'proposer cost unknown', approval: 'allowed-once', quote: reason, champion_id: r.championId, proposal: r.proposal, patch_sha: r.patchSha,
          scan: r.scan, view_dir: r.viewDir, proposal_path: r.proposalPath, log: lines,
        }
      },
    }),

    tool({
      name: 'samsara_calibrate',
      description: 'Measure the noise floor (S1): rerun the champion on one task set with the null diff and record the paired spread per entity. Quotes the cost and asks the person before starting; runs as a job.',
      parameters: {
        pack: { type: 'string' },
        loop: { type: 'string' },
        set: { type: 'string', enum: TIERS, required: true },
        reruns: { type: 'integer', description: 'Same-config reruns of every task; at least 3.', required: true },
        metric: { type: 'string' },
      },
      async execute(args, exec) {
        if (!(args.reruns >= MIN_RERUNS)) throw new Error(`a noise floor needs at least ${MIN_RERUNS} reruns (S1), got ${args.reruns}`)
        const agent = exec.agent
        if (!agent) return NO_AGENT
        const def = packOf(settings, args.pack)
        const loop = loopOf(args.loop)
        const metric = metricOf(args.metric)
        const championId = challengerId(championOf(def, loop, args.set))
        const attempts = def.taskSets[args.set].tasks.length * args.reruns
        const reason = quote(`calibrate ${def.name}/${loop} on ${args.set} x${args.reruns}`, attempts, usdOf(meanUsd(championId, args.set), attempts))
        const refused = await ask(exec, agent, 'samsara_calibrate', reason)
        if (refused) return refused
        const out = outDir()
        const { repeat: _repeat, ...run } = runRequest(def, loop, args.set, args.reruns, out)
        const job_id = startJob(agent, 'samsara-calibrate', reason, undefined, async (signal, log) => {
          const floor = await calibrate({ ...run, metric, reruns: args.reruns }, { loops: deps.loops, route: deps.route(), lifecycle: deps.lifecycle, championSkillDir: skillDirOf(def), signal, log })
          return `noise floor ${floor.id}: sd_paired ${floor.sd_paired.toFixed(4)} (${floor.n_reruns} reruns x ${floor.n_tasks} tasks on ${floor.tier})`
        })
        return { job_id, champion_id: championId, approval: 'allowed-once', quote: reason, out }
      },
    }),

    tool({
      name: 'samsara_campaign_start',
      description: 'Rounds under a pre-registered experiment (propose → open → smoke → holdin → holdout → judge, per round) until a stop rule or a missing consent. Refuses over the experiment\'s budget, quotes the cost and asks the person; runs as a job that pauses on a consent and names the /samsara command to ask for.',
      parameters: {
        ...campaignParameters,
        rounds: { type: 'integer', description: 'Stop after this many rounds.', required: true },
        stop_on_promote: { type: 'boolean', description: 'Stop after the first promotion; default false.' },
      },
      execute: (args, exec) => startCampaign(exec, 'samsara_campaign_start', 'samsara-campaign', args),
    }),

    tool({
      name: 'samsara_round',
      description: 'One round under a pre-registered experiment: propose → open → smoke → holdin (→ holdout once the person typed /samsara reveal, or pre-registered --auto-reveal) → judge → decide. Quotes the cost and asks the person; runs as a job.',
      parameters: campaignParameters,
      execute: (args, exec) => startCampaign(exec, 'samsara_round', 'samsara-round', { ...args, rounds: 1 }),
    }),

    tool({
      name: 'samsara_control',
      description: 'One control round judged at holdout: the champion\'s own skill (aa, a known null) or an injected directory (inject, a known effect) — a reading of the gate itself. Quotes the cost and asks the person; runs as a job.',
      parameters: {
        kind: { type: 'string', enum: ['aa', 'inject'], required: true },
        skill_dir: { type: 'string', description: 'inject: the skill directory carrying the known effect; a directory under the pack (the person put it there), never a run\'s output.' },
        pack: { type: 'string' },
        loop: { type: 'string' },
        metric: { type: 'string' },
        experiment_id: { type: 'string', description: 'Charge the round to this experiment.' },
        shadow_gates: { type: 'array', items: { type: 'string' } },
      },
      async execute(args, exec) {
        const kind: ControlKind = args.kind
        if (kind === 'inject' && args.skill_dir === undefined) throw new Error('control inject needs skill_dir, the directory carrying the known effect')
        const agent = exec.agent
        if (!agent) return NO_AGENT
        const experiment = args.experiment_id !== undefined ? deps.ledger.experiment(args.experiment_id) : undefined
        if (args.experiment_id !== undefined && !experiment) throw new Error(`no experiment ${args.experiment_id} on the ledger`)
        const def = packOf(settings, args.pack ?? experiment?.pack)
        // An injected directory is judged on the held-out set: only one the person placed under the pack, never a proposal's output.
        const skillDir = args.skill_dir !== undefined ? resolve(args.skill_dir) : undefined
        if (skillDir !== undefined && !within(def.dir, skillDir)) throw new Error(`control inject runs a directory under the pack ${def.dir}; ${skillDir} is outside it`)
        const loop = loopOf(args.loop)
        const metric = experiment?.prediction.metric ?? metricOf(args.metric)
        const champion = championOf(def, loop, 'holdout')
        const championId = challengerId(champion)
        if (!floorOf(champion, metric)) return refusal('NO_NOISE_FLOOR', `no noise floor for ${def.name}/${loop} on ${metric}; a control is judged at holdout and needs one`, { calibrate: calibrateQuote(def, loop, championId) })
        const attempts = def.taskSets.holdout.tasks.length * settings.repeat
        const usd = usdOf(meanUsd(championId, 'holdout') ?? meanUsd(championId, 'holdin'), attempts)
        const shadow = args.shadow_gates?.length ? ` shadow ${args.shadow_gates.join(',')}` : ''
        const reason = quote(`control ${kind}${skillDir !== undefined ? ` of ${skillDir}` : ''} on ${def.name}/${loop} at holdout x${settings.repeat}${shadow}`, attempts, usd)
        const refused = await ask(exec, agent, 'samsara_control', reason, experiment ? { experiment, usd } : undefined)
        if (refused) return refused
        const out = outDir()
        const runReq = runRequest(def, loop, 'holdout', settings.repeat, out)
        const operator = operatorOf(agent)
        const job_id = startJob(agent, 'samsara-control', reason, experiment?.id, async (signal, log, onRound) => {
          const r = await deps.lifecycle.control({
            kind, pack: def.dir, champion: { proposal: champion, skillDir: skillDirOf(def) }, metric, nEffFloor: settings.nEffFloor, repeat: settings.repeat, out,
            run: campaignRunOf(runReq, { route: deps.route() }), operator,
            ...(skillDir !== undefined ? { skillDir } : {}),
            ...(experiment ? { experimentId: experiment.id } : {}),
            ...(args.shadow_gates !== undefined ? { shadowGates: args.shadow_gates } : {}),
          }, {
            onEvent: (e) => {
              if (e.kind === 'round:opened') onRound(e.roundId)
              log(formatEvent(e))
            },
            signal, hashDir,
          })
          const c = r.compare
          return `control ${r.control}: ${c.verdict.value} (${c.rule_fired}) mean ${c.mean.toFixed(3)} ci [${c.ci[0].toFixed(3)}, ${c.ci[1].toFixed(3)}] n_eff ${c.n_eff}; challenger ${r.challengerId} round ${r.roundId}`
        })
        return { job_id, champion_id: championId, approval: 'allowed-once', quote: reason, out, ...(experiment ? { experiment_id: experiment.id, link: linkOf('experiments', experiment.id) } : {}) }
      },
    }),

    tool({
      name: 'samsara_campaign_stop',
      description: 'Stop a campaign, round, control or calibrate job this session started (job_kill for the samsara jobs). No approval: stopping spends nothing.',
      parameters: { job_id: { type: 'string', required: true } },
      async execute(args, exec) {
        const agent = exec.agent
        if (!agent) return NO_AGENT
        try {
          return { job_id: args.job_id, result: deps.jobs.kill(JobId(args.job_id), agent, 'stopped by the operator') }
        } catch (e) {
          return refusal('NOT_OWNER', `job ${args.job_id} is not one this session owns, or is unknown: ${messageOf(e)}`)
        }
      },
    }),
  ]
}

// ------------------------------------------------------------------ plugin

function selectionOf(ctx: Context, config: Config): { provider: string; model: string; reasoningEffort?: unknown } {
  if (config.provider !== undefined && config.model !== undefined) return { provider: config.provider, model: config.model }
  const selection = ctx.get('agentDefaultModel')?.currentSelection()
  if (!selection) throw new Error('workbench-tools: no attempt route: configure provider and model on the row, or mount agentDefaultModel')
  return selection
}

export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger(name)
  const deps: ToolDeps = {
    lifecycle: ctx.lifecycle,
    ledger: ctx.ledger,
    jobs: ctx.jobs,
    approval: ctx.approval,
    loops: ctx.loops,
    proposers: ctx.proposers,
    route: () => routeOf(selectionOf(ctx, config), config),
    championSkillDir: () => ctx.get('champion')?.current().skill_ref,
    webServer: () => {
      const web = ctx.get('webServer')
      return web ? { host: web.host, port: web.port } : undefined
    },
    warn: (line) => logger.warn(line),
  }
  // The attempt executor ctx.lifecycle runs through is the host plane's
  // (`./executor`): this row mounts per session and would take it along.
  for (const tool of createTools(deps, settingsOf(config))) ctx.effect(() => ctx.tools.register(tool), `workbench-tools: ${tool.name}`)
}
