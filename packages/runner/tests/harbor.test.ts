// `import harbor`: the fixture jobs under tests/fixtures/harbor/jobs (written
// by gen.py from Harbor 0.22.0's own models) read field by field, mapped to
// attempt and score rows, and imported through the real lifecycle over the
// fakes with the replay executor mounted: a champion lands, a challenger is
// judged at holdout against it, a noise floor lands.

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { sd } from '@oldbulb/samsara-gate'
import { LifecycleError } from '@oldbulb/samsara-lifecycle'
import { canonicalJson, sha256 } from '@oldbulb/samsara-ledger'
import { loadPack } from '@oldbulb/samsara-pack'
import { hashDir } from '@oldbulb/samsara-workdir'
import { harborAttempts, harborChampion, harborChallenger, harborFactsSha, harborLoop, readHarborJob, snapshotHarborSkills, type TrialResult } from '../src/harbor.ts'
import { formatImportHarbor, HarborReplay, importHarbor, type ImportHarborRequest } from '../src/import-harbor.ts'
import { bookOf } from '../src/run.ts'
import { formatStatus } from '../src/status.ts'
import { DEFAULTS, runProgram, type SamsaraRunValues } from '../src/startup.ts'
import { openHarness } from './harness.ts'

const FIXTURES = resolve(import.meta.dirname, 'fixtures', 'harbor')
const PACK = resolve(FIXTURES, 'pack')
const ORACLE = resolve(FIXTURES, 'jobs', 'oracle')
const VARIANT = resolve(FIXTURES, 'jobs', 'variant')
const OTHER = resolve(FIXTURES, 'jobs', 'other')
const ORACLE_JOB_ID = '5ce1a57a-884a-5585-aa81-50e4dd7d5df0'
const checksum = (task: string) => sha256(`task:${task}`)
const tmp = (label: string) => mkdtempSync(resolve(tmpdir(), `runner-harbor-${label}-`))

/** A copy of a fixture job with `edit` applied to every trial's result.json (and config.json when it touches the config). */
function editJob(src: string, label: string, edit: (name: string, result: TrialResult, dir: string) => void): string {
  const dir = tmp(label)
  cpSync(src, dir, { recursive: true })
  for (const trial of readHarborJob(dir).trials) {
    const file = resolve(trial.dir, 'result.json')
    const result = JSON.parse(readFileSync(file, 'utf8')) as TrialResult
    edit(trial.name, result, trial.dir)
    writeFileSync(file, JSON.stringify(result))
    if (result.config) writeFileSync(resolve(trial.dir, 'config.json'), JSON.stringify(result.config))
  }
  return dir
}

/** A copy of a fixture job declaring `skills` (the sources Harbor resolved) on every trial. */
function withSkills(src: string, label: string, skills: string[]): string {
  return editJob(src, label, (_name, result) => { result.config!.agent!.skills = skills })
}

/** A skill directory: `<dir>/SKILL.md` (and the extra files). */
function writeSkill(dir: string, text: string, extra: Record<string, string> = {}): string {
  mkdirSync(dir, { recursive: true })
  writeFileSync(resolve(dir, 'SKILL.md'), text)
  for (const [name, body] of Object.entries(extra)) writeFileSync(resolve(dir, name), body)
  return dir
}

