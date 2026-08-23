// Durable steps (pod-and-adoptions item 1): every attempt pipeline step writes
// `<attemptDir>/.steps/<step>.json` when it completes, and `<runDir>/run.json`
// pins the run so `--resume <runDir>` can re-enter runSet for the same run id
// and skip what already completed. Plain files, no workflow engine: a marker is
// written atomically (tmp + rename) and a torn or unparsable marker reads as
// missing, so the step simply runs again.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { FinishedEvent } from '@samsara/loops'
import type { AttemptRow, RunRequest, ScoreLine, SubmitRead } from './run.ts'

export const STEPS = ['materialize', 'loop', 'submit', 'truth', 'score', 'record'] as const
export type Step = (typeof STEPS)[number]
export const STEPS_DIR = '.steps'
export const RUN_RECORD = 'run.json'

export interface StepMarker {
  step: Step
  attemptId: string
  /** ISO time the step completed. */
  at: string
}

/** What each step keeps beside the marker: the minimum the later steps need to run without it. */
export interface StepData {
  /** `tmpdir` is relative to the attempt dir so a moved run directory still resumes. */
  materialize: { tmpdir: string; skillSha: string }
  loop: { finished: FinishedEvent; error?: string }
  submit: SubmitRead
  truth: { truth: AttemptRow['truth']; value?: unknown }
  score: { scores: ScoreLine[] }
  record: { ledger: boolean }
}

export function stepsDir(attemptDir: string): string {
  return resolve(attemptDir, STEPS_DIR)
}

export function stepPath(attemptDir: string, step: Step): string {
  return resolve(stepsDir(attemptDir), `${step}.json`)
}

/** The marker for `step`, or undefined when it is missing or unreadable (then the step runs again). */
export function readStep<S extends Step>(attemptDir: string, step: S): (StepMarker & StepData[S]) | undefined {
  const file = stepPath(attemptDir, step)
  if (!existsSync(file)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as StepMarker & StepData[S]
    return parsed.step === step ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Write the marker atomically: a crash mid-write leaves no half marker behind. */
export function writeStep<S extends Step>(attemptDir: string, attemptId: string, step: S, data: StepData[S]): void {
  const dir = stepsDir(attemptDir)
  mkdirSync(dir, { recursive: true })
  const file = stepPath(attemptDir, step)
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify({ step, attemptId, at: new Date().toISOString(), ...data }) + '\n')
  renameSync(tmp, file)
}

export function completedSteps(attemptDir: string): Step[] {
  return STEPS.filter((s) => existsSync(stepPath(attemptDir, s)))
}

/** True when every step marker is present: the attempt needs nothing on resume. */
export function isComplete(attemptDir: string): boolean {
  return completedSteps(attemptDir).length === STEPS.length
}

/** `<runDir>/run.json`: everything runSet needs to re-enter the same run. */
export interface RunRecord {
  runId: string
  at: string
  request: Omit<RunRequest, 'out' | 'resume'>
  /** Task ids in set order after `limit`; a resume refuses a book that no longer agrees. */
  tasks: string[]
}

export function runRecordPath(runDir: string): string {
  return resolve(runDir, RUN_RECORD)
}

export function writeRunRecord(runDir: string, record: RunRecord): void {
  mkdirSync(runDir, { recursive: true })
  const file = runRecordPath(runDir)
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n')
  renameSync(tmp, file)
}

export function readRunRecord(runDir: string): RunRecord {
  const file = runRecordPath(runDir)
  if (!existsSync(file)) throw new Error(`no ${RUN_RECORD} in ${runDir}: not a run directory written by runSet`)
  const rec = JSON.parse(readFileSync(file, 'utf8')) as RunRecord
  if (typeof rec.runId !== 'string' || !rec.request || !Array.isArray(rec.tasks)) throw new Error(`${file} is not a run record`)
  return rec
}
