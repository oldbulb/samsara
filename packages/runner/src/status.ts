// `status`: one screen from ctx.lifecycle.status() — the champion, the rounds
// not yet decided, the promote consents pending, the latest noise floor per
// evaluation configuration, the experiments. Read-only.

import { refMethod, type LifecycleStatus } from '@oldbulb/samsara-lifecycle'

export function formatStatus(s: LifecycleStatus): string {
  const out = [`champion   ${s.champion.rows.join(', ') || '(none)'}${s.champion.skill_ref !== undefined ? `  skill ${s.champion.skill_ref}` : ''}`]
  out.push(`rounds     ${s.rounds.length} open`)
  for (const r of s.rounds) {
    out.push(`  ${r.id}  champion ${r.champion_id}  gate ${refMethod(r.gate)}  k ${r.k}  ${r.status}  opened ${r.opened_at}${r.experiment_id !== undefined ? `  experiment ${r.experiment_id}` : ''}`)
  }
  out.push(`pending    ${s.pending.length} consent(s)`)
  for (const p of s.pending) out.push(`  ${p.action} ${p.candidate}  round ${p.roundId}  (promote ${p.candidate} --wait <seconds>)`)
  out.push(`noise floors ${s.noiseFloors.length}`)
  for (const f of s.noiseFloors) {
    out.push(`  ${f.id}  champion ${f.champion_id}  loop ${f.loop}  metric ${f.metric}  sd_paired ${f.sd_paired.toFixed(4)}  reruns ${f.n_reruns}  tasks ${f.n_tasks}  tier ${f.tier}`)
  }
  out.push(`experiments ${s.experiments.length}`)
  for (const e of s.experiments) {
    const p = e.prediction
    out.push(`  ${e.id}  ${e.status}  ${p.metric} ${p.direction}${p.magnitude !== undefined ? ` by ${p.magnitude}` : ''}  rounds ${e.spent.rounds}/${e.budget.rounds ?? '-'}  usd ${e.spent.usd}/${e.budget.usd ?? '-'}  "${e.hypothesis}"`)
  }
  return out.join('\n')
}
