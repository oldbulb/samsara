// Shared helpers for the synthetic pack commands. Not a framework import.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const PACK = resolve(import.meta.dirname, '..')
export const SKILL_NAME = 'answer'
export const SETS = ['smoke', 'holdin', 'holdout']
// Half-width of the per-attempt jitter truth adds to the common random number:
// an A/A rerun then disagrees on a task with probability 2*NOISE/3, so the
// paired delta has sd sqrt(2*NOISE/3) ~ 0.26 (README "Noise").
export const NOISE = 0.1

export function readLines() {
  return readFileSync(0, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
}

export function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

/** Deterministic uniform in [0, 1) from a string: the top 52 bits of its sha256. */
export function unit(key) {
  const hex = sha256(key).slice(0, 13)
  return parseInt(hex, 16) / 2 ** 52
}

export function taskFile(set) {
  return resolve(PACK, 'tasks', `${set}.jsonl`)
}

/** Every task row of every set, by task_id. */
export function loadTasks() {
  const out = new Map()
  for (const set of SETS) {
    for (const raw of readFileSync(taskFile(set), 'utf8').split('\n')) {
      if (!raw.trim()) continue
      const row = JSON.parse(raw)
      out.set(row.task_id, row)
    }
  }
  return out
}

/** sha256 over the three task files and the truth code (this file and truth.mjs): the coin's definition is part of the snapshot, so tuning NOISE or the draw scheme is a new truth. */
export function truthSha() {
  const h = createHash('sha256')
  for (const set of SETS) h.update(set).update('\0').update(readFileSync(taskFile(set))).update('\0')
  for (const file of ['lib.mjs', 'truth.mjs']) h.update(file).update('\0').update(readFileSync(resolve(import.meta.dirname, file))).update('\0')
  return h.digest('hex')
}
