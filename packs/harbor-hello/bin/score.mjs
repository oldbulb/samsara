#!/usr/bin/env node
// stdin {task_id, truth, output} -> stdout jsonl: `reward` (reality) from
// reward.txt or the `reward` key of reward.json, plus one reality metric per
// other key of reward.json, each with the task's stratum. A reward that is
// not a number (truth passes reward.json through as written) is an error.
import { emit, loadTasks, readLines, taskOf } from './lib.mjs'

const tasks = loadTasks()

for (const { task_id, truth } of readLines()) {
  const stratum = taskOf(tasks, task_id).stratum
  const rewards = truth?.rewards ?? (typeof truth?.reward === 'number' ? { reward: truth.reward } : {})
  for (const [metric, value] of Object.entries(rewards)) {
    if (typeof value !== 'number') throw new Error(`${task_id}: reward ${metric} is not a number`)
    emit({ task_id, metric, value, kind: 'reality', stratum })
  }
}
