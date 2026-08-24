// Keyless regression test for the loops-dsh provider (M2): boot the real
// `dsh --profile host run` against a recorded model transcript served by
// @deepseek-ai/dsh-llm-replay. No model, no network: the llm-pi-ai adapter is
// disabled and re-pointed at an unroutable host by the overlay, and every
// assistant turn comes from tests/fixtures/replay/dsh-beer-song.
//
// Boot choice: (a) spawn the CLI with a rendered copy of replay.overlay.yml.
// The alternative (b) — an in-process Context with LlmRuntime +
// installLlmReplay + the loops-dsh plugin — would have to re-create most of
// dsh-base by hand (agents, sessions, presets, tools, persistence, sandbox …)
// and would still not exercise the profile/bundle composition the host runs.
//
// Skips (never fails) when the environment cannot run it: no `dsh` on PATH, no
// dsh-llm-replay package reachable, or the recording's submit tool name no
// longer matches the pack's (the skill was renamed after recording; replay
// serves chunks blindly, so the recorded `submit_<old>` call would hit an
// unknown tool and the script would be exhausted one step early).

import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'
import { loadPack } from '../../packages/pack/src/index.ts'
import { submitToolName } from '../../packages/runner/src/run.ts'
import { bindFixtureCwd } from './project-fixture.ts'

const ROOT = resolve(import.meta.dirname, '..', '..')
const PACK_DIR = join(ROOT, 'packs', 'coding-tasks')
const SCENARIO = 'dsh-beer-song'
/** Override to point the test at a different projected fixture (e.g. a fresh recording before committing it). */
const FIXTURE = process.env['SAMSARA_REPLAY_FIXTURE'] ?? join(ROOT, 'tests', 'fixtures', 'replay', SCENARIO, 'session.replay.jsonl')
const OVERLAY_TEMPLATE = join(import.meta.dirname, 'replay.overlay.yml')
const TASK_ID = 'python/beer-song'

/** The live attempt workdir, read from the runtime-context message of each request. */
const CWD_FROM_REQUEST = '{{fromRequest:session workspace: "([^"]+)"}}'

const RECORD_HINT = [
  'Re-record with the real model:',
  '  dsh --profile host --patch tests/replay/record.overlay.yml run --pack packs/coding-tasks --loop dsh --set smoke --limit 1 --out /tmp/samsara-record',
  `  cp /tmp/samsara-record-sessions/*/*/session.jsonl tests/fixtures/replay/${SCENARIO}/session.jsonl`,
  `  node tests/replay/project-fixture.ts tests/fixtures/replay/${SCENARIO}/session.jsonl`,
].join('\n')

/**
 * Where @deepseek-ai/dsh-llm-replay may live: env override, this workspace's own
 * devDependency (the normal case — `pnpm install` puts it there), the host
 * profile's store, or a sibling dsh checkout that has been built.
 */
function findLlmReplay(): string | undefined {
  const candidates = [
    process.env['SAMSARA_LLM_REPLAY'],
    join(ROOT, 'node_modules', '@deepseek-ai', 'dsh-llm-replay', 'lib', 'index.js'),
    join(homedir(), '.dsh', 'profiles', 'node_modules', '@deepseek-ai', 'dsh-llm-replay', 'lib', 'index.js'),
    join(ROOT, '..', 'deepseek-harness', 'packages', 'test-support', 'llm-replay', 'lib', 'index.js'),
  ]
  return candidates.find((p): p is string => p !== undefined && existsSync(p))
}

function findDsh(): string | undefined {
  try {
    return execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim() || undefined
  } catch {
    return undefined
  }
}

interface Row { type: string; data?: Record<string, unknown> }

function rows(text: string): Row[] {
  return text.split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l) as Row)
}

/** Tool names the recorded model called, in order. */
function recordedToolCalls(fixture: string): string[] {
  return rows(fixture).filter((r) => r.type === 'tool/call').map((r) => r.data?.['name'] as string)
}

function findFile(dir: string, name: string): string | undefined {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) {
      const hit = findFile(p, name)
      if (hit) return hit
    } else if (entry === name) return p
  }
  return undefined
}

