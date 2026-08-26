// A profile boots its bundles' patch rows by package name from its own
// node_modules, so every package a bundle's patch names must be a `link:`
// dependency of the profile manifest, or `dsh plugin --profile <name>
// install` leaves the tree unloadable (ERR_MODULE_NOT_FOUND at boot, as the
// environments package once did). Disabled rows count: flipping one must not
// need an install.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '..')
const PROFILES = join(ROOT, 'profiles')

interface Manifest { dependencies?: Record<string, string>; dsh?: { profile?: { bundles?: string[] }; bundle?: { patch?: string } } }

function manifest(dir: string): Manifest {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifest
}

/** The package a row's `name` resolves from: the scope and the package, without any subpath. */
function packageOf(name: string): string {
  return name.split('/').slice(0, name.startsWith('@') ? 2 : 1).join('/')
}

/** Every row `name` in a patch: under each op (`insert`, …) and inside groups. */
function names(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) for (const n of node) names(n, out)
  else if (node !== null && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === 'name' && typeof v === 'string') out.push(v)
      else names(v, out)
    }
  }
  return out
}

describe.each(readdirSync(PROFILES).filter((p) => existsSync(join(PROFILES, p, 'package.json'))))('profile %s', (profile) => {
  const dir = join(PROFILES, profile)
  const deps = manifest(dir).dependencies ?? {}
  const linked = Object.entries(deps).filter(([, v]) => v.startsWith('link:')).map(([k, v]) => [k, resolve(dir, v.slice('link:'.length))] as const)

  it('links every bundle it boots that lives in this repository, at a directory whose package has that name', () => {
    for (const [name, target] of linked) {
      expect(existsSync(join(target, 'package.json')), `${name} -> ${target}`).toBe(true)
      expect((JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')) as { name: string }).name).toBe(name)
    }
  })

  it('links every package its bundles\' patches name', () => {
    const bundles = (manifest(dir).dsh?.profile?.bundles ?? []).filter((b) => b in deps)
    expect(bundles.length).toBeGreaterThan(0)
    const missing = new Set<string>()
    for (const bundle of bundles) {
      const target = linked.find(([name]) => name === bundle)![1]
      const patch = manifest(target).dsh?.bundle?.patch
      expect(patch, `${bundle} declares dsh.bundle.patch`).toBeDefined()
      for (const name of names(parse(readFileSync(join(target, patch!), 'utf8')))) {
        const pkg = packageOf(name)
        if (pkg.startsWith('@oldbulb/') && !(pkg in deps)) missing.add(pkg)
      }
    }
    expect([...missing]).toEqual([])
  })
})
