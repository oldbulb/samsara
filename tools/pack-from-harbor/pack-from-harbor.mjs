#!/usr/bin/env node
// usage: pack-from-harbor.mjs <harbor task or dataset dir> <pack dir> [--name <pack name>] [--holdout-fraction <0..1>] [--smoke <n>] [--force]
import { DEFAULT_HOLDOUT_FRACTION, DEFAULT_SMOKE, generatePack } from './generate.mjs'

const args = process.argv.slice(2)
const positional = []
const opts = { holdoutFraction: DEFAULT_HOLDOUT_FRACTION, smoke: DEFAULT_SMOKE, force: false }
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--name') opts.name = args[++i]
  else if (a === '--holdout-fraction') opts.holdoutFraction = Number(args[++i])
  else if (a === '--smoke') opts.smoke = Number(args[++i])
  else if (a === '--force') opts.force = true
  else if (a.startsWith('--')) { console.error(`unknown option ${a}`); process.exit(2) }
  else positional.push(a)
}
if (positional.length !== 2 || !(opts.holdoutFraction >= 0 && opts.holdoutFraction <= 1) || !Number.isInteger(opts.smoke) || opts.smoke < 0) {
  console.error('usage: pack-from-harbor.mjs <harbor task or dataset dir> <pack dir> [--name <pack name>] [--holdout-fraction <0..1>] [--smoke <n>] [--force]')
  process.exit(2)
}
const [from, out] = positional
const sets = generatePack({ from, out, ...opts })
console.error(`${out}: ${sets.smoke.length} smoke / ${sets.holdin.length} holdin / ${sets.holdout.length} holdout`)
