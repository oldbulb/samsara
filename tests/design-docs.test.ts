// The design documents against the code they describe: the rules gate.md
// lists are the ones gate-default ships and every verdict it names exists;
// every method the architecture's plugin table promises of book, ledger and
// lifecycle is on the object, and every service one of them injects is in
// its row. A rule, a verdict or a method that lives only in a document
// fails here. So does a path under `docs/` a tracked document names that the
// tree does not hold (a development note kept off the repository).
import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createBook } from '../packages/book/src/index.ts'
import { GATE_DEFAULT_VERSION, type Verdict } from '../packages/gate/src/index.ts'
import { Ledger, verdictValueSchema } from '../packages/ledger/src/index.ts'
import { Lifecycle } from '../packages/lifecycle/src/index.ts'

const ROOT = resolve(import.meta.dirname, '..')
const DOCS = join(ROOT, 'docs', 'design')
const doc = (name: string) => readFileSync(join(DOCS, name), 'utf8')

/** Every tracked markdown document: the design docs, the root README, and each package's and pack's README. */
function trackedDocs(): string[] {
  const readmes = (dir: string) => readdirSync(join(ROOT, dir)).map((d) => join(ROOT, dir, d, 'README.md')).filter(existsSync)
  return [
    ...readdirSync(DOCS).filter((f) => f.endsWith('.md')).map((f) => join(DOCS, f)),
    join(ROOT, 'README.md'),
    ...readmes('packages'),
    ...readmes('packs'),
  ]
}
const GATE_VERDICTS: Verdict[] = ['invalid', 'drop', 'hold', 'hold:underpowered', 'promote']

/** The body of a `## heading` section, up to the next one. */
function section(text: string, heading: string): string {
  const start = text.indexOf(`\n## ${heading}`)
  expect(start, `section "${heading}"`).toBeGreaterThanOrEqual(0)
  const rest = text.slice(start + 1)
  const end = rest.indexOf('\n## ', 1)
  return end < 0 ? rest : rest.slice(0, end)
}

/** The cells of the plugin table's row for `name`. */
function pluginRow(text: string, name: string): string[] {
  const line = text.split('\n').find((l) => l.startsWith(`| \`${name}\` |`))
  expect(line, `plugin table row ${name}`).toBeDefined()
  return line!.split('|').map((c) => c.trim())
}

const calls = (cell: string) => [...cell.matchAll(/`([A-Za-z]+)\(/g)].map((m) => m[1]!)
const names = (cell: string) => [...cell.matchAll(/`([A-Za-z]+)`/g)].map((m) => m[1]!)

describe('gate.md against gate-default', () => {
  const text = doc('gate.md')

  it('lists the rules gate-default implements, 0 to 9, and no other', () => {
    const rules = section(text, '`gate-default` rules, in order').split('\n').filter((l) => /^\S+\. \*\*/.test(l)).map((l) => l.slice(0, l.indexOf('.')))
    expect(rules).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'])
  })

  it('names only verdicts the gate or the ledger has, and the shipped version', () => {
    const known = new Set<string>([...GATE_VERDICTS, ...verdictValueSchema.options])
    for (const [, token] of text.matchAll(/hold:([a-z_]+)/g)) expect(known, `hold:${token}`).toContain(`hold:${token}`)
    for (const [, version] of text.matchAll(/gate-default@(\d+\.\d+\.\d+)/g)) expect(version).toBe(GATE_DEFAULT_VERSION)
  })
})

describe('architecture.md plugin table against the code', () => {
  const text = doc('architecture.md')

  it('book: every method promised is on a Book, and the row claims no ledger table', () => {
    const [, , provides, , notes] = pluginRow(text, 'book') as [string, string, string, string, string]
    const book = createBook({ sets: { smoke: [], holdin: [], holdout: [] }, entityKey: 'entity_key', holdoutPolicy: { mde: 0.05, budget: 0 } })
    for (const name of calls(provides)) expect(name === 'createBook' || typeof (book as unknown as Record<string, unknown>)[name] === 'function', name).toBe(true)
    expect(notes).not.toMatch(/owns the `/)
  })

  it('ledger: every method promised is on the Ledger, and what it injects is in its row', () => {
    const [, , provides, injects] = pluginRow(text, 'ledger') as [string, string, string, string]
    for (const name of calls(provides)) expect(typeof (Ledger.prototype as unknown as Record<string, unknown>)[name], name).toBe('function')
    for (const name of Ledger.inject) expect(names(injects)).toContain(name)
  })

  it('lifecycle: every method promised is on the Lifecycle, and what it injects is in its row', () => {
    const [, , provides, injects] = pluginRow(text, 'lifecycle') as [string, string, string, string]
    for (const name of calls(provides)) expect(typeof (Lifecycle.prototype as unknown as Record<string, unknown>)[name], name).toBe('function')
    for (const name of Lifecycle.inject) expect(names(injects)).toContain(name)
  })
})

describe('tracked documents against the tree', () => {
  it('every docs/ path a document names exists: no link into a development record kept off the repository', () => {
    const missing: string[] = []
    for (const file of trackedDocs()) {
      const text = readFileSync(file, 'utf8')
      for (const [, path] of text.matchAll(/[`(]((?:\.\.\/)*docs\/[A-Za-z0-9_./-]+?)[`)]/g)) {
        const target = path.replace(/\/$/, '')
        if (!existsSync(resolve(ROOT, target)) && !existsSync(resolve(dirname(file), target))) missing.push(`${file.slice(ROOT.length + 1)}: ${path}`)
      }
    }
    expect(missing).toEqual([])
  })
})
