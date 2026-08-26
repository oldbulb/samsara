// Renders the home, experiment, round and challenger pages over the fixture
// ledger (tests/fixtures.ts) to self-contained HTML files, light and dark, so
// the README screenshots come from the same synthetic campaign the tests
// exercise. Imports the built lib: run `pnpm --filter @oldbulb/samsara-ui build`
// first. Node strips the fixture's types itself (>= 22.18).
//
//   node packages/ui/tools/render-fixtures.mjs [out-dir]
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as challenger from '../lib/pages/challenger.js'
import * as experiment from '../lib/pages/experiment.js'
import * as home from '../lib/pages/home.js'
import * as round from '../lib/pages/round.js'
import { CHAL, EXP, ROUND2, fakeDeps } from '../tests/fixtures.ts'

const out = process.argv[2] ?? join(tmpdir(), 'samsara-ui-fixtures')
// refreshMs 0: no refresh script, so a file:// render never reports a failed fetch.
const deps = { ...fakeDeps(), base: '/samsara', refreshMs: 0 }
const params = (id) => ({ id, query: new URLSearchParams() })

const pages = {
  home: home.render(home.load(deps, params())),
  experiment: experiment.render(experiment.load(deps, params(EXP))),
  round: round.render(round.load(deps, params(ROUND2))),
  challenger: challenger.render(challenger.load(deps, params(CHAL))),
}

/** The dark variant: the attribute the tokens key on, and the bootstrap pinned so it does not clear it. */
const dark = (html) => html.replace('<body>', '<body data-ds-dark-theme>').replace("const p='system'", "const p='dark'")

await mkdir(out, { recursive: true })
for (const [name, html] of Object.entries(pages)) {
  await writeFile(join(out, `${name}-light.html`), html)
  await writeFile(join(out, `${name}-dark.html`), dark(html))
}
console.log(out)
