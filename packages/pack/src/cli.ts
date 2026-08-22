#!/usr/bin/env node
// samsara-pack validate <dir>: load a pack.yaml, check its contract, task
// sets and commands, print a summary. Exit 1 with the first PackError.
import { loadPack, PackError } from './index.ts'

function usage(): never {
  process.stderr.write('usage: samsara-pack validate <pack-dir>\n')
  process.exit(2)
}

const [sub, dir] = process.argv.slice(2)
if (sub !== 'validate' || !dir) usage()

try {
  const def = loadPack(dir)
  const sets = (['smoke', 'holdin', 'holdout'] as const).map((t) => `${t}=${def.taskSets[t].tasks.length}`).join(' ')
  process.stdout.write(
    [
      `pack ${def.name} (${def.truthLatency}) at ${def.dir}`,
      `tasks ${sets} on entity_key=${def.manifest.tasks.entity_key}`,
      `commands ${Object.keys(def.commands).join(', ')}`,
      `surfaces ${Object.keys(def.surfaces).join(', ') || '(none)'}`,
      'ok',
    ].join('\n') + '\n',
  )
} catch (e) {
  if (e instanceof PackError) {
    process.stderr.write(`invalid pack [${e.code}]: ${e.message}\n`)
    process.exit(1)
  }
  throw e
}
