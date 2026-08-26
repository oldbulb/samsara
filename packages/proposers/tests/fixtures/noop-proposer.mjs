#!/usr/bin/env node
// Test proposer under the command contract: `--view <dir> --out <dir>` plus a
// `--mode` picking the behaviour under test. `ok` copies the champion skill
// unchanged and writes a conforming proposal.json; the other modes misbehave.
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const opt = (name) => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1] }
const view = opt('--view')
const out = opt('--out')
const mode = opt('--mode') ?? 'ok'
if (!view || !out) { console.error('usage: noop-proposer.mjs --view <dir> --out <dir> [--mode ok|fail|malformed|hang|rows|env]'); process.exit(2) }
console.error(`noop-proposer: mode=${mode}`)

mkdirSync(out, { recursive: true })
if (mode === 'fail') process.exit(3)
if (mode === 'hang') { setInterval(() => {}, 1000); }
else {
  const champion = JSON.parse(readFileSync(join(view, 'champion.json'), 'utf8'))
  if (mode === 'env') {
    writeFileSync(join(out, 'env.json'), JSON.stringify(process.env))
  }
  if (mode === 'malformed') {
    writeFileSync(join(out, 'proposal.json'), JSON.stringify({ surface: 'skill', patch: { surface: 'skill', skill_dir: 'skill' }, intent: 'x' }))
  } else if (mode === 'rows') {
    writeFileSync(join(out, 'proposal.json'), JSON.stringify({
      surface: 'prompt', patch: { surface: 'prompt', rows: [{ id: 'r1', config: {} }] }, intent: 'rows', prediction: { metric: champion.metric, direction: 'up' },
    }))
  } else {
    cpSync(join(view, champion.skill), join(out, 'skill'), { recursive: true })
    writeFileSync(join(out, 'proposal.json'), JSON.stringify({
      surface: 'skill',
      patch: { surface: 'skill', skill_dir: 'skill' },
      intent: 'no-op conformance proposal',
      prediction: { metric: champion.metric, direction: 'up', predicted_fixes: [], at_risk: [] },
    }))
  }
  process.stdout.write('done\n')
}
