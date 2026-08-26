// The attempt executor: the one thing `lifecycle.run` and `lifecycle.calibrate`
// delegate. The runner's `runSet` implements it and mounts it as
// `ctx.executor`; the shapes below are the structural subset of the runner's
// RunRequest / RunDeps / RunResult the service needs, copied here so this
// package never imports the runner (runner → lifecycle would be a cycle).

import type { TaskSet } from '@oldbulb/samsara-book'
import type { AttemptStatus, Ledger } from '@oldbulb/samsara-ledger'
import type { AttemptSpec, LoopProvider, LoopRun } from '@oldbulb/samsara-loops'

export interface RouteConfig {
  provider: string
  model: string
  baseUrl?: string
  baseUrlKind?: 'direct' | 'proxy'
  credentialRef: string
  reasoning?: Record<string, unknown>
}

export interface RunRequest {
  /** The pack directory. */
  pack: string
  loop: string
  set: TaskSet
  limit?: number
  stratum?: string[]
  repeat: number
  out: string
  maxTurns: number
  maxMinutes: number
  allow?: string[]
  /** Skill directory to run instead of the pack's (a challenger's snapshot). */
  skillDir?: string
  parallel?: number
}

export interface RunDeps {
  loops: {
    get(name: string): LoopProvider | undefined
    start(name: string, spec: AttemptSpec): Promise<LoopRun>
  }
  route: RouteConfig
  /** Every attempt and its scores are recorded under `challengerId`. */
  ledger?: Pick<Ledger, 'propose' | 'recordAttempt' | 'appendScores'>
  challengerId?: string
  /** The champion's kept skill snapshot; runs instead of the pack's when `req.skillDir` is unset. */
  championSkillDir?: string
  signal?: AbortSignal
  runId?: string
  log?: (line: string) => void
}

export interface RunResultRow {
  attemptId: string
  task_id: string
  loop: string
  facts_sha: string
  status: AttemptStatus
  cost: { usd?: number }
  scores: { task_id: string; metric: string; value: number; kind: 'mechanical' | 'reality' | 'judge'; stratum?: string }[]
}

export interface RunResult {
  runId: string
  pack: string
  set: TaskSet
  tasksetSha: string
  challengerId?: string
  rows: RunResultRow[]
  attemptsPath: string
}

/** What runs attempts: tasks × repeat under one challenger row, every row recorded on the ledger. */
export interface Executor {
  runSet(req: RunRequest, deps: RunDeps): Promise<RunResult>
}
