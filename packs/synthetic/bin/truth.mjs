#!/usr/bin/env node
// stdin {task_id, workdir} -> stdout {task_id, status:"settled", truth:{passed}, truth_sha}.
//
// A biased coin: p = clamp(base_rate + effect, 0, 1), base_rate from the task
// row, effect from the skill snapshot the attempt ran with. The draw is paired
// across skills by construction: u = hash(task_id, sample) is shared by every
// attempt of the same task and sample index, the jitter is private to the
// attempt; the sum is reflected back into [0, 1], which keeps it uniform, so
// the pass probability is exactly p. passed = 1 iff that draw < p.
//
// The token names the attempt the runner sealed the workdir for; a token that
// names another attempt (a rewrite, to re-roll the jitter) is refused. The
// skill snapshot is the framework's to keep intact: a loop that changes it
// finishes FAILED and the attempt never reaches the gate.
//
// Two token fields carry what the pairing needs (docs/design/packs.md, "The
// attempt token"): `sample`, the replicate index, and `skill_path`, where the
// skill snapshot sits. Either one missing is an error, never a default: a
// silent sample 0 would make every replicate share the same coin.
import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { NOISE, emit, loadTasks, readLines, truthSha, unit } from './lib.mjs'

const tasks = loadTasks()
const sha = truthSha()

function readToken(workdir, task_id) {
  const token = JSON.parse(readFileSync(resolve(workdir, '.task', 'token.json'), 'utf8'))
  if (token.attemptId !== basename(workdir)) throw new Error(`${task_id}: token names attempt ${token.attemptId}, workdir is ${basename(workdir)}`)
  if (!Number.isInteger(token.sample) || token.sample < 0) throw new Error(`${task_id}: token has no sample index (got ${JSON.stringify(token.sample)}); the pairing needs the attempt's replicate index`)
  if (typeof token.skill_path !== 'string' || token.skill_path === '') throw new Error(`${task_id}: token has no skill_path; effect is read from the skill snapshot`)
  return token
}

function readParams(workdir, skill_path, task_id) {
  const path = resolve(workdir, skill_path, 'params.json')
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    throw new Error(`${task_id}: skill snapshot not readable at ${skill_path}/params.json (${e.message})`)
  }
}

for (const { task_id, workdir } of readLines()) {
  const task = tasks.get(task_id)
  if (!task) throw new Error(`unknown task ${task_id}`)
  const token = readToken(workdir, task_id)
  const params = readParams(workdir, token.skill_path, task_id)
  const effect = Number(params.effect)
  if (!Number.isFinite(effect)) throw new Error(`${task_id}: params.json effect is not a number`)
  const p = Math.min(1, Math.max(0, task.base_rate + effect))
  const u = unit(`draw\0${task_id}\0${token.sample}`)
  const v = u + (2 * unit(`jitter\0${token.attemptId}`) - 1) * NOISE
  const draw = v < 0 ? -v : v > 1 ? 2 - v : v
  emit({ task_id, status: 'settled', truth: { passed: draw < p ? 1 : 0 }, truth_sha: sha })
}