describe('readHarborJob', () => {
  it('reads every trial of a job in creation order, with every field the mapping uses', () => {
    const job = readHarborJob(ORACLE)
    expect(job.id).toBe(ORACLE_JOB_ID)
    expect(job.dir).toBe(ORACLE)
    expect(job.agent).toEqual({ name: 'oracle', version: '1.0.0', model_info: null })
    expect(job.environment).toBe('docker')
    expect(job.skipped).toEqual([])
    expect(job.trials.map((t) => t.name)).toEqual(['o1__ora0000', 'o1__ora0001', 'o1__ora0002', 'o2__ora0000', 'o2__ora0001', 'o2__ora0002', 'o3__ora0000', 'o3__ora0001', 'o3__ora0002'])
    expect(job.trials.map((t) => t.sample)).toEqual([0, 1, 2, 0, 1, 2, 0, 1, 2])
    const t = job.trials[1]!
    expect(t.dir).toBe(resolve(ORACLE, 'o1__ora0001'))
    expect(t.result).toMatchObject({
      id: '5446edc6-2412-5a53-bfaa-1e0e8a01a2de', task_name: 'o1', trial_name: 'o1__ora0001', trial_uri: 'file:///jobs/oracle/o1__ora0001', source: null,
      task_checksum: checksum('o1'),
      agent_info: { name: 'oracle', version: '1.0.0', model_info: null },
      agent_result: { n_input_tokens: 1200, n_cache_tokens: 200, n_output_tokens: 52, cost_usd: 0.02 },
      verifier_result: null, verifier_environment_mode: 'shared', exception_info: null,
      started_at: '2026-08-26T12:10:00Z', finished_at: '2026-08-26T12:16:00Z',
      environment_setup: { started_at: '2026-08-26T12:10:00Z', finished_at: '2026-08-26T12:10:30Z' }, agent_setup: null,
      agent_execution: { started_at: '2026-08-26T12:10:30Z', finished_at: '2026-08-26T12:15:00Z' },
      verifier: { started_at: '2026-08-26T12:15:00Z', finished_at: '2026-08-26T12:16:00Z' }, step_results: null,
    })
    // The config embedded in result.json (complete), not config.json (defaults excluded).
    expect(t.config).toMatchObject({
      task: { path: '/tasks/o1', git_url: null, name: null }, trial_name: 'o1__ora0001', job_id: ORACLE_JOB_ID,
      agent: { name: 'oracle', model_name: null, kwargs: {}, skills: [], override_timeout_sec: null },
      environment: { type: 'docker', kwargs: {}, override_cpus: null }, timeout_multiplier: 1, agent_timeout_multiplier: null,
    })
    // Unknown fields are dropped, not refused.
    expect(t.result).not.toHaveProperty('task_id')
    expect(t.config).not.toHaveProperty('verifier')
    // This trial's result carries no verifier_result: the reward comes from verifier/reward.txt.
    expect(t.rewards).toEqual({ reward: 1 })
    expect(t.rewardSource).toBe('reward.txt')
    expect(job.trials[0]!.rewardSource).toBe('result')
    expect(job.trials.map((t) => t.rewards?.['reward'])).toEqual([1, 1, 1, 1, 0, 1, 0, 1, 1])
  })

  it('reads reward.json (one key per metric) from the result or from the file, and the agent skills a job declares', () => {
    const job = readHarborJob(VARIANT)
    expect(job.agent).toEqual({ name: 'oracle', version: '1.0.0', model_info: null })
    expect(job.trials).toHaveLength(6)
    expect(job.trials[0]!.rewards).toEqual({ reward: 0, tests_passed: 0 })
    expect(job.trials[0]!.rewardSource).toBe('result')
    const fromFile = job.trials.find((t) => t.name === 'o2__var0001')!
    expect(fromFile.result.verifier_result).toBeNull()
    expect(fromFile.rewards).toEqual({ reward: 1, tests_passed: 4 })
    expect(fromFile.rewardSource).toBe('reward.json')
    expect(job.trials[0]!.config.agent?.skills).toEqual(['skills/terse'])
  })

  it('reads a failed trial (exception_info, no reward) and a model with its provider', () => {
    const job = readHarborJob(OTHER)
    expect(job.agent).toEqual({ name: 'other', version: '0.1.0', model_info: { name: 'model-x', provider: 'prov' } })
    expect(job.trials.map((t) => [t.name, t.sample])).toEqual([['o1__oth0000', 0], ['o1__oth0001', 1], ['o2__oth0000', 0], ['o2__oth0001', 1]])
    const failed = job.trials[1]!
    expect(failed.result.exception_info).toMatchObject({ exception_type: 'AgentTimeoutError', exception_message: 'agent timed out', occurred_at: '2026-08-26T12:15:00Z' })
    expect(failed.result.agent_result).toBeNull()
    expect(failed.rewards).toBeUndefined()
    expect(failed.rewardSource).toBe('none')
    expect(job.trials[0]!.config.agent).toMatchObject({ model_name: 'prov/model-x', kwargs: { max_turns: 5 } })
  })

  it('refuses a missing or empty job directory, and one that mixes agents; skips subdirectories that are no trial', () => {
    expect(() => readHarborJob(resolve(FIXTURES, 'nowhere'))).toThrow(/no Harbor job directory/)
    expect(() => readHarborJob(tmp('empty'))).toThrow(/holds no trial/)
    const mixed = tmp('mixed')
    cpSync(resolve(ORACLE, 'o1__ora0000'), resolve(mixed, 'o1__ora0000'), { recursive: true })
    cpSync(resolve(OTHER, 'o1__oth0000'), resolve(mixed, 'o1__oth0000'), { recursive: true })
    expect(() => readHarborJob(mixed)).toThrow(/ran agent other@0.1.0, trial o1__ora0000 ran oracle@1.0.0; one job is one agent/)
    const partial = tmp('partial')
    cpSync(resolve(ORACLE, 'o1__ora0000'), resolve(partial, 'o1__ora0000'), { recursive: true })
    cpSync(resolve(ORACLE, 'o1__ora0001', 'agent'), resolve(partial, 'o1__unfinished', 'agent'), { recursive: true })
    const job = readHarborJob(partial)
    expect(job.trials.map((t) => t.name)).toEqual(['o1__ora0000'])
    expect(job.skipped).toEqual(['o1__unfinished'])
    // No job_id in any trial's config: the directory name stands in.
    expect(readHarborJob(partial).id).toBe(ORACLE_JOB_ID)
  })

  it('a trial that raised before its agent\'s setup finished (version unknown) inherits the job\'s agent; an unknown version without an exception does not', () => {
    const failed = (result: TrialResult) => {
      result.agent_info.version = 'unknown'
      result.exception_info = { exception_type: 'EnvironmentStartTimeoutError', exception_message: 'environment start timed out', exception_traceback: null, occurred_at: '2026-08-26T12:00:10Z' }
      result.verifier_result = null
      result.agent_result = null
      result.agent_execution = null
    }
    const job = readHarborJob(editJob(ORACLE, 'setup-failed', (name, result, dir) => {
      if (name !== 'o1__ora0001') return
      failed(result)
      rmSync(resolve(dir, 'verifier'), { recursive: true })
    }))
    expect(job.agent).toEqual({ name: 'oracle', version: '1.0.0', model_info: null })
    expect(job.trials.map((t) => t.result.agent_info.version)).toEqual(['1.0.0', 'unknown', '1.0.0', '1.0.0', '1.0.0', '1.0.0', '1.0.0', '1.0.0', '1.0.0'])
    // The job's agent is the one the trials past setup report, whichever trial came first.
    const firstFailed = readHarborJob(editJob(ORACLE, 'first-setup-failed', (name, result) => { if (name === 'o1__ora0000') failed(result) }))
    expect(firstFailed.agent.version).toBe('1.0.0')
    // Every attempt of the job carries the job's agent in its facts and loop, the failed one FAILED on the exception.
    const { attempts, scores } = harborAttempts(job, { challengerId: 'champ', tier: 'holdout', scorerVersion: '0' })
    expect(new Set(attempts.map((a) => a.loop))).toEqual(new Set(['harbor:oracle@1.0.0']))
    expect(new Set(attempts.filter((a) => a.task_id === 'o1').map((a) => a.facts_sha)).size).toBe(1)
    expect(attempts[1]).toMatchObject({ task_id: 'o1', sample: 1, status: 'FAILED', stop_reason: 'EnvironmentStartTimeoutError', output: { valid: false } })
    expect(scores).toHaveLength(8)
    // A whole job that never got past setup is that agent at version unknown; an unknown version on a trial that raised nothing is another agent.
    expect(readHarborJob(editJob(ORACLE, 'all-setup-failed', (_n, result) => failed(result))).agent.version).toBe('unknown')
    expect(() => readHarborJob(editJob(ORACLE, 'unknown-ok', (name, result) => { if (name === 'o2__ora0000') result.agent_info.version = 'unknown' }))).toThrow(/ran agent oracle@unknown, trial o1__ora0000 ran oracle@1.0.0; one job is one agent/)
  })
})

