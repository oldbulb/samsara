#!/usr/bin/env node
// stdin {task_id, workdir} -> stdout {task_id, ok, files[]}: one task.json naming the task.
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { emit, readLines } from './lib.mjs'

for (const { task_id, workdir } of readLines()) {
  mkdirSync(workdir, { recursive: true })
  writeFileSync(resolve(workdir, 'task.json'), JSON.stringify({ task_id }) + '\n')
  emit({ task_id, ok: true, files: ['task.json'] })
}
