#!/usr/bin/env node
// stdin {task_id, workdir} -> stdout {task_id, ok, files[]}: the task's
// instruction.md, as Harbor hands it to the agent (leading canary lines
// stripped: harbor/models/task/task.py strip_canary). Unlike Harbor, which
// passes the instruction as a string and writes nothing into the image's
// working directory, it lands in the working tree — next to the framework's
// .task/, .tmp/ and skills dirs — so a test that inspects the tree itself can
// diverge from Harbor's verdict (see the pack README).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PACK, emit, loadTasks, readLines, taskOf } from './lib.mjs'

const CANARY = /^(<!--.*canary.*-->|#.*canary.*)$/i

function stripCanary(text) {
  const lines = text.split('\n')
  let i = 0
  while (i < lines.length && CANARY.test(lines[i].trim())) i++
  while (i < lines.length && lines[i].trim() === '') i++
  return lines.slice(i).join('\n')
}

const tasks = loadTasks()

for (const { task_id, workdir } of readLines()) {
  const task = taskOf(tasks, task_id)
  mkdirSync(workdir, { recursive: true })
  writeFileSync(resolve(workdir, 'instruction.md'), stripCanary(readFileSync(resolve(PACK, task.dir, 'instruction.md'), 'utf8')))
  emit({ task_id, ok: true, files: ['instruction.md'] })
}
