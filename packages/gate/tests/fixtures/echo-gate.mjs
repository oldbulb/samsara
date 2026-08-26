// Test fixture: a node gate speaking the stdin/stdout contract of
// examples/gates/README.md. Pairs by (taskId, sample), promotes iff the mean
// delta > 0. Modes (argv[2]) make it misbehave on purpose:
//   sleep    — never answers (timeout)
//   slow     — answers after 1 s (the host must stay responsive meanwhile)
//   garbage  — prints something that is not a GateJudgement
//   exit     — writes stderr and exits 3
//   leak-env — reports process.env.SAMSARA_TEST_LEAK in ruleFired
import { stdin, stdout, stderr, env, exit } from 'node:process'

const mode = process.argv[2] ?? ''
if (mode === 'sleep') {
  setTimeout(() => {}, 60_000)
} else {
  let text = ''
  stdin.setEncoding('utf8')
  stdin.on('data', chunk => { text += chunk })
  stdin.on('end', () => {
    if (mode === 'garbage') { stdout.write('{"verdict":"promote"}\n'); return }
    if (mode === 'exit') { stderr.write('echo-gate: refusing on purpose\n'); exit(3) }
    const req = JSON.parse(text)
    const rows = xs => xs.filter(a => a.metric === req.primaryMetric && a.status !== 'ABORTED' && a.status !== 'FAILED')
    const champ = new Map(rows(req.champion).map(c => [`${c.taskId} ${c.sample}`, c]))
    const perTask = []
    for (const a of rows(req.challenger)) {
      const c = champ.get(`${a.taskId} ${a.sample}`)
      if (c) perTask.push({ taskId: a.taskId, entityKey: a.entityKey, sample: a.sample, delta: a.value - c.value })
    }
    const mean = perTask.length ? perTask.reduce((s, d) => s + d.delta, 0) / perTask.length : 0
    const nEff = new Set(perTask.map(d => d.entityKey)).size
    const ruleFired = mode === 'leak-env' ? `env:${env.SAMSARA_TEST_LEAK ?? 'absent'}` : 'echo:mean'
    const judgement = {
      compare: {
        perTask, mean, ci: [mean, mean], method: 'echo', clusterKey: 'entity', nEff, mde: 0,
        replicates: nEff ? perTask.length / new Set(perTask.map(d => d.taskId)).size : 0,
        minEffect: req.policy.mde ?? 0, holm: { adjustedAlpha: req.policy.alpha }, costRatio: 1,
        ladder: { step: 0, beatBest: mean > (req.bestSoFar ?? -Infinity) },
        counts: { paired: perTask.length, unpaired: 0, excluded: 0, validRate: 1 }, ruleFired,
      },
      verdict: perTask.length === 0 ? 'invalid' : mean > 0 ? 'promote' : 'hold',
    }
    const answer = () => stdout.write(JSON.stringify(judgement) + '\n')
    if (mode === 'slow') setTimeout(answer, 1000)
    else answer()
  })
}
