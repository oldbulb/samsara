// A SpawnFn over node:child_process for tests that run a real fixture process:
// the same handle shape ctx.subprocess.spawn returns (collected readers, done,
// SIGTERM → graceMs → SIGKILL terminate). Tests only; the host spawns through dsh.
import { spawn as nodeSpawn } from 'node:child_process'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@oldbulb/samsara-kernel'

function reader(chunks: Buffer[]) {
  return { readFrom: (from: number) => { const text = Buffer.concat(chunks).toString('utf8'); return { text: text.slice(from), nextOffset: text.length, lossy: false } } }
}

export function realSpawn(spec: SubprocessSpawnSpec): SubprocessHandle {
  const [program, ...args] = spec.argv
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(spec.env ?? {})) if (v !== undefined) env[k] = v
  const child = nodeSpawn(program!, args, { cwd: spec.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout.on('data', (b: Buffer) => stdout.push(b))
  child.stderr.on('data', (b: Buffer) => stderr.push(b))
  const done = new Promise<SubprocessOutcome>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (exitCode, signal) => resolve({ exitCode, signal }))
  })
  let killer: NodeJS.Timeout | undefined
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
      child.kill('SIGTERM')
      killer ??= setTimeout(() => child.kill('SIGKILL'), spec.graceMs)
    },
    async waitForExit() {
      await done
      return true
    },
  }
}
