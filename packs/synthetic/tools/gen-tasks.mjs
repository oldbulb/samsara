#!/usr/bin/env node
// Regenerates tasks/{smoke,holdin,holdout}.jsonl. Families are the entities
// (two tasks each, so the gate's entity clustering has something to cluster);
// holdout families never appear in smoke or holdin. Every task carries the
// pack-private base_rate truth draws against, in [0.3, 0.7] from a hash of its
// id, so the split and the rates are reproducible without a random source.
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { unit } from '../bin/lib.mjs'

const TASKS = resolve(import.meta.dirname, '..', 'tasks')
const STRATA = ['s1', 's2', 's3']
const TASKS_PER_FAMILY = 2
const SETS = { smoke: [1, 4], holdin: [5, 28], holdout: [29, 76] }

for (const [set, [from, to]] of Object.entries(SETS)) {
  const lines = []
  for (let f = from; f <= to; f++) {
    const entity = `f${String(f).padStart(2, '0')}`
    const stratum = STRATA[(f - 1) % STRATA.length]
    for (let t = 1; t <= TASKS_PER_FAMILY; t++) {
      const task_id = `${entity}/t${t}`
      const base_rate = Number((0.3 + 0.4 * unit(`base_rate\0${task_id}`)).toFixed(3))
      lines.push(JSON.stringify({ task_id, entity_key: entity, stratum, base_rate }))
    }
  }
  writeFileSync(resolve(TASKS, `${set}.jsonl`), lines.join('\n') + '\n')
}