describe('harborAttempts', () => {
  const opts = { challengerId: 'champ', tier: 'holdout' as const, scorerVersion: '2' }

  it('maps every trial to one attempt row and one score row per reward key', () => {
    const job = readHarborJob(ORACLE)
    const { attempts, scores } = harborAttempts(job, opts)
    expect(attempts).toHaveLength(9)
    expect(scores).toHaveLength(9)
    const a = attempts[1]!
    expect(a).toEqual({
      id: 'harbor-5446edc6-2412-5a53-bfaa-1e0e8a01a2de-champ', challenger_id: 'champ', task_id: 'o1', sample: 1, loop: 'harbor:oracle@1.0.0', tier: 'holdout',
      status: 'COMPLETED', stop_reason: 'completed', facts_sha: harborFactsSha(job, job.trials[1]!),
      usage: { input_tokens: 1200, output_tokens: 52, cache_tokens: 200 }, cost: { tokens: 1252, usd: 0.02, wall_s: 270 },
      output: { source: 'harbor', valid: true }, artifacts: [{ name: 'trial', sha: '', path: resolve(ORACLE, 'o1__ora0001') }],
    })
    expect(a.facts_sha).toBe(sha256(canonicalJson({ agent_info: job.agent, environment: 'docker', task_checksum: checksum('o1') })))
    // The facts are per task (its checksum) and shared by every trial of it.
    expect(new Set(attempts.filter((x) => x.task_id === 'o1').map((x) => x.facts_sha)).size).toBe(1)
    expect(attempts[0]!.facts_sha).not.toBe(attempts[3]!.facts_sha)
    expect(attempts.map((x) => `${x.task_id}:${x.sample}`)).toEqual(['o1:0', 'o1:1', 'o1:2', 'o2:0', 'o2:1', 'o2:2', 'o3:0', 'o3:1', 'o3:2'])
    expect(scores[1]).toEqual({ attempt_id: a.id, scorer_version: '2', truth_snapshot_id: checksum('o1'), metric: 'reward', value: 1, kind: 'reality' })
    expect(scores.map((s) => s.value)).toEqual([1, 1, 1, 1, 0, 1, 0, 1, 1])
    // An attempt id belongs to one challenger row: the same trial under another row is another attempt.
    expect(harborAttempts(job, { ...opts, challengerId: 'other-row' }).attempts[1]!.id).toBe('harbor-5446edc6-2412-5a53-bfaa-1e0e8a01a2de-other-row')
  })

  it('a trial that raised but was verified keeps its reward as Harbor counts it: TRUNCATED on a timeout, COMPLETED on any other exception', () => {
    const job = readHarborJob(editJob(VARIANT, 'raised-scored', (name, result) => {
      if (name === 'o1__var0000') result.exception_info = { exception_type: 'AgentTimeoutError', exception_message: 'agent timed out', exception_traceback: null, occurred_at: '2026-08-26T12:05:00Z' }
      if (name === 'o2__var0001') result.exception_info = { exception_type: 'NonZeroAgentExitCodeError', exception_message: 'exit 1', exception_traceback: null, occurred_at: '2026-08-26T12:25:00Z' }
    }))
    const { attempts, scores } = harborAttempts(job, opts)
    expect(attempts.map((a) => [a.status, a.stop_reason])).toEqual([
      ['TRUNCATED', 'AgentTimeoutError'], ['COMPLETED', 'completed'], ['COMPLETED', 'completed'], ['COMPLETED', 'NonZeroAgentExitCodeError'], ['COMPLETED', 'completed'], ['COMPLETED', 'completed'],
    ])
    expect(attempts.every((a) => a.output.valid)).toBe(true)
    expect(scores).toHaveLength(12)
    expect(scores.filter((s) => s.attempt_id === attempts[0]!.id).map((s) => s.value)).toEqual([0, 0])
  })

  it('a failed trial is a FAILED attempt with no usage and no score; a second agent has other facts on the same task', () => {
    const oracle = readHarborJob(ORACLE)
    const other = readHarborJob(OTHER)
    const { attempts, scores } = harborAttempts(other, opts)
    expect(attempts).toHaveLength(4)
    expect(scores).toHaveLength(3)
    const failed = attempts[1]!
    expect(failed).toMatchObject({ task_id: 'o1', sample: 1, loop: 'harbor:other@0.1.0', status: 'FAILED', stop_reason: 'AgentTimeoutError', usage: { input_tokens: 0, output_tokens: 0 }, output: { source: 'harbor', valid: false } })
    expect(failed.cost).toEqual({ tokens: 0, wall_s: 270 })
    expect(scores.some((s) => s.attempt_id === failed.id)).toBe(false)
    expect(attempts[0]!.facts_sha).not.toBe(harborAttempts(oracle, opts).attempts[0]!.facts_sha)
  })

  it('reward.json gives one score row per key', () => {
    const { attempts, scores } = harborAttempts(readHarborJob(VARIANT), opts)
    expect(attempts).toHaveLength(6)
    expect(scores).toHaveLength(12)
    expect(scores.filter((s) => s.attempt_id === attempts[0]!.id)).toEqual([
      { attempt_id: attempts[0]!.id, scorer_version: '2', truth_snapshot_id: checksum('o1'), metric: 'reward', value: 0, kind: 'reality' },
      { attempt_id: attempts[0]!.id, scorer_version: '2', truth_snapshot_id: checksum('o1'), metric: 'tests_passed', value: 0, kind: 'reality' },
    ])
  })
})

