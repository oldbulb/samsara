// `campaign` wiring: one round through the service with the lifecycle
// package's scripted executor and fixture pack — the proposer resolved from
// ctx.proposers, the view rendered by this package with history.jsonl beside
// it, events on the log, the consent hook on a promote candidate.

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ConsentRow } from '@oldbulb/samsara-ledger'
import type { ProposerAdapter, ProposeInput } from '@oldbulb/samsara-proposers'
import { FakeExecutor, fakeLoops as fixtureLoops } from '../../lifecycle/tests/fakes.ts'
import { campaign, formatCampaign, type CampaignRequest } from '../src/campaign.ts'
import { calibrate } from '../src/calibrate.ts'
import { experimentNew } from '../src/experiment.ts'
import { consent, FIXTURE_PACK, openHarness, sha } from './harness.ts'


/** Copies the champion skill into its work directory and predicts the metric; records what it saw. */
function proposer(): ProposerAdapter & { inputs: ProposeInput[] } {
  const inputs: ProposeInput[] = []
  return {
    name: 'copier', version: '1', configSha: sha('copier'), inputs,
    async propose(input) {
      inputs.push(input)
      mkdirSync(join(input.workDir, 'skill'), { recursive: true })
      cpSync(join(input.viewDir, 'champion-skill'), join(input.workDir, 'skill'), { recursive: true })
      return {
        parent: input.parent!, surface: 'skill', patch: { surface: 'skill', skill_dir: 'skill' }, intent: 'a copy',
        prediction: { metric: 'm', direction: 'up' }, proposer: { name: 'copier', version: '1', config_sha: sha('copier') },
      }
    },
  }
}

async function setup(effect: number) {
  const executor = new FakeExecutor()
  const h = await openHarness({ executor, loops: fixtureLoops() as never })
  // The champion row has no parent; every challenger row does.
  executor.value = (id) => (h.ledger.challenger(id)?.parent_ids.length ? 0.5 + effect : 0.5)
  const out = mkdtempSync(resolve(tmpdir(), 'runner-campaign-'))
  const base = { pack: FIXTURE_PACK, loop: 'fake', out, maxTurns: 5, maxMinutes: 1 }
  // The champion row a round anchors on carries the set's taskset sha, so the floor is calibrated on the set the rounds render.
  await calibrate({ ...base, set: 'holdin', metric: 'm', reruns: 3, out: join(out, 'calibrate') }, h.deps())
  const e = await experimentNew({ pack: FIXTURE_PACK, hypothesis: 'h', metric: 'm', direction: 'up', budgetRounds: 3, nEffFloor: 1 }, { lifecycle: h.lifecycle, gate: h.gate })
  const adapter = proposer()
  const logs: string[] = []
  const req: CampaignRequest = { ...base, set: 'holdin', repeat: 1, experiment: e.id, proposer: 'copier', metric: 'm', nEffFloor: 1, rounds: 1, autoHoldout: true, stopOnPromote: true }
  const deps = (over: Partial<Parameters<typeof campaign>[1]> = {}) => ({ ...h.deps({ log: (l) => logs.push(l) }), proposers: { get: (n: string) => (n === 'copier' ? adapter : undefined) }, ...over })
  return { h, executor, e, adapter, logs, req, deps, out }
}

describe('campaign', () => {
  it('one round with no effect: view + history rendered, smoke → holdin → holdout judged, decided, stopped on max_rounds', async () => {
    const { h, e, adapter, logs, req, deps, out } = await setup(0)
    const r = await campaign(req, deps())
    expect(r.paused).toBeUndefined()
    expect(r).toMatchObject({ stopped: 'max_rounds', promoted: [] })
    expect(r.rounds).toHaveLength(1)
    const [round] = r.rounds
    // S8: the null diff at holdout under a powered design is indistinguishable from the champion — drop, not hold.
    expect(round).toMatchObject({ tier: 'holdout', verdict: 'drop' })
    expect(h.ledger.round(round!.roundId)).toMatchObject({ experiment_id: e.id, sibling_ids: [round!.challengerId], status: 'decided' })
    expect(h.ledger.experiment(e.id)).toMatchObject({ round_ids: [round!.roundId], spent: { rounds: 1, holdout_reveals: 1 } })
    // the proposer saw this package's view, with the campaign's history beside it (empty on the first round) and listed in the manifest
    expect(adapter.inputs).toHaveLength(1)
    const { viewDir, workDir } = adapter.inputs[0]!
    expect(viewDir).toBe(join(out, round!.roundId.slice(0, 12), 'view'))
    expect(workDir).toBe(join(out, round!.roundId.slice(0, 12), 'proposer'))
    expect(adapter.inputs[0]!.sandbox).toMatchObject({ readOnly: expect.arrayContaining([viewDir]) })
    expect(existsSync(join(viewDir, 'environment.md'))).toBe(true)
    expect(readFileSync(join(viewDir, 'history.jsonl'), 'utf8')).toBe('')
    expect(JSON.parse(readFileSync(join(viewDir, 'view.json'), 'utf8')).files).toContain('history.jsonl')
    expect(h.ledger.challenger(round!.challengerId!)).toMatchObject({ intent: 'a copy', optimizer_config_sha: sha('copier'), tier_reached: 'holdout', status: 'decided' })
    // the tiers, in order, on the log
    const judged = logs.filter((l) => l.includes(' judged at ')).map((l) => l.match(/ judged at (\w+)/)![1])
    expect(judged).toEqual(['smoke', 'holdin', 'holdout'])
    expect(logs.at(-1)).toContain('campaign stopped: max_rounds')
    const text = formatCampaign(r)
    expect(text).toContain('campaign   stopped: max_rounds')
    expect(text).toContain('promoted   (none)')
    expect(text).toContain(`  ${round!.roundId}  ${round!.challengerId}  holdout  drop`)
  })

  it('a promote candidate pauses without the consent hook; with it the round promotes and the campaign stops on the promotion', async () => {
    const { h, req, deps } = await setup(0.4)
    const paused = await campaign(req, deps())
    expect(paused).toMatchObject({ paused: 'consent', action: 'promote' })
    if (!paused.paused) throw new Error('unreachable')
    expect(h.ledger.round(paused.roundId)?.status).toBe('open')
    expect(formatCampaign(paused)).toContain(`campaign   paused: promote consent needed for ${paused.candidate} (round ${paused.roundId})`)

    // resumed on the same experiment: the open round continues; the hook signs the promote
    const asked: [string, string][] = []
    const sign = async (action: 'promote' | 'holdout_reveal', subject: string, roundId: string): Promise<ConsentRow> => {
      asked.push([action, subject])
      const row = consent(subject, action, undefined, action === 'promote' ? roundId : undefined)
      h.ledger.consents.push(row)
      return row
    }
    const r = await campaign(req, deps({ consent: sign }))
    expect(asked).toEqual([['promote', paused.candidate]])
    expect(r).toMatchObject({ stopped: 'promoted', promoted: [paused.candidate] })
    expect(h.champion.promoted).toEqual([[paused.candidate, `promote-${paused.candidate.slice(0, 6)}`]])
    expect(h.ledger.round(paused.roundId)).toMatchObject({ status: 'decided', outcome: { promoted: paused.candidate } })
    expect(formatCampaign(r)).toContain(`promoted   ${paused.candidate}`)
  })
})
