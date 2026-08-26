// A Harbor task or dataset directory -> a samsara pack. One task row per task
// dir; the task dir itself is copied into the pack under harbor/<dir>, so the
// row's `environment.dockerfile` and the commands' tests/ and solution/
// resolve inside the pack, which the runner mounts read-only into the
// environment at its own path. That mount is up for the whole attempt, so the
// agent can read tests/ and solution/ while it works (E9) — see the README's
// known limitation. Deterministic in its inputs: no timestamps, no absolute
// paths, a stable hash for the tier split.
import { createHash } from 'node:crypto'
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, posix, resolve } from 'node:path'
import { parseToml } from './toml.mjs'

const TEMPLATE = resolve(import.meta.dirname, 'template')
export const SKILL_NAME = 'instructions'
export const DEFAULT_HOLDOUT_FRACTION = 0.3
export const DEFAULT_SMOKE = 4

const NETWORK = { 'no-network': 'none', public: 'public', allowlist: 'allowlist' }

/** The Harbor task directories under `dir`: the directory itself if it is one, else its children that are. */
export function findTasks(dir) {
  const isTask = (d) => existsSync(resolve(d, 'task.toml')) && existsSync(resolve(d, 'environment'))
  if (isTask(dir)) return [dir]
  const out = readdirSync(dir).sort().map((name) => resolve(dir, name)).filter((d) => statSync(d).isDirectory() && isTask(d))
  if (out.length === 0) throw new Error(`${dir}: not a Harbor task directory and holds none (task.toml + environment/)`)
  return out
}

/**
 * The final stage's last WORKDIR of a Dockerfile, relative ones resolved
 * against the ones before it in that stage; undefined when no stage sets one.
 * Only the final stage counts — throws on what it cannot resolve statically:
 * a WORKDIR holding a variable, or a final stage that sets none while an
 * earlier stage does (the working directory then comes from the base image).
 */
