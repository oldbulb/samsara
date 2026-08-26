// A pack's fixtures are source: a hidden spec that reads `data/<file>` next to
// itself gets the wrong truth on a clean checkout if .gitignore swallows the
// directory (the unanchored `data/` rule once did, for javascript/grep). Only
// the pack's installed runtimes and interpreter caches may be ignored.
import { execFileSync, spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '..')
const ALLOWED = [/^packs\/[^/]+\/runtime\/.+\/$/, /\/__pycache__\/$/, /\/node_modules\/$/]

it('ignores nothing under packs/ but runtime installs and caches', () => {
  const ignored = execFileSync('git', ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', 'packs/'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter((l) => l.length > 0)
  expect(ignored.filter((p) => !ALLOWED.some((re) => re.test(p)))).toEqual([])
})

it('does not ignore the fixture data the javascript/grep spec reads', () => {
  // check-ignore exits 1 when no rule matches
  const { status } = spawnSync('git', ['check-ignore', '-q', 'packs/coding-tasks/fixtures/javascript/grep/data/iliad.txt'], { cwd: ROOT })
  expect(status).toBe(1)
})
