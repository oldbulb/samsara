#!/usr/bin/env node
// A proposer for the pack's campaigns under the command contract
// (examples/proposers/README.md): `--effect <x> --view <dir> --out <dir>`
// copies the champion skill from the view into <out>/skill with `effect` set
// to x in params.json and writes proposal.json. The effect is the only thing
// that matters to truth; a line stamped into SKILL.md makes every call a new
// skill snapshot, so a campaign's rounds land on distinct challenger rows
// (the same snapshot twice would be the same row).
import { appendFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const args = new Map()
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1])
const view = args.get('--view')
const out = args.get('--out')
const effect = Number(args.get('--effect') ?? '0')
if (!view || !out || !Number.isFinite(effect)) {
  process.stderr.write('usage: propose-effect.mjs --effect <x> --view <dir> --out <dir>\n')
  process.exit(2)
}

const manifest = JSON.parse(readFileSync(resolve(view, 'view.json'), 'utf8'))
const champion = JSON.parse(readFileSync(resolve(view, 'champion.json'), 'utf8'))
const skill = resolve(out, 'skill')
mkdirSync(out, { recursive: true })
cpSync(resolve(view, champion.skill), skill, { recursive: true })
writeFileSync(resolve(skill, 'params.json'), JSON.stringify({ effect }) + '\n')
appendFileSync(resolve(skill, 'SKILL.md'), `\n<!-- effect ${effect}, proposed ${new Date().toISOString()} -->\n`)
writeFileSync(resolve(out, 'proposal.json'), JSON.stringify({
  surface: 'skill',
  patch: { surface: 'skill', skill_dir: 'skill' },
  intent: `the pack skill with effect ${effect}`,
  prediction: { metric: manifest.metric, direction: 'up', magnitude: Math.abs(effect) },
}, null, 2) + '\n')
process.stderr.write(`propose-effect: champion ${manifest.champion_id}, effect ${effect}\n`)
