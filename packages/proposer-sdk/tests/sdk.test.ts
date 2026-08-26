// Round trip on a fixture view: load it, write a proposal (with a copied skill),
// read it back through the same validator. No process, no network.
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ProposalError, VIEW_VERSION, ViewError, loadView, parseArgs, validateProposal, writeProposal, type Proposal } from '../src/index.ts'

const FIXTURE = fileURLToPath(new URL('./fixtures/view', import.meta.url))

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'samsara-proposer-sdk-'))
}

const proposal: Proposal = {
  surface: 'skill',
  patch: { surface: 'skill', skill_dir: '/elsewhere' },
  intent: 'Tighten the checklist.',
  prediction: { metric: 'pass', direction: 'up', predicted_fixes: ['t2'], at_risk: ['t1'] },
}

describe('loadView', () => {
  it('reads view.json, the champion, the skill directory and every jsonl file', () => {
    const view = loadView(FIXTURE)
    expect(view.viewVersion).toBe(VIEW_VERSION)
    expect(view.championId).toBe('ch-champion')
    expect(view.metric).toBe('pass')
    expect(view.files).toContain('tasks.jsonl')
    expect(view.championSkillDir).toBe(join(FIXTURE, 'champion-skill'))
    expect(existsSync(join(view.championSkillDir, 'SKILL.md'))).toBe(true)
    expect(view.tasks.map((t) => t['task_id'])).toEqual(['t1', 't2', 't3'])
    expect(view.championAttempts).toHaveLength(3)
    expect(view.championScores.filter((s) => s['value'] === 0).map((s) => s['task_id'])).toEqual(['t2', 't3'])
    expect(view.compares[0]).toMatchObject({ redacted: true, tier: 'holdout', ladder: { beat_best: false, best_so_far: 0.05 } })
    expect(view.compares[0]).not.toHaveProperty('mean')
    expect(view.environment).toContain('demo-loop')
    expect(view.proposalSchema).toMatchObject({ required: ['surface', 'patch', 'intent', 'prediction'] })
  })

  it('infers the header from champion.json and the directory listing when view.json is absent', () => {
    const root = tempRoot()
    cpSync(FIXTURE, root, { recursive: true })
    rmSync(join(root, 'view.json'))
    rmSync(join(root, 'environment.md'))
    rmSync(join(root, 'proposal.schema.json'))
    const view = loadView(root)
    expect(view.viewVersion).toBe(VIEW_VERSION)
    expect(view.championId).toBe('ch-champion')
    expect(view.metric).toBe('pass')
    expect(view.files).toEqual(['champion-attempts.jsonl', 'champion-scores.jsonl', 'champion-skill', 'champion.json', 'compares.jsonl', 'tasks.jsonl'])
    expect(view.environment).toBeUndefined()
    expect(view.proposalSchema).toBeUndefined()
  })

  it('rejects a missing directory, a foreign view_version, a broken jsonl line and a champion without SKILL.md', () => {
    expect(() => loadView(join(FIXTURE, 'nope'))).toThrow(ViewError)
    const root = tempRoot()
    cpSync(FIXTURE, root, { recursive: true })
    writeFileSync(join(root, 'view.json'), JSON.stringify({ view_version: 2, champion_id: 'c', metric: 'pass', files: [] }))
    expect(() => loadView(root)).toThrow(/view_version 2/)
    rmSync(join(root, 'view.json'))
    writeFileSync(join(root, 'tasks.jsonl'), '{"task_id":"t1"}\nnot json\n')
    expect(() => loadView(root)).toThrow(/tasks.jsonl:2/)
    writeFileSync(join(root, 'tasks.jsonl'), '')
    rmSync(join(root, 'champion-skill', 'SKILL.md'))
    expect(() => loadView(root)).toThrow(/SKILL.md/)
  })
})

describe('validateProposal', () => {
  it('accepts a skill draft with or without parent, and a rows draft', () => {
    expect(validateProposal(proposal)).toEqual(proposal)
    expect(validateProposal({ ...proposal, parent: 'ch-x' }).parent).toBe('ch-x')
    const rows = { ...proposal, surface: 'prompt', patch: { surface: 'prompt', rows: [{ id: 'r1', config: {} }] } }
    expect(validateProposal(rows).surface).toBe('prompt')
  })

  it('rejects missing fields, a bad direction, an unknown surface, a mismatched patch and extra keys', () => {
    for (const key of ['surface', 'patch', 'intent', 'prediction'] as const) {
      const { [key]: _drop, ...rest } = proposal
      expect(() => validateProposal(rest)).toThrow(ProposalError)
    }
    expect(() => validateProposal({ ...proposal, prediction: { metric: 'pass', direction: 'sideways' } })).toThrow(/direction/)
    expect(() => validateProposal({ ...proposal, surface: 'weights', patch: { surface: 'weights', rows: [{}] } })).toThrow(ProposalError)
    expect(() => validateProposal({ ...proposal, surface: 'prompt' })).toThrow(/does not match/)
    expect(() => validateProposal({ ...proposal, patch: { surface: 'prompt', rows: [] } })).toThrow(ProposalError)
    expect(() => validateProposal({ ...proposal, extra: 1 })).toThrow(ProposalError)
    expect(() => validateProposal({ ...proposal, proposer: { name: 'x', version: '1', config_sha: 'a'.repeat(64) } })).toThrow(ProposalError)
  })
})

describe('writeProposal', () => {
  it('copies the skill directory to out/skill, rewrites skill_dir and writes a valid proposal.json', () => {
    const view = loadView(FIXTURE)
    const out = join(tempRoot(), 'out')
    const path = writeProposal(out, proposal, { skillDir: view.championSkillDir })
    expect(path).toBe(join(out, 'proposal.json'))
    expect(readFileSync(join(out, 'skill', 'SKILL.md'), 'utf8')).toBe(readFileSync(join(view.championSkillDir, 'SKILL.md'), 'utf8'))
    const written = validateProposal(JSON.parse(readFileSync(path, 'utf8')))
    expect(written).toEqual({ ...proposal, patch: { surface: 'skill', skill_dir: 'skill' } })
  })

  it('writes a rows proposal as is, and refuses an invalid one or a skillDir without SKILL.md', () => {
    const out = join(tempRoot(), 'out')
    const rows: Proposal = { ...proposal, surface: 'prompt', patch: { surface: 'prompt', rows: [{ id: 'r1' }] } }
    writeProposal(out, rows)
    expect(JSON.parse(readFileSync(join(out, 'proposal.json'), 'utf8'))).toEqual(rows)
    expect(() => writeProposal(out, { ...proposal, intent: '' })).toThrow(ProposalError)
    expect(() => writeProposal(out, proposal, { skillDir: join(FIXTURE, 'nope') })).toThrow(/SKILL.md/)
    expect(() => writeProposal(out, rows, { skillDir: join(FIXTURE, 'champion-skill') })).toThrow(/surface "prompt"/)
  })
})

describe('parseArgs', () => {
  it('reads --view/--out in either spelling, keeps the rest, and requires both', () => {
    expect(parseArgs(['--view', '/v', '--out', '/o'])).toEqual({ view: '/v', out: '/o', rest: [] })
    expect(parseArgs(['--model', 'm', '--out=/o', '--view=/v', 'x'])).toEqual({ view: '/v', out: '/o', rest: ['--model', 'm', 'x'] })
    expect(() => parseArgs(['--view', '/v'])).toThrow(/--out/)
    expect(() => parseArgs(['--out', '/o'])).toThrow(/--view/)
    expect(() => parseArgs(['--view'])).toThrow(/--view needs/)
  })
})
