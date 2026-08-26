// A SpawnFn over node:child_process for tests that run a real process: the
// same handle shape ctx.subprocess.spawn returns (collected readers, done,
// SIGTERM → graceMs → SIGKILL terminate on the child's process group, `{ data }`
// stdin). Tests only; the host spawns through dsh.
import { spawn as nodeSpawn } from 'node:child_process'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@oldbulb/samsara-kernel'

function reader(chunks: Buffer[]) {
  return { readFrom: (from: number) => { const text = Buffer.concat(chunks).toString('utf8'); return { text: text.slice(from), nextOffset: text.length, lossy: false } } }
}

export function realSpawn(spec: SubprocessSpawnSpec): SubprocessHandle {
  const [program, ...args] = spec.argv
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(spec.env ?? {})) if (v !== undefined) env[k] = v
  const stdin = spec.stdio.stdin
  const child = nodeSpawn(program!, args, { cwd: spec.cwd, env, stdio: [stdin === 'ignore' ? 'ignore' : 'pipe', 'pipe', 'pipe'], detached: true })
  if (typeof stdin === 'object' && child.stdin) child.stdin.end(stdin.data)
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout!.on('data', (b: Buffer) => stdout.push(b))
  child.stderr!.on('data', (b: Buffer) => stderr.push(b))
  const done = new Promise<SubprocessOutcome>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (exitCode, signal) => resolve({ exitCode, signal }))
  })
  let killer: NodeJS.Timeout | undefined
  const signalGroup = (signal: NodeJS.Signals): void => {
    try { process.kill(-child.pid!, signal) } catch { child.kill(signal) }
  }
  done.then(() => clearTimeout(killer), () => clearTimeout(killer))
  return {
    pid: child.pid ?? -1,
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    collected: { stdout: reader(stdout), stderr: reader(stderr) },
    done,
    terminate() {
      if (child.exitCode !== null || child.signalCode !== null) return
      signalGroup('SIGTERM')
      killer ??= setTimeout(() => signalGroup('SIGKILL'), spec.graceMs)
    },
    async waitForExit() {
      await done
      return true
    },
  }
}