export function dockerfileWorkdir(text) {
  const stages = [[]]
  for (const raw of text.replace(/\\\r?\n/g, ' ').split('\n')) {
    if (/^\s*FROM\s/i.test(raw)) { stages.push([]); continue }
    const m = /^\s*WORKDIR\s+(.+?)\s*$/i.exec(raw)
    if (m) stages.at(-1).push(m[1].replace(/^["']|["']$/g, ''))
  }
  let cwd
  for (const dir of stages.at(-1)) {
    if (dir.includes('$')) throw new Error(`Dockerfile WORKDIR ${dir} holds a variable, not resolvable statically (set [environment].workdir)`)
    cwd = posix.isAbsolute(dir) || cwd === undefined ? dir : posix.join(cwd, dir)
  }
  if (cwd === undefined && stages.some((s) => s.length > 0)) {
    throw new Error('the Dockerfile final stage sets no WORKDIR but an earlier stage does, so the working directory comes from the base image, not resolvable statically (set [environment].workdir)')
  }
  return cwd
}

/** Uniform in [0, 1) from a string: the top 52 bits of its sha256. */
function unit(key) {
  return parseInt(createHash('sha256').update(key).digest('hex').slice(0, 13), 16) / 2 ** 52
}

/** One task row from a Harbor task dir; `packDir` is the pack-relative posix path the dir is copied to. */
export function taskRow(taskDir, packDir, { stratum }) {
  const toml = parseToml(readFileSync(resolve(taskDir, 'task.toml'), 'utf8'))
  if (toml.steps?.length) throw new Error(`${taskDir}: multi-step tasks ([[steps]]) are not supported`)
  if (toml.environment?.os !== undefined && String(toml.environment.os).toLowerCase() !== 'linux') throw new Error(`${taskDir}: only linux tasks are supported`)
  if (toml.verifier?.environment_mode === 'separate' || toml.verifier?.environment !== undefined) {
    throw new Error(`${taskDir}: a separate verifier environment ([verifier].environment_mode / [verifier.environment]) is not supported — truth runs in the agent's environment`)
  }
  if (toml.agent?.user !== undefined || toml.verifier?.user !== undefined) throw new Error(`${taskDir}: [agent].user / [verifier].user are not supported — everything runs as the image's default user`)
  const name = toml.task?.name ?? basename(taskDir)
  const env = toml.environment ?? {}
  // the environment cannot switch networks per phase; never silently narrow a phase policy to the baseline
  const baseline = JSON.stringify([env.network_mode ?? 'public', env.allowed_hosts ?? []])
  for (const phase of ['agent', 'verifier']) {
    const p = toml[phase]
    if (p?.network_mode === undefined && p?.allowed_hosts === undefined) continue
    if (JSON.stringify([p.network_mode, p.allowed_hosts ?? []]) !== baseline) {
      throw new Error(`${taskDir}: [${phase}] declares its own network policy and the environment cannot switch networks per phase`)
    }
  }
  // the in-environment reader (bin/lib.sh json_env) is sed on the row's JSON: it cannot carry these
  for (const section of ['verifier', 'solution']) {
    for (const [k, v] of Object.entries(toml[section]?.env ?? {})) {
      if (typeof v !== 'string' || /["\\,}\n]/.test(k + v)) {
        throw new Error(`${taskDir}: [${section}.env] ${k} must be a string without ", \\, comma, } or newline — the in-environment reader cannot carry it`)
      }
    }
  }
  const dockerfile = resolve(taskDir, 'environment', 'Dockerfile')
  const environment = {
    ...(existsSync(dockerfile) ? { dockerfile: posix.join(packDir, 'environment') } : env.docker_image !== undefined ? { image: env.docker_image } : {}),
    ...(env.cpus !== undefined || env.memory_mb !== undefined
      ? { resources: { ...(env.cpus !== undefined ? { cpus: env.cpus } : {}), ...(env.memory_mb !== undefined ? { memory_mb: env.memory_mb } : {}) } }
      : {}),
    network: NETWORK[env.network_mode ?? 'public'],
    ...(env.allowed_hosts?.length ? { allowed_hosts: env.allowed_hosts } : {}),
  }
  if (environment.dockerfile === undefined && environment.image === undefined) throw new Error(`${taskDir}: no environment/Dockerfile and no [environment].docker_image`)
  if (environment.network === undefined) throw new Error(`${taskDir}: unknown network_mode ${JSON.stringify(env.network_mode)}`)
  let workdir = env.workdir
  if (workdir === undefined && existsSync(dockerfile)) {
    try {
      workdir = dockerfileWorkdir(readFileSync(dockerfile, 'utf8'))
    } catch (e) {
      throw new Error(`${taskDir}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return {
    task_id: name,
    entity_key: name.includes('/') ? name.slice(name.indexOf('/') + 1) : name,
    stratum: toml.task?.keywords?.[0] ?? stratum,
    dir: packDir,
    environment,
    ...(workdir !== undefined ? { workdir } : {}),
    verifier_timeout_s: toml.verifier?.timeout_sec ?? 600,
    ...(toml.agent?.timeout_sec !== undefined ? { agent_timeout_s: toml.agent.timeout_sec } : {}),
    ...(Object.keys(toml.verifier?.env ?? {}).length ? { verifier_env: toml.verifier.env } : {}),
    ...(Object.keys(toml.solution?.env ?? {}).length ? { solution_env: toml.solution.env } : {}),
  }
}

/** smoke / holdin / holdout by a stable hash of the entity key: holdout is disjoint by entity, smoke the first `smoke` held-in rows in hash order. */
export function splitRows(rows, { holdoutFraction, smoke }) {
  const key = (r) => unit(`tier\0${r.entity_key}`)
  const holdout = rows.filter((r) => key(r) < holdoutFraction)
  const holdin = rows.filter((r) => key(r) >= holdoutFraction)
  const smokeRows = [...holdin].sort((a, b) => key(a) - key(b)).slice(0, smoke)
  const byId = (a, b) => (a.task_id < b.task_id ? -1 : a.task_id > b.task_id ? 1 : 0)
  return { smoke: smokeRows.sort(byId), holdin: holdin.sort(byId), holdout: holdout.sort(byId) }
}

const jsonl = (rows) => rows.map((r) => JSON.stringify(r) + '\n').join('')

function packYaml(name) {
  return `name: ${name}
truth_latency: immediate
skill: { dir: skill/, name: ${SKILL_NAME} }
contract: contract.schema.json
tasks:
  sets: { smoke: tasks/smoke.jsonl, holdin: tasks/holdin.jsonl, holdout: tasks/holdout.jsonl }
  entity_key: entity_key
  version: 1
  stratum_key: stratum
metrics:
  primary: { name: reward, direction: up }
surfaces:
  skill: { globs: ["skill/**"] }
# Every task row carries its own \`environment\` (the Harbor task's
# environment/Dockerfile, resources and network policy) and \`workdir\`, the
# image's working directory; truth runs inside it as Harbor's verifier does,
# on bash and coreutils alone (a Harbor image carries no node).
commands:
  truth: { run: ./bin/truth, in_environment: true }
  score: ./bin/score.mjs
  materialize: ./bin/materialize.mjs
`
}

function skillMd() {
  return `---
name: ${SKILL_NAME}
description: Complete the task described in instruction.md in the working directory.
---

# instructions

The working directory contains \`instruction.md\`, the task. Read it, then do
what it asks in this directory: the files you create or change here are what
is checked once you finish. Nothing outside the working directory counts
unless the instruction says so. There is no submission step beyond finishing.
`
}

function readmeMd(name, source, sets) {
  const n = (t) => sets[t].length
  return `# ${name}

A pack generated from the Harbor task set \`${source}\` by
\`tools/pack-from-harbor\`; regenerate it there rather than editing it here.

- **Task**: a Harbor task — \`instruction.md\` in the working directory, the
  task's own image (\`harbor/<task>/environment/Dockerfile\`), its tests as the
  truth. ${n('smoke')} smoke / ${n('holdin')} held-in / ${n('holdout')} held-out
  tasks; \`entity_key\` = the task name, \`stratum\` = the task's first keyword
  or the pack name.
- **Skill**: \`skill/SKILL.md\`, what the installed agent reads — the thing
  being optimized.
- **truth** (\`in_environment\`, bash + coreutils): copies \`harbor/<task>/tests\`
  to \`/tests\`, runs \`bash /tests/test.sh\` from the task's working directory
  under the task.toml verifier timeout, reads \`/logs/verifier/reward.json\` or
  \`reward.txt\`; \`truth_sha\` = sha256 of the task's \`tests/\`.
- **score**: \`reward\` (reality) plus one metric per key of \`reward.json\`.
- **bin/oracle** (bash): Harbor's oracle — \`solution/solve.sh\` in the
  environment for the attempt whose token it is given; the pack's self-check.
- **Divergence from Harbor**: the working directory also holds
  \`instruction.md\` (Harbor hands the instruction to the agent as a string)
  and the framework's \`.agents/\`, \`.claude/\`, \`.task/\` and \`.tmp/\`; a
  test that inspects the working tree itself (file counts, \`git status
  --porcelain\`) can disagree with Harbor's verdict. And the whole pack —
  \`harbor/<task>/tests\`, \`harbor/<task>/solution\`, \`tasks/*.jsonl\` — is
  mounted read-only into the environment for the whole attempt, so an agent
  that goes looking can read them (E9); Harbor copies \`/tests\` in only after
  the agent and \`/solution\` only for its oracle.

## Running it

The attempts need the task's image, so a provider other than \`local\` — the
\`environments-docker\` row enabled in the profile — and an installed loop: the
\`loops-installed\` row enabled with the oracle as its command (the pack is
mounted read-only into the environment at its own absolute path):

\`\`\`yaml
- id: environments-docker
  disabled: false
  config: { docker: docker }
- id: loops-installed
  disabled: false
  config:
    command: [bash, /abs/path/to/packs/${name}/bin/oracle, '{attempt}']
\`\`\`

\`\`\`sh
# the oracle in the task's image: every attempt must score reward 1
dsh --profile host run --pack packs/${name} --loop installed --env docker --set smoke
# a Harbor job of the same tasks into the ledger, no run (packages/runner/README.md, import harbor)
dsh --profile host import harbor <jobDir> --pack packs/${name} --as champion --metric reward
\`\`\`
`
}

/**
 * Generate the pack at `out` from the Harbor task or dataset directory `from`.
 * Returns the task rows per tier. `out` must not exist or be empty unless
 * `force`, which replaces it.
 */
export function generatePack({ from, out, name, holdoutFraction = DEFAULT_HOLDOUT_FRACTION, smoke = DEFAULT_SMOKE, force = false }) {
  const source = resolve(from)
  const packName = name ?? basename(source).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
  if (!/^[a-z][a-z0-9-]*$/.test(packName)) throw new Error(`pack name ${JSON.stringify(packName)} must match ^[a-z][a-z0-9-]*$ (pass --name)`)
  const dest = resolve(out)
  if (existsSync(dest) && readdirSync(dest).length > 0) {
    if (!force) throw new Error(`${dest} exists and is not empty (pass --force to replace it)`)
    rmSync(dest, { recursive: true })
  }
  const taskDirs = findTasks(source)
  const rows = taskDirs.map((d) => taskRow(d, posix.join('harbor', basename(d)), { stratum: packName }))
  const seen = new Set()
  for (const r of rows) {
    if (seen.has(r.task_id)) throw new Error(`two tasks named ${r.task_id}`)
    seen.add(r.task_id)
  }
  const sets = splitRows(rows, { holdoutFraction, smoke })

  mkdirSync(resolve(dest, 'tasks'), { recursive: true })
  mkdirSync(resolve(dest, 'skill'))
  mkdirSync(resolve(dest, 'bin'))
  for (const d of taskDirs) cpSync(d, resolve(dest, 'harbor', basename(d)), { recursive: true, filter: (p) => basename(p) !== '.git' })
  for (const f of readdirSync(resolve(TEMPLATE, 'bin'))) {
    cpSync(resolve(TEMPLATE, 'bin', f), resolve(dest, 'bin', f))
    chmodSync(resolve(dest, 'bin', f), f.startsWith('lib.') ? 0o644 : 0o755)
  }
  for (const tier of ['smoke', 'holdin', 'holdout']) writeFileSync(resolve(dest, 'tasks', `${tier}.jsonl`), jsonl(sets[tier]))
  writeFileSync(resolve(dest, 'pack.yaml'), packYaml(packName))
  writeFileSync(resolve(dest, 'contract.schema.json'), '{}\n')
  writeFileSync(resolve(dest, 'skill', 'SKILL.md'), skillMd())
  writeFileSync(resolve(dest, 'README.md'), readmeMd(packName, basename(source), sets))
  return sets
}
