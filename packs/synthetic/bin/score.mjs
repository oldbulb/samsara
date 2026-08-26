#!/usr/bin/env node
// stdin {task_id, truth, output} -> stdout jsonl pass_rate (reality) / cost_usd (mechanical).
import { emit, loadTasks, readLines } from './lib.mjs'

const tasks = loadTasks()

for (const { task_id, truth, output } of readLines()) {
  const stratum = tasks.get(task_id)?.stratum
  const usage = output?.usage ?? {}
  emit({ task_id, metric: 'pass_rate', value: truth?.passed ? 1 : 0, kind: 'reality', stratum })
  emit({ task_id, metric: 'cost_usd', value: Number(usage.cost_usd) || 0, kind: 'mechanical', stratum })
}
