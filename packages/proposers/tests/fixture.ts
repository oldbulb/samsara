import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@oldbulb/samsara-kernel'

export function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'samsara-proposers-'))
}

export function writeSkill(dir: string, body = '---\nname: demo\n---\n# Demo\nDo it.\n'): string {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), body)
  return dir
}

export interface FakeHandle extends SubprocessHandle {
  terminated: number
  settle(outcome: SubprocessOutcome): void
}

export function fakeHandle(stdout = '', stderr = ''): FakeHandle {
  let resolveDone!: (o: SubprocessOutcome) => void
  const done = new Promise<SubprocessOutcome>((r) => (resolveDone = r))
  const reader = (text: string) => ({ readFrom: (from: number) => ({ text: text.slice(from), nextOffset: text.length, lossy: false }) })
  const h: FakeHandle = {
    pid: 4242,
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    collected: { stdout: reader(stdout), stderr: reader(stderr) },
    done,
    terminated: 0,
    settle: (o) => resolveDone(o),
    terminate() {
      h.terminated++
      resolveDone({ exitCode: null, signal: 'SIGTERM' })
    },
    async waitForExit() {
      await done
      return true
    },
  }
  return h
}

export interface SpawnRecord {
  spec: SubprocessSpawnSpec
  handle: FakeHandle
}

/** A spawn function whose behaviour is chosen per argv: `--version` answers immediately; the proposal run calls `onRun`. */
export function fakeSpawn(onRun: (spec: SubprocessSpawnSpec, handle: FakeHandle) => void, version = '2.1.240 (Claude Code)\n') {
  const records: SpawnRecord[] = []
  const spawn = (spec: SubprocessSpawnSpec) => {
    if (spec.argv[1] === '--version') {
      const handle = fakeHandle(version)
      records.push({ spec, handle })
      handle.settle({ exitCode: 0, signal: null })
      return handle
    }
    const handle = fakeHandle('{"type":"result"}')
    records.push({ spec, handle })
    onRun(spec, handle)
    return handle
  }
  return { spawn, records }
}
