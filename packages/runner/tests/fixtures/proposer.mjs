#!/usr/bin/env node
// Test proposer under the command contract (`--view <dir> --out <dir>`), with a
// `--mode` picking what it proposes. `ok` returns the champion skill unchanged;
// `literal` writes a task id into the skill (the diff scan must reject it);
// `holdout` names a held-out task id in its prediction; `rows` proposes on a
// surface that is not skill. It also records the view manifest it was shown.
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const opt = (name) => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1] }
const view = opt('--view')
const out = opt('--out')
const mode = opt('--mode') ?? 'ok'
if (!view || !out) { console.error('usage: proposer.mjs --view <dir> --out <dir> [--mode ok|literal|holdout|rows]'); process.exit(2) }

mkdirSync(out, { recursive: true })
const champion = JSON.parse(readFileSync(join(view, 'champion.json'), 'utf8'))
const manifest = JSON.parse(readFileSync(join(view, 'view.json'), 'utf8'))
const tasks = readFileSync(join(view, 'tasks.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
writeFileSync(join(out, 'seen.json'), JSON.stringify({ manifest, tasks, environment: existsSync(join(view, 'environment.md')) ? readFileSync(join(view, 'environment.md'), 'utf8') : null }))

const prediction = { metric: champion.metric, direction: 'up', predicted_fixes: mode === 'holdout' ? ['o1'] : tasks.map((t) => t.task_id) }
if (mode === 'rows') {
  writeFileSync(join(out, 'proposal.json'), JSON.stringify({ surface: 'prompt', patch: { surface: 'prompt', rows: [{ id: 'r1', config: {} }] }, intent: 'rows', prediction }))
} else {
  cpSync(join(view, champion.skill), join(out, 'skill'), { recursive: true })
  if (mode === 'literal') writeFileSync(join(out, 'skill', 'SKILL.md'), `# mini\nhint for ${tasks[0]?.task_id ?? 'none'}\n`)
  writeFileSync(join(out, 'proposal.json'), JSON.stringify({
    surface: 'skill', patch: { surface: 'skill', skill_dir: 'skill' }, intent: `${mode} proposal`, prediction: { ...prediction, magnitude: 0.1 },
  }))
}
console.error(`proposer: mode=${mode}`)