describe('harborChampion / harborChallenger', () => {
  const def = loadPack(PACK)
  const book = bookOf(def)
  const opts = { set: 'holdout' as const, metric: 'reward' }

  it('names the agent/model as the route, the job id as optimizer_config_sha, the declared skills as the skill, the job truth as the snapshot', () => {
    const oracle = readHarborJob(ORACLE)
    const p = harborChampion(oracle, def, book, opts)
    expect(p).toMatchObject({
      parent_ids: [], patch_sha: sha256(''), harness_sha: sha256(canonicalJson(oracle.agent)), skill_sha: sha256(canonicalJson([])),
      taskset_sha: book.tasksetSha('holdout'),
      route: { loop: 'harbor:oracle@1.0.0', loop_adapter_version: '1.0.0', model_id: '', model_pool_sha: sha256(canonicalJson({ provider: '', model: '' })), base_url_kind: 'direct' },
      optimizer_config_sha: sha256(ORACLE_JOB_ID), lineage: 'main', surface: 'skill', patch: { skill_ref: `skill:${sha256(canonicalJson([]))}` }, intent: 'champion',
      prediction: { metric: 'reward', direction: 'up' }, pack: 'harborpack', scorer_version: '0', task_version: 0,
      truth_snapshot_id: book.tasksetSha('holdout'), report_rule_version: '0', runtime: { timeout_s: 0, step_cap: 0 },
      tasksets: { smoke: book.tasksetSha('smoke'), holdin: book.tasksetSha('holdin'), holdout: book.tasksetSha('holdout') }, budget: 4,
    })
    // The same set run by another job: the same truth (the scores carry the task checksums). Another agent: another harness, route and model.
    const variant = readHarborJob(VARIANT)
    const v = harborChampion(variant, def, book, opts)
    expect(v.truth_snapshot_id).toBe(p.truth_snapshot_id)
    expect(v.harness_sha).toBe(p.harness_sha)
    expect(v.env_sha).toBe(p.env_sha)
    expect(v.route).toEqual(p.route)
    expect(v.skill_sha).toBe(sha256(canonicalJson(['skills/terse'])))
    expect(v.optimizer_config_sha).not.toBe(p.optimizer_config_sha)
    const o = harborChampion(readHarborJob(OTHER), def, book, opts)
    expect(o.harness_sha).not.toBe(p.harness_sha)
    expect(o.route).toMatchObject({ loop: 'harbor:other@0.1.0', model_id: 'model-x', model_pool_sha: sha256(canonicalJson({ provider: 'prov', model: 'model-x' })) })
    expect(o.env_sha).not.toBe(p.env_sha)
    // A job on some of the set's tasks: the set's truth still, so it judges against a job on all of them.
    expect(o.truth_snapshot_id).toBe(p.truth_snapshot_id)
  })

  it('a challenger is the job\'s own coordinates under the champion, the given directory as the scope\'s skill; its snapshot\'s hash as the skill and patch sha when there is one', () => {
    const variant = readHarborJob(VARIANT)
    const c = harborChallenger(variant, def, book, 'champ', 'skill:before', { ...opts, intent: 'terse', skillDir: '/tmp/empty' })
    expect(c).toMatchObject({ parent_ids: ['champ'], patch_sha: c.skill_sha, skill_sha: sha256(canonicalJson(['skills/terse'])), patch: { skill_ref: '/tmp/empty', before: 'skill:before' }, intent: 'terse', prediction: { metric: 'reward', direction: 'up' } })
    const { parent_ids: _p, patch_sha: _s, patch: _q, intent: _i, ...rest } = c
    const { parent_ids: _p2, patch_sha: _s2, patch: _q2, intent: _i2, ...own } = harborChampion(variant, def, book, opts)
    expect(rest).toEqual(own)
    const snap = harborChallenger(variant, def, book, 'champ', 'skill:before', { ...opts, intent: 'terse', skillDir: '/tmp/snap', skillSha: sha256('snapshot') })
    expect(snap).toMatchObject({ patch_sha: sha256('snapshot'), skill_sha: sha256('snapshot'), patch: { skill_ref: '/tmp/snap', before: 'skill:before' } })
  })
})

