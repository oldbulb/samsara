// @samsara/book — the truth fixed point, as a plain in-memory implementation.
//
// No dsh / cordis imports here: `Book` is a plain interface so a later cordis
// Service can wrap it and back it with storageDomain. Everything the loop is
// allowed to see goes through `visibility`; nothing in the loop writes here.

import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'

export type TaskSet = 'smoke' | 'holdin' | 'holdout'
export const TASK_SETS: readonly TaskSet[] = ['smoke', 'holdin', 'holdout']

export interface Task {
  task_id: string
  entity_key: string
  stratum?: string
  [extra: string]: unknown
}

/** Mirrors packages/pack/schema/truth-output.schema.json (one `truth` stdout line). */
export interface TruthRecord {
  task_id: string
  status: 'settled' | 'pending'
  truth?: unknown
  truth_sha: string
  as_of?: string
}

export type SettlementKind = 'truth' | 'scorer' | 'model' | 'taskset'

export interface Settlement {
  id: string
  kind: SettlementKind
  taskset_sha: string
  as_of: string
  truth_snapshot_id: string
  n_settled: number
  n_pending: number
  task_ids: string[]
}

export type Viewer = 'proposer' | 'gate' | 'human'
export type Visibility = 'individual' | 'aggregate' | 'hidden'

export interface HoldoutPolicy {
  mde: number
  budget: number
}

export interface HoldoutBudget {
  remaining: number
  spent: number
}

export interface BookEvents {
  'book/settled': [settlement: Settlement]
}

export interface BookOptions {
  sets: Record<TaskSet, Task[]>
  entityKey: string
  holdoutPolicy: HoldoutPolicy
}

export interface Book {
  tasks(set: TaskSet): readonly Task[]
  tasksetSha(set: TaskSet): string
  assertDisjointHoldout(): void
  settle(records: TruthRecord[], asOf: string, kind?: SettlementKind): Settlement
  pendingTasks(): readonly Task[]
  settlements(): readonly Settlement[]
  visibility(taskId: string, viewer: Viewer): Visibility
  holdoutBudget(): HoldoutBudget
  debitHoldout(reason: string): HoldoutBudget
  on<K extends keyof BookEvents>(event: K, listener: (...args: BookEvents[K]) => void): () => void
}

const SHA_RE = /^[0-9a-f]{64}$/

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

/** sha256 over the sorted task ids of a set: the identity of a task set. */
export function computeTasksetSha(tasks: readonly Task[]): string {
  return sha256([...tasks].map((t) => t.task_id).sort().join('\n'))
}

/** sha256 over sorted (task_id, truth_sha) pairs of settled records: the identity of a truth snapshot. */
export function computeTruthSnapshotId(records: readonly TruthRecord[]): string {
  const lines = records
    .filter((r) => r.status === 'settled')
    .map((r) => `${r.task_id}\t${r.truth_sha}`)
    .sort()
  return sha256(lines.join('\n'))
}

export class HoldoutBudgetExhausted extends Error {
  constructor(readonly budget: number, readonly reason: string) {
    super(`holdout budget exhausted (${budget} revelations spent); refused: ${reason}`)
    this.name = 'HoldoutBudgetExhausted'
  }
}

export class HoldoutNotDisjoint extends Error {
  constructor(readonly entityKey: string, readonly offending: string[]) {
    super(`holdout is not disjoint on ${entityKey}; shared entities: ${offending.join(', ')}`)
    this.name = 'HoldoutNotDisjoint'
  }
}

class InMemoryBook implements Book {
  private readonly sets: Record<TaskSet, Task[]>
  private readonly byId = new Map<string, { task: Task; set: TaskSet }>()
  private readonly shas: Record<TaskSet, string>
  private readonly entityKey: string
  private readonly policy: HoldoutPolicy
  private readonly emitter = new EventEmitter()
  private readonly history: Settlement[] = []
  private readonly settledSha = new Map<string, string>()
  private spent = 0
  private readonly debits: { reason: string; at: number }[] = []