describe('loops-dsh replays a recorded transcript through `dsh --profile host run`', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'samsara-replay-'))
  afterAll(() => { if (process.env['SAMSARA_REPLAY_KEEP'] === undefined) rmSync(tmp, { recursive: true, force: true }) })

  it(`${SCENARIO}: 1 attempt, COMPLETED, valid submit, pass_rate 1, no network`, { timeout: 180_000 }, async (ctx) => {
    const dsh = findDsh()
    if (!dsh) return ctx.skip('`dsh` is not on PATH (npm i -g @deepseek-ai/dsh@<pin>)')
    const llmReplay = findLlmReplay()
    if (!llmReplay) return ctx.skip('@deepseek-ai/dsh-llm-replay not found (set SAMSARA_LLM_REPLAY=<path to lib/index.js>)')

    // The recording must still match the live prompt surface: the model's
    // final call must target the submit tool the runner registers today.
    const fixture = readFileSync(FIXTURE, 'utf8')
    const recordedSubmit = recordedToolCalls(fixture).filter((n) => n.startsWith('submit_'))
    const liveSubmit = submitToolName(loadPack(PACK_DIR))
    if (!recordedSubmit.includes(liveSubmit)) {
      return ctx.skip(
        `fixture ${SCENARIO} was recorded against submit tool ${JSON.stringify(recordedSubmit)} but the pack now registers `
        + `${JSON.stringify(liveSubmit)} (pack.yaml skill.name changed after recording); replay would serve the recorded `
        + `${recordedSubmit[0] ?? 'submit'} call to an unknown tool and exhaust the script one step early.\n${RECORD_HINT}`,
      )
    }

    const sessions = join(tmp, 'sessions')
    const out = join(tmp, 'out')
    mkdirSync(sessions)
    const fixturePath = join(tmp, 'session.replay.jsonl')
    writeFileSync(fixturePath, bindFixtureCwd(fixture, CWD_FROM_REQUEST))
    const overlay = join(tmp, 'replay.overlay.yml')
    writeFileSync(
      overlay,
      readFileSync(OVERLAY_TEMPLATE, 'utf8')
        .replaceAll('{{sessions}}', sessions)
        .replaceAll('{{fixture}}', fixturePath)
        .replaceAll('{{llmReplay}}', llmReplay),
    )

    const env: NodeJS.ProcessEnv = { ...process.env, DSH_TELEMETRY_MODE: 'DISABLED' }
    delete env['LLM_GATEWAY_API_KEY']
    delete env['DSH_SNAPSHOT']
    delete env['DSH_SNAPSHOT_FILE']
    const args = ['--profile', 'host', '--patch', overlay, 'run', '--pack', PACK_DIR, '--loop', 'dsh', '--set', 'smoke', '--limit', '1', '--out', out]
    interface Exec { stdout?: string; stderr?: string; code?: number }
    const result: Exec = await promisify(execFile)(dsh, args, { cwd: tmp, env, maxBuffer: 64 * 1024 * 1024 })
      .catch((e: Exec) => e)
    expect(result.stderr ?? '', `dsh exited ${String(result.code ?? 0)}`).not.toMatch(/samsara-runner: |Error:/)
    expect(result.code ?? 0).toBe(0)

    const attempts = readFileSync(join(out, 'attempts.jsonl'), 'utf8').split('\n').filter(Boolean)
    expect(attempts).toHaveLength(1)
    const row = JSON.parse(attempts[0]!) as {
      task_id: string; status: string; stopReason: string; toolCalls: number
      output: { valid: boolean; file?: string }; truth: { status: string }
      scores: { metric: string; value: number; kind: string }[]; error?: string
    }
    expect(row.error).toBeUndefined()
    expect(row.task_id).toBe(TASK_ID)
    expect(row.status).toBe('COMPLETED')
    expect(row.stopReason).toBe('completed')
    expect(row.output.valid).toBe(true)
    expect(row.output.file?.endsWith(`/${liveSubmit}.json`)).toBe(true)
    expect(row.truth.status).toBe('settled')
    expect(row.scores.find((s) => s.metric === 'pass_rate')).toMatchObject({ value: 1, kind: 'reality' })

    // Every model turn came from the fixture: the replayed session carries the
    // recorded call sequence (finish chunk per step, same tool calls), and the
    // only adapter row was disabled — there was nothing else to answer.
    const log = findFile(sessions, 'session.jsonl')
    expect(log, 'replayed session log persisted under the test tmp dir').toBeDefined()
    const replayed = rows(readFileSync(log!, 'utf8'))
    const finishes = (r: Row[]) => r.filter((x) => x.type === 'assistant/chunk' && (x.data?.['chunk'] as Row | undefined)?.type === 'finish').length
    expect(finishes(replayed)).toBe(finishes(rows(fixture)))
    expect(recordedToolCalls(readFileSync(log!, 'utf8'))).toEqual(recordedToolCalls(fixture))
    expect(row.toolCalls).toBe(recordedToolCalls(fixture).length)
  })
})