describe('snapshotHarborSkills', () => {
  it('copies the declared sources in Harbor\'s layout (a SKILL.md directory is one skill, else each child directory; a later source wins a name) and hashes the snapshot', () => {
    const root = tmp('skills')
    const terse = writeSkill(resolve(root, 'terse'), '# terse\n', { 'notes.md': 'short\n' })
    const many = resolve(root, 'many')
    writeSkill(resolve(many, 'neat'), '# neat\n')
    writeSkill(resolve(many, 'terse'), '# terse, again\n')
    mkdirSync(resolve(many, '.git'))
    const job = readHarborJob(withSkills(VARIANT, 'snapshot', [terse, many]))
    const dest = tmp('dest')
    const out = snapshotHarborSkills(job, dest)
    expect(out).toEqual({ sha: hashDir(dest) })
    expect(readFileSync(resolve(dest, 'terse', 'SKILL.md'), 'utf8')).toBe('# terse, again\n')
    expect(existsSync(resolve(dest, 'terse', 'notes.md'))).toBe(false)
    expect(readFileSync(resolve(dest, 'neat', 'SKILL.md'), 'utf8')).toBe('# neat\n')
    expect(existsSync(resolve(dest, '.git'))).toBe(false)
    // No skills declared: an empty snapshot, hashed. A source not on this machine: nothing copied, the sources named.
    const none = tmp('none')
    expect(snapshotHarborSkills(readHarborJob(ORACLE), none)).toEqual({ sha: hashDir(none) })
    const gone = tmp('gone')
    expect(snapshotHarborSkills(readHarborJob(withSkills(VARIANT, 'missing', [terse, resolve(root, 'nowhere')])), gone)).toEqual({ missing: [resolve(root, 'nowhere')] })
    expect(existsSync(resolve(gone, 'terse'))).toBe(false)
    expect(snapshotHarborSkills(readHarborJob(VARIANT), tmp('relative'))).toEqual({ missing: [resolve('skills/terse')] })
  })
})