  constructor(opts: BookOptions) {
    this.entityKey = opts.entityKey
    this.policy = opts.holdoutPolicy
    if (!(this.policy.budget >= 0)) throw new Error('holdoutPolicy.budget must be >= 0')
    if (!(this.policy.mde > 0)) throw new Error('holdoutPolicy.mde must be > 0')
    this.sets = { smoke: [], holdin: [], holdout: [] }
    for (const set of TASK_SETS) {
      for (const task of opts.sets[set] ?? []) {
        if (this.byId.has(task.task_id)) {
          throw new Error(`duplicate task_id ${task.task_id} (${this.byId.get(task.task_id)!.set} and ${set})`)
        }
        this.byId.set(task.task_id, { task, set })
        this.sets[set].push(task)
      }
    }
    this.shas = {
      smoke: computeTasksetSha(this.sets.smoke),
      holdin: computeTasksetSha(this.sets.holdin),
      holdout: computeTasksetSha(this.sets.holdout),
    }
  }

  tasks(set: TaskSet): readonly Task[] {
    return this.sets[set]
  }

  tasksetSha(set: TaskSet): string {
    return this.shas[set]
  }

  assertDisjointHoldout(): void {
    const visible = new Set<string>()
    for (const t of this.sets.smoke) visible.add(this.entityOf(t))
    for (const t of this.sets.holdin) visible.add(this.entityOf(t))
    const offending = new Set<string>()
    for (const t of this.sets.holdout) {
      const e = this.entityOf(t)
      if (visible.has(e)) offending.add(e)
    }
    if (offending.size) throw new HoldoutNotDisjoint(this.entityKey, [...offending].sort())
  }

  settle(records: TruthRecord[], asOf: string, kind: SettlementKind = 'truth'): Settlement {
    const ids: string[] = []
    let nSettled = 0
    let nPending = 0
    for (const r of records) {
      if (!this.byId.has(r.task_id)) throw new Error(`unknown task_id ${r.task_id}`)
      if (!SHA_RE.test(r.truth_sha)) throw new Error(`invalid truth_sha for ${r.task_id}`)
      ids.push(r.task_id)
      if (r.status === 'settled') {
        nSettled++
        this.settledSha.set(r.task_id, r.truth_sha)
      } else {
        nPending++
      }
    }
    const task_ids = [...new Set(ids)].sort()
    const truth_snapshot_id = computeTruthSnapshotId(records)
    const taskset_sha = sha256(task_ids.join('\n'))
    const settlement: Settlement = {
      id: sha256([kind, taskset_sha, asOf, truth_snapshot_id].join('\n')),
      kind,
      taskset_sha,
      as_of: asOf,
      truth_snapshot_id,
      n_settled: nSettled,
      n_pending: nPending,
      task_ids,
    }
    this.history.push(settlement)
    this.emitter.emit('book/settled', settlement)
    return settlement
  }

  pendingTasks(): readonly Task[] {
    const out: Task[] = []
    for (const { task } of this.byId.values()) {
      if (!this.settledSha.has(task.task_id)) out.push(task)
    }
    return out
  }

  settlements(): readonly Settlement[] {
    return this.history
  }

  visibility(taskId: string, viewer: Viewer): Visibility {
    const entry = this.byId.get(taskId)
    if (!entry) return 'hidden'
    if (viewer === 'proposer') {
      if (entry.set === 'holdout') return 'aggregate'
      return 'individual'
    }
    return 'individual'
  }

  holdoutBudget(): HoldoutBudget {
    return { remaining: this.policy.budget - this.spent, spent: this.spent }
  }

  debitHoldout(reason: string): HoldoutBudget {
    if (this.spent >= this.policy.budget) throw new HoldoutBudgetExhausted(this.policy.budget, reason)
    this.spent++
    this.debits.push({ reason, at: Date.now() })
    return this.holdoutBudget()
  }

  on<K extends keyof BookEvents>(event: K, listener: (...args: BookEvents[K]) => void): () => void {
    this.emitter.on(event, listener as (...args: unknown[]) => void)
    return () => this.emitter.off(event, listener as (...args: unknown[]) => void)
  }

  private entityOf(task: Task): string {
    const v = task[this.entityKey]
    if (typeof v !== 'string' || !v) throw new Error(`task ${task.task_id} lacks entity key ${this.entityKey}`)
    return v
  }
}

export function createBook(opts: BookOptions): Book {
  return new InMemoryBook(opts)
}
