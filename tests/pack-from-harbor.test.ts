// tools/pack-from-harbor: a Harbor task directory becomes a pack the loader
// accepts, byte for byte the same on every run, with each task row carrying
// the task's own environment; packs/harbor-hello is pinned as that output for
// the bundled hello-world example. Nothing here needs a docker daemon: running
// the generated truth in the task's image is the docker e2e's.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { loadPack, runCommand, type PackDefinition } from '../packages/pack/src/index.ts'
import { dockerfileWorkdir, generatePack, splitRows, taskRow } from '../tools/pack-from-harbor/generate.mjs'
import { parseToml } from '../tools/pack-from-harbor/toml.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const EXAMPLE = join(ROOT, 'tools', 'pack-from-harbor', 'examples', 'hello-world')
const COMMITTED = join(ROOT, 'packs', 'harbor-hello')
const ARGS = { from: EXAMPLE, name: 'harbor-hello', holdoutFraction: 0 }

const roots: string[] = []
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }) })
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'pack-from-harbor-'))
  roots.push(d)
  return d
}

/** Every file under `dir`: posix-relative path -> content and mode bits. */
function tree(dir: string): Record<string, { text: string; mode: number }> {
  const out: Record<string, { text: string; mode: number }> = {}
  const walk = (d: string, rel: string) => {
    for (const name of readdirSync(d).sort()) {
      const abs = join(d, name)
      const r = rel === '' ? name : posix.join(rel, name)
      const st = statSync(abs)
      if (st.isDirectory()) walk(abs, r)
      else out[r] = { text: readFileSync(abs, 'utf8'), mode: st.mode & 0o777 }
    }
  }
  walk(dir, '')
  return out
}

function generate(): string {
  const out = join(tmp(), 'harbor-hello')
  generatePack({ ...ARGS, out })
  return out
}

describe('generation', () => {
  it('is deterministic', () => {
    expect(tree(generate())).toEqual(tree(generate()))
  })

  it('is what packs/harbor-hello holds', () => {
    expect(tree(COMMITTED)).toEqual(tree(generate()))
  })

  it('refuses a non-empty output without --force', () => {
    const out = generate()
    expect(() => generatePack({ ...ARGS, out })).toThrow(/--force/)
    expect(() => generatePack({ ...ARGS, out, force: true })).not.toThrow()
  })

  it('reads the task as Harbor does', () => {
    const row = taskRow(EXAMPLE, 'harbor/hello-world', { stratum: 'x' })
    expect(row).toEqual({
      task_id: 'harbor/hello-world', entity_key: 'hello-world', stratum: 'x', dir: 'harbor/hello-world',
      environment: { dockerfile: 'harbor/hello-world/environment', resources: { cpus: 1, memory_mb: 2048 }, network: 'public' },
      workdir: '/app', verifier_timeout_s: 120, agent_timeout_s: 120,
    })
    expect(dockerfileWorkdir('FROM x\nWORKDIR /a\nWORKDIR b\n')).toBe('/a/b')
    expect(dockerfileWorkdir('FROM x\n')).toBeUndefined()
    expect(parseToml('[environment]\nnetwork_mode = "no-network"\nallowed_hosts = ["a.example", "b.example"]\n')).toEqual({ environment: { network_mode: 'no-network', allowed_hosts: ['a.example', 'b.example'] } })
  })

  it('splits tiers by a stable hash of the entity, holdout disjoint', () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ task_id: `org/t${i}`, entity_key: `t${i}` }))
    const a = splitRows(rows, { holdoutFraction: 0.3, smoke: 4 })
    const b = splitRows([...rows].reverse(), { holdoutFraction: 0.3, smoke: 4 })
    expect(a).toEqual(b)
    expect(a.smoke).toHaveLength(4)
    expect(a.holdin.length + a.holdout.length).toBe(40)
    expect(a.holdout.length).toBeGreaterThan(0)
    const held = new Set(a.holdout.map((r) => r.entity_key))
    for (const r of [...a.smoke, ...a.holdin]) expect(held.has(r.entity_key)).toBe(false)
    expect(splitRows(rows, { holdoutFraction: 0, smoke: 4 }).holdout).toEqual([])
  })
})

