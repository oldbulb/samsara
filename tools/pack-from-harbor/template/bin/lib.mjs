// Shared helpers for the commands that run on the host (materialize, score) of
// a pack generated from a Harbor dataset; the ones that run inside the
// environment share lib.sh instead. Not a framework import.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const PACK = resolve(import.meta.dirname, '..')
export const SETS = ['smoke', 'holdin', 'holdout']

export function readLines() {
  return readFileSync(0, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
}

export function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

/** Every task row of every set, by task_id. */
export function loadTasks() {
  const out = new Map()
  for (const set of SETS) {
    for (const raw of readFileSync(resolve(PACK, 'tasks', `${set}.jsonl`), 'utf8').split('\n')) {
      if (!raw.trim()) continue
      const row = JSON.parse(raw)
      out.set(row.task_id, row)
    }
  }
  return out
}

export function taskOf(tasks, task_id) {
  const task = tasks.get(task_id)
  if (!task) throw new Error(`unknown task ${task_id}`)
  return task
}
