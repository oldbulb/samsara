// The Python proposer SDK's own tests (sdk/py/tests) run under `pnpm test`
// when python3 is on PATH — the SDK is standard-library only — so the
// SDK/parity contract they guard cannot drift silently; skipped without one,
// as packages/gate/tests/command.test.ts does for the Python gate example.
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '..')

function run(args: string[]): Promise<{ status: number | null; output: string }> {
  return new Promise((done) => {
    const child = spawn('python3', args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (d: Buffer) => { output += d.toString() })
    child.stderr.on('data', (d: Buffer) => { output += d.toString() })
    child.on('error', () => done({ status: null, output }))
    child.on('close', (status) => done({ status, output }))
  })
}

const hasPython = (await run(['--version'])).status === 0

describe('sdk/py', () => {
  if (!hasPython) it('is skipped: python3 is not on PATH', () => {})
  else it('passes its unittest suite', { timeout: 60_000 }, async () => {
    const { status, output } = await run(['-m', 'unittest', 'discover', '-s', 'sdk/py/tests'])
    expect(output).toMatch(/\nOK\b/)
    expect(status).toBe(0)
  })
})