/** A minimal Harbor task dir with the given task.toml and Dockerfile. */
function harborTask(toml: string, dockerfile = 'FROM x\nWORKDIR /w\n'): string {
  const d = join(tmp(), 'task')
  mkdirSync(join(d, 'environment'), { recursive: true })
  writeFileSync(join(d, 'task.toml'), toml)
  writeFileSync(join(d, 'environment', 'Dockerfile'), dockerfile)
  return d
}

/** bin/truth's read_reward on a reward.txt holding `text`. */
function readReward(text: string): { status: number | null; stdout: string; stderr: string } {
  const dir = tmp()
  writeFileSync(join(dir, 'reward.txt'), text)
  const src = readFileSync(join(ROOT, 'tools', 'pack-from-harbor', 'template', 'bin', 'truth'), 'utf8')
  const start = src.indexOf('read_reward()')
  const fn = src.slice(start, src.indexOf('\n}', start) + 2)
  return spawnSync('bash', ['-c', `set -euo pipefail\nVERIFIER_LOGS=${JSON.stringify(dir)}\n${fn}\nread_reward`], { encoding: 'utf8' })
}

describe('what the generator refuses rather than silently narrows', () => {
  const row = (toml: string, dockerfile?: string) => taskRow(harborTask(toml, dockerfile), 'harbor/task', { stratum: 'x' })

  it('a per-phase network policy that differs from the [environment] baseline', () => {
    expect(() => row('[environment]\nnetwork_mode = "no-network"\n\n[verifier]\nnetwork_mode = "public"\n')).toThrow(/\[verifier\] declares its own network policy/)
    expect(() => row('[agent]\nnetwork_mode = "allowlist"\nallowed_hosts = ["a.example"]\n')).toThrow(/\[agent\] declares its own network policy/)
    expect(row('[environment]\nnetwork_mode = "no-network"\n\n[verifier]\nnetwork_mode = "no-network"\n').environment.network).toBe('none')
  })

  it('a separate verifier environment', () => {
    expect(() => row('[verifier]\nenvironment_mode = "separate"\n')).toThrow(/separate verifier environment/)
    expect(() => row('[verifier.environment]\ndocker_image = "x"\n')).toThrow(/separate verifier environment/)
    expect(() => row('[verifier]\nenvironment_mode = "shared"\n')).not.toThrow()
  })

  it('[agent].user and [verifier].user', () => {
    expect(() => row('[agent]\nuser = "app"\n')).toThrow(/user/)
    expect(() => row('[verifier]\nuser = "root"\n')).toThrow(/user/)
  })

  it('an env value the sed reader inside the environment would drop or mangle', () => {
    for (const value of ['"x=y,z"', '"has \\"quote\\""', '"a\\\\b"', '5']) {
      expect(() => row(`[verifier.env]\nA = ${value}\n`), value).toThrow(/cannot carry/)
    }
    expect(() => row('[solution.env]\nA = "ok value"\n')).not.toThrow()
  })

  it('a Dockerfile workdir it cannot resolve statically; only the final stage counts', () => {
    expect(dockerfileWorkdir('FROM a AS build\nWORKDIR /build\nFROM b\nWORKDIR /srv\n')).toBe('/srv')
    expect(() => dockerfileWorkdir('FROM a AS build\nWORKDIR /build\nFROM b\nRUN x\n')).toThrow(/final stage sets no WORKDIR/)
    expect(() => dockerfileWorkdir('FROM a\nARG APP=/srv\nWORKDIR $APP\n')).toThrow(/variable/)
    expect(() => row('', 'FROM a AS build\nWORKDIR /build\nFROM b\nRUN x\n')).toThrow(/final stage sets no WORKDIR/)
  })
})