describe('import harbor', () => {
  function req(jobDir: string, as: ImportHarborRequest['as'], over: Partial<ImportHarborRequest> = {}): ImportHarborRequest {
    return { jobDir, pack: PACK, as, metric: 'reward', set: 'holdout', allowSubset: false, nEffFloor: 3, out: tmp('out'), ...over }
  }
  async function open() {
    const replay = new HarborReplay()
    const h = await openHarness({ executor: replay })
    const log: string[] = []
    return { h, log, deps: { ledger: h.ledger, lifecycle: h.lifecycle, replay, log: (line: string) => { log.push(line) } } }
  }

  it('--as champion: the champion row of the job and its trials as attempts + scores on the tier; a second import lands on the same row', async () => {
    const { h, deps, log } = await open()
    const r = await importHarbor(req(ORACLE, 'champion'), deps)
    expect(r).toMatchObject({ as: 'champion', job: { id: ORACLE_JOB_ID, dir: ORACLE, loop: 'harbor:oracle@1.0.0', trials: 9, tasks: ['o1', 'o2', 'o3'], skipped: [] }, tier: 'holdout', attempts: 9, scores: 9 })
    const row = h.ledger.challenger(r.championId)!
    expect(row).toMatchObject({ parent_ids: [], pack: 'harborpack', status: 'proposed', route: { loop: 'harbor:oracle@1.0.0' }, optimizer_config_sha: sha256(ORACLE_JOB_ID), prediction: { metric: 'reward' } })
    const attempts = h.ledger.attemptsOf(r.championId)
    expect(attempts).toHaveLength(9)
    expect(attempts.every((a) => a.tier === 'holdout' && a.loop === 'harbor:oracle@1.0.0' && a.status === 'COMPLETED')).toBe(true)
    expect(attempts.filter((a) => a.task_id === 'o2').map((a) => a.sample).sort()).toEqual([0, 1, 2])
    expect(h.ledger.scoresOf(attempts[0]!.id)).toEqual([{ attempt_id: attempts[0]!.id, scorer_version: '0', truth_snapshot_id: checksum('o1'), metric: 'reward', value: 1, kind: 'reality' }])
    expect(h.ledger.rounds.size).toBe(0)
    expect(log[0]).toBe(`job ${ORACLE_JOB_ID}: 9 trial(s) on 3 task(s) by harbor:oracle@1.0.0 in docker`)
    const text = formatImportHarbor(r)
    expect(text).toContain(`import harbor ${ORACLE_JOB_ID}  as champion`)
    expect(text).toContain('           9 trial(s) on 3 task(s) via harbor:oracle@1.0.0')
    expect(text).toContain(`recorded   9 attempt(s), 9 score row(s) on tier holdout under ${r.championId}`)
    expect(text).toContain(`champion   ${r.championId}`)
    const again = await importHarbor(req(ORACLE, 'champion'), deps)
    expect(again.championId).toBe(r.championId)
    expect(h.ledger.attemptsOf(r.championId)).toHaveLength(9)
  })

  it('refuses a job on none of the set\'s tasks; --allow-subset accepts a job that ran some of them', async () => {
    const { h, deps } = await open()
    await expect(importHarbor(req(ORACLE, 'champion', { set: 'holdin' }), deps)).rejects.toThrow(/ran none of the pack's holdin tasks \(it ran o1, o2, o3\)/)
    await expect(importHarbor(req(OTHER, 'champion'), deps)).rejects.toThrow(/ran 2 of the 3 holdout tasks \(missing o3\); pass --allow-subset/)
    expect(h.ledger.challengers.size).toBe(0)
    const r = await importHarbor(req(OTHER, 'champion', { allowSubset: true }), deps)
    expect(r).toMatchObject({ attempts: 4, scores: 3, job: { tasks: ['o1', 'o2'] } })
    expect(h.ledger.attemptsOf(r.championId).map((a) => a.status).sort()).toEqual(['COMPLETED', 'COMPLETED', 'COMPLETED', 'FAILED'])
  })

  it('a job that also ran tasks outside the set (a whole dataset) imports its trials on the set; the rest are skipped', async () => {
    const { h, deps, log } = await open()
    const job = tmp('dataset')
    cpSync(ORACLE, job, { recursive: true })
    cpSync(resolve(ORACLE, 'o1__ora0000'), resolve(job, 'zz__ora0000'), { recursive: true })
    const file = resolve(job, 'zz__ora0000', 'result.json')
    const result = JSON.parse(readFileSync(file, 'utf8')) as TrialResult
    Object.assign(result, { task_name: 'zz', trial_name: 'zz__ora0000', id: '00000000-0000-0000-0000-000000000000', task_checksum: checksum('zz') })
    writeFileSync(file, JSON.stringify(result))
    const r = await importHarbor(req(job, 'champion'), deps)
    expect(r).toMatchObject({ attempts: 9, scores: 9, job: { trials: 9, tasks: ['o1', 'o2', 'o3'], skipped: ['zz__ora0000'] } })
    expect(h.ledger.attemptsOf(r.championId).map((a) => a.task_id)).not.toContain('zz')
    expect(log).toContain(`job ${ORACLE_JOB_ID}: 9 trial(s) on 3 task(s) by harbor:oracle@1.0.0 in docker; skipped zz__ora0000`)
    expect(log).toContain('1 trial(s) on tasks outside the holdout set skipped')
    expect(formatImportHarbor(r)).toContain('9 trial(s) on 3 task(s) via harbor:oracle@1.0.0; skipped zz__ora0000')
    // The same job as a noise floor of holdout: 3 trials per task on the set, the task outside it not counted.
    const floor = await importHarbor(req(job, 'noise-floor'), deps)
    expect(floor.floor).toMatchObject({ n_reruns: 3, n_tasks: 3 })
  })

  it('--as noise-floor: the floor of a job with >= 3 trials per task, measured as calibrate measures it, under the job\'s champion row', async () => {
    const { h, deps } = await open()
    const r = await importHarbor(req(ORACLE, 'noise-floor'), deps)
    // Per entity (one task each): o1 [1, 1, 1], o2 [1, 0, 1], o3 [0, 1, 1]; the paired differences between every two reruns.
    const diffs = [0, 0, 0, -1, 0, 1, 1, 1, 0]
    expect(r.floor).toMatchObject({ champion_id: r.championId, loop: 'harbor:oracle@1.0.0', metric: 'reward', unit: 'entity', sd_paired: sd(diffs), n_reruns: 3, n_tasks: 3, tier: 'holdout' })
    expect(r.floor!.sd_paired).toBeGreaterThan(0)
    expect(h.ledger.floors.get(r.floor!.id)).toEqual(r.floor)
    expect(h.ledger.attemptsOf(r.championId)).toHaveLength(9)
    expect(h.ledger.noiseFloorFor(r.floor!.eval_config_sha, r.championId, 'harbor:oracle@1.0.0', 'reward')).toEqual(r.floor)
    expect(formatImportHarbor(r)).toContain(`noise floor ${r.floor!.id}`)
    expect(formatStatus(h.lifecycle.status())).toContain('noise floors 1')
    await expect(importHarbor(req(VARIANT, 'noise-floor'), deps)).rejects.toThrow(/at least 3 trials per task \(S1\); job .* has 2/)
  })

  it('--as challenger: the same agent run again is proposed under the champion, run through the replay, judged at holdout under the floor, decided', async () => {
    const { h, deps } = await open()
    const champion = await importHarbor(req(ORACLE, 'noise-floor'), deps)
    const out = tmp('challenger')
    const r = await importHarbor(req(VARIANT, 'challenger', { out, intent: 'terse skill' }), deps)
    expect(r).toMatchObject({ as: 'challenger', championId: champion.championId, attempts: 6, scores: 12 })
    const c = r.challenge!
    expect(c.championId).toBe(champion.championId)
    const row = h.ledger.challenger(c.challengerId)!
    expect(row).toMatchObject({ parent_ids: [champion.championId], intent: 'terse skill', status: 'judged', tier_reached: 'holdout', route: { loop: 'harbor:oracle@1.0.0' }, skill_sha: sha256(canonicalJson(['skills/terse'])) })
    expect(row.verdict).toMatchObject({ round_id: c.roundId })
    // The job's skill source is not on this machine: the scope opened on an empty directory under --out, the row's skill
    // stays the declared sources and cannot be promoted, so the round closed without a decision.
    const skillDir = resolve(out, `harbor-${r.job.id}`, 'skill')
    expect(existsSync(skillDir)).toBe(true)
    expect(h.scopes.opened.map((s) => s.patch)).toEqual([{ surface: 'skill', skill_dir: skillDir, mount: 'skill' }])
    expect(r.missingSkills).toEqual([resolve('skills/terse')])
    expect(h.ledger.round(c.roundId)!.status).toBe('decided')
    expect(h.champion.promoted).toEqual([])
    // The replay recorded the trials under the challenger on the tier; nothing ran.
    const attempts = h.ledger.attemptsOf(c.challengerId)
    expect(attempts).toHaveLength(6)
    expect(attempts.every((a) => a.tier === 'holdout')).toBe(true)
    expect(r.challenge!.challenger!.attemptsPath).toBe(VARIANT)
    // The compare row: paired on every (task, sample) the job ran against the champion, under the round's gate and the floor.
    const compare = c.compare!
    expect(compare).toMatchObject({ challenger_id: c.challengerId, vs_id: champion.championId, tier: 'holdout', round_id: c.roundId, sd_source: 'noise_floor', shadow: false })
    expect(compare.per_task).toHaveLength(6)
    expect(new Set(compare.per_task.map((d) => d.task_id)).size).toBe(3)
    expect(h.ledger.comparesOf(c.challengerId)).toHaveLength(1)
    expect(h.ledger.round(c.roundId)).toMatchObject({ champion_id: champion.championId, sibling_ids: [c.challengerId], noise_floor_id: champion.floor!.id })
    expect(c.outcome).toBeDefined()
    const text = formatImportHarbor(r)
    expect(text).toContain(`challenger ${c.challengerId}`)
    expect(text).toContain(`verdict    ${compare.verdict.value}  rule ${compare.rule_fired}`)
    expect(text).toContain('decision   round decided')
    expect(text).toContain(`skills     ${resolve('skills/terse')} not on this machine: no snapshot, so the challenger cannot be promoted`)
  })

  it('--as challenger with the job\'s skills on this machine: the scope opens on their snapshot, its hash is the row\'s skill_sha, the round is decided', async () => {
    const { h, deps, log } = await open()
    await importHarbor(req(ORACLE, 'noise-floor'), deps)
    const source = writeSkill(resolve(tmp('skills'), 'terse'), '# terse\n')
    const out = tmp('challenger')
    const r = await importHarbor(req(withSkills(VARIANT, 'local-skills', [source]), 'challenger', { out }), deps)
    const c = r.challenge!
    const skillDir = resolve(out, `harbor-${r.job.id}`, 'skill')
    expect(readFileSync(resolve(skillDir, 'terse', 'SKILL.md'), 'utf8')).toBe('# terse\n')
    expect(h.scopes.opened.map((s) => s.patch)).toEqual([{ surface: 'skill', skill_dir: skillDir, mount: 'skill' }])
    expect(h.ledger.challenger(c.challengerId)).toMatchObject({ status: 'judged', skill_sha: hashDir(skillDir), patch_sha: hashDir(skillDir), patch: { skill_ref: skillDir } })
    expect(r.missingSkills).toBeUndefined()
    expect(c.compare!.per_task).toHaveLength(6)
    expect(c.outcome).toBeDefined()
    expect(log.some((l) => l.includes('not on this machine'))).toBe(false)
    expect(formatImportHarbor(r)).not.toContain('skills     ')
  })

  it('--as challenger with a job on some of the set\'s tasks (--allow-subset) is judged against the champion on all of them, paired where both ran', async () => {
    const { deps } = await open()
    const champion = await importHarbor(req(ORACLE, 'noise-floor'), deps)
    const subset = tmp('subset')
    for (const t of ['o1__var0000', 'o1__var0001', 'o2__var0000', 'o2__var0001']) cpSync(resolve(VARIANT, t), resolve(subset, t), { recursive: true })
    const r = await importHarbor(req(subset, 'challenger', { allowSubset: true }), deps)
    expect(r).toMatchObject({ championId: champion.championId, attempts: 4, scores: 8 })
    expect(r.challenge!.compare!.per_task).toHaveLength(4)
    expect(new Set(r.challenge!.compare!.per_task.map((d) => d.task_id))).toEqual(new Set(['o1', 'o2']))
  })

  it('the same job in a second role: its attempts under the new row do not collide with the ones under the first', async () => {
    const { h, deps } = await open()
    const oracle = await importHarbor(req(ORACLE, 'noise-floor'), deps)
    const variant = await importHarbor(req(VARIANT, 'champion'), deps)
    expect(h.ledger.attempts.size).toBe(15)
    const r = await importHarbor(req(VARIANT, 'challenger', { champion: oracle.championId }), deps)
    const c = r.challenge!
    expect(c.championId).toBe(oracle.championId)
    expect(c.invalid).toBeUndefined()
    expect(c.compare!.per_task).toHaveLength(6)
    expect(h.ledger.attempts.size).toBe(21)
    expect(h.ledger.attemptsOf(variant.championId)).toHaveLength(6)
    expect(h.ledger.attemptsOf(c.challengerId)).toHaveLength(6)
    expect(h.ledger.challenger(c.challengerId)!.status).toBe('judged')
  })

  it('--as challenger needs a champion with the job\'s coordinates on the ledger, or --champion; another agent is NOT_COMPARABLE', async () => {
    const { h, deps } = await open()
    await expect(importHarbor(req(VARIANT, 'challenger'), deps)).rejects.toThrow(/no champion on the ledger with this job's coordinates \(harbor:oracle@1.0.0 on harborpack holdout\); import the champion job first/)
    const champion = await importHarbor(req(ORACLE, 'champion'), deps)
    await expect(importHarbor(req(OTHER, 'challenger', { allowSubset: true }), deps)).rejects.toThrow(/no champion on the ledger/)
    await expect(importHarbor(req(OTHER, 'challenger', { allowSubset: true, champion: champion.championId }), deps)).rejects.toMatchObject({ code: 'NOT_COMPARABLE', detail: { coordinate: 'harness_sha' } })
    await expect(importHarbor(req(OTHER, 'challenger', { allowSubset: true, champion: champion.championId }), deps)).rejects.toBeInstanceOf(LifecycleError)
    await expect(importHarbor(req(VARIANT, 'challenger', { champion: 'nope' }), deps)).rejects.toThrow(/no challenger nope/)
    expect(h.ledger.attempts.size).toBe(9)
  })

  it('--as challenger with more trials per task than the champion holds is invalid on the run invariant and closes its round', async () => {
    const { h, deps, log } = await open()
    await importHarbor(req(VARIANT, 'champion'), deps)
    const r = await importHarbor(req(ORACLE, 'challenger'), deps)
    const c = r.challenge!
    expect(c.invalid).toBe('coordinates:facts')
    expect(c.compare).toBeUndefined()
    expect(h.ledger.challenger(c.challengerId)).toMatchObject({ status: 'judged', verdict: { value: 'invalid', rule: 'coordinates:facts' } })
    expect(h.ledger.round(c.roundId)!.status).toBe('decided')
    expect(log.some((l) => l.includes('nothing imported for'))).toBe(true)
    expect(log.some((l) => l.includes('import a champion job of the same agent with as many trials per task'))).toBe(true)
    expect(formatImportHarbor(r)).toContain('verdict    invalid  rule coordinates:facts')
  })
})

describe('startup: import harbor', () => {
  function parse(argv: string[]): { values?: SamsaraRunValues; error?: string } {
    let values: SamsaraRunValues | undefined
    const program = runProgram((v) => { values = v })
    const quiet = (c: typeof program) => { c.exitOverride().configureOutput({ writeErr: () => {}, writeOut: () => {} }); c.commands.forEach(quiet) }
    quiet(program)
    try {
      program.parse(argv, { from: 'user' })
    } catch (e) {
      return { error: (e as Error).message }
    }
    return values ? { values } : {}
  }

  it('parses the job directory, --as and the options with their defaults', () => {
    expect(parse(['import', 'harbor', 'jobs/a', '--pack', 'p', '--as', 'champion', '--metric', 'reward']).values)
      .toEqual({ command: 'import-harbor', jobDir: 'jobs/a', pack: 'p', as: 'champion', metric: 'reward', set: 'holdin', allowSubset: false, nEffFloor: DEFAULTS.nEffFloor, out: DEFAULTS.out })
    expect(parse(['import', 'harbor', 'jobs/b', '--pack', 'p', '--as', 'challenger', '--metric', 'reward', '--set', 'holdout', '--intent', 'i', '--allow-subset', '--champion', 'c', '--n-eff-floor', '5', '--out', '/o']).values)
      .toEqual({ command: 'import-harbor', jobDir: 'jobs/b', pack: 'p', as: 'challenger', metric: 'reward', set: 'holdout', intent: 'i', allowSubset: true, champion: 'c', nEffFloor: 5, out: '/o' })
    expect(parse(['import', 'harbor', 'jobs/a', '--pack', 'p', '--as', 'noise-floor', '--metric', 'reward']).values).toMatchObject({ as: 'noise-floor' })
    expect(parse(['import', 'harbor', 'jobs/a', '--pack', 'p', '--as', 'baseline', '--metric', 'reward']).error).toMatch(/--as must be one of champion\|challenger\|noise-floor/)
    expect(parse(['import', 'harbor', 'jobs/a', '--pack', 'p', '--as', 'champion']).error).toMatch(/--metric/)
    expect(parse(['import', 'harbor', '--pack', 'p', '--as', 'champion', '--metric', 'reward']).error).toMatch(/jobDir/)
  })
})