describe("truth's read_reward", () => {
  it("turns what Harbor's float() takes into a JSON number", () => {
    for (const [text, value] of [['.75', 0.75], ['1.', 1], ['+1', 1], ['-.5', -0.5], ['0.866', 0.866], ['2', 2], ['1e-3', 0.001]] as const) {
      const r = readReward(text)
      expect(r.status, `${text}: ${r.stderr}`).toBe(0)
      expect(JSON.parse(r.stdout)).toEqual({ reward: value })
    }
  })

  it('rejects what is still not a JSON number, loudly', () => {
    for (const text of ['abc', '1.2.3', '.', '-.', '--1', '007', '']) {
      expect(readReward(text).status, text).not.toBe(0)
    }
  })
})

describe('the generated pack', () => {
  let def: PackDefinition
  it('loads', () => {
    def = loadPack(COMMITTED)
    expect(def.commandSpecs.truth).toEqual({ run: './bin/truth', inEnvironment: true })
    expect(def.commandSpecs.score?.inEnvironment).toBe(false)
    expect(def.manifest.metrics?.primary.name).toBe('reward')
    expect(readdirSync(def.skillDir)).toEqual(['SKILL.md'])
  })

  it('has task rows carrying the task environment and workdir', () => {
    const [row] = def.taskSets.smoke.tasks
    expect(row?.task_id).toBe('harbor/hello-world')
    expect(row?.environment).toEqual({ dockerfile: 'harbor/hello-world/environment', resources: { cpus: 1, memory_mb: 2048 }, network: 'public' })
    expect(row?.['workdir']).toBe('/app')
    expect(existsSync(resolve(def.dir, row!.environment!.dockerfile!, 'Dockerfile'))).toBe(true)
    expect(def.taskSets.holdin.tasks).toEqual(def.taskSets.smoke.tasks)
    expect(def.taskSets.holdout.tasks).toEqual([])
  })

  it('materialize writes the instruction on the host', async () => {
    const workdir = join(tmp(), 'attempt')
    const [line] = await runCommand(def, 'materialize', [{ task_id: 'harbor/hello-world', workdir }])
    expect(line).toEqual({ task_id: 'harbor/hello-world', ok: true, files: ['instruction.md'] })
    expect(readFileSync(join(workdir, 'instruction.md'), 'utf8')).toBe(readFileSync(join(EXAMPLE, 'instruction.md'), 'utf8'))
  })

  it('score turns a reward or a reward table into reality metrics', async () => {
    const lines = await runCommand(def, 'score', [
      { task_id: 'harbor/hello-world', truth: { reward: 1 }, output: {} },
      { task_id: 'harbor/hello-world', truth: { rewards: { reward: 0.5, tests_passed: 3 } }, output: {} },
    ])
    expect(lines).toEqual([
      { task_id: 'harbor/hello-world', metric: 'reward', value: 1, kind: 'reality', stratum: 'harbor-hello' },
      { task_id: 'harbor/hello-world', metric: 'reward', value: 0.5, kind: 'reality', stratum: 'harbor-hello' },
      { task_id: 'harbor/hello-world', metric: 'tests_passed', value: 3, kind: 'reality', stratum: 'harbor-hello' },
    ])
  })

  it('every script parses: node for the host side, bash for what runs in the image', () => {
    for (const f of readdirSync(join(COMMITTED, 'bin'))) {
      const r = f.endsWith('.mjs')
        ? spawnSync('node', ['--check', join(COMMITTED, 'bin', f)], { encoding: 'utf8' })
        : spawnSync('bash', ['-n', join(COMMITTED, 'bin', f)], { encoding: 'utf8' })
      expect(r.status, `${f}: ${r.stderr}`).toBe(0)
    }
  })
})
