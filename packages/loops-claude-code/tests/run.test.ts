// Full run lifecycle with the SDK `query` and the subprocess seam both faked:
// no process is spawned and no network is touched.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@samsara/kernel'
import { factsSha } from '@samsara/loops'
import { policyFor, type SandboxHost } from '@samsara/sandbox'

const UNENFORCED: SandboxHost = { platform: 'darwin', enforcement: 'unusable', launcher: '', exists: () => true }
import { ClaudeCodeLoopProvider } from '../src/index.ts'
import { startRun, type RunDeps } from '../src/run.ts'
import type { AttemptSpec, LoopEvent } from '../src/seam.ts'
import { resultMessage, stream } from './fixture.ts'

const SECRET = 'sk-secret-never-in-artifacts'

function fakeChild(): SubprocessHandle & { terminated: number } {
  let resolveDone!: (o: { exitCode: number | null; signal: NodeJS.Signals | null }) => void
  const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((r) => (resolveDone = r))
  const h = {
    pid: 4242,
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    collected: {} as never,
    done,
    terminated: 0,
    terminate() {
      h.terminated++
      resolveDone({ exitCode: null, signal: 'SIGTERM' })
    },
    async waitForExit() {
      await done
      return true
    },
  }
  return h as unknown as SubprocessHandle & { terminated: number }
}

function fakeQuery(messages: SDKMessage[], onSpawn: () => void, hang: AbortSignal | undefined): { q: Query; closed: () => boolean } {
  let closed = false
  onSpawn()
  const q = {
    async *[Symbol.asyncIterator]() {
      for (const m of messages) {
        if (closed) return
        yield m
      }
      // Like the real SDK: an open session ends only on abort or close.
      if (hang && !hang.aborted) await new Promise<void>((r) => hang.addEventListener('abort', () => r(), { once: true }))
    },
    close() {
      closed = true
    },
  }
  return { q: q as unknown as Query, closed: () => closed }
}

function makeSpec(root: string, signal = new AbortController().signal): AttemptSpec {
  const workdir = join(root, 'work')
  const skillDir = join(workdir, '.agents', 'skills', 'demo')
  const tmp = join(root, 'tmp')
  for (const d of [workdir, skillDir, tmp]) mkdirSync(d, { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: demo\n---\n# Demo skill\nDo the thing.\n')
  return {
    attemptId: 'att-1',
    challengerId: 'ch-1',
    workdir,
    skill: { name: 'demo', dir: skillDir, sha: 'abc' },
    prompt: 'Solve it.',
    route: { provider: 'anthropic', model: 'model-x', baseUrl: 'http://proxy.local/att-1', credentialRef: 'ROUTE_TOKEN' },
    outputSchema: {},
    tools: { allow: [], deny: [], submitTool: { name: 'submit_demo', schema: { type: 'object' } } },
    limits: { maxTurns: 5, maxDurationMs: 60_000 },
    tmpdir: tmp,
    signal,
  }
}

function deps(messages: SDKMessage[], capture: { child?: ReturnType<typeof fakeChild>; spawnSpec?: SubprocessSpawnSpec; queryOptions?: unknown; closed?: () => boolean }, hang = false): RunDeps {
  const disposers: (() => void)[] = []
  return {
    credentialValue: SECRET,
    graceMs: 100,
    ctx: {
      effect: (fn: () => unknown) => {
        const d = fn() as () => void
        disposers.push(d)
        return d
      },
      subprocess: {
        spawn: (s: SubprocessSpawnSpec) => {
          capture.spawnSpec = s
          capture.child = fakeChild()
          return capture.child
        },
      },
    } as unknown as RunDeps['ctx'],
    queryFn: ((params: { options?: { spawnClaudeCodeProcess?: (o: unknown) => unknown; abortController?: AbortController } }) => {
      capture.queryOptions = params.options
      const { q, closed } = fakeQuery(messages, () => {
        params.options?.spawnClaudeCodeProcess?.({ command: '/sdk/claude', args: ['-p'], cwd: '/work', env: { PATH: '/bin' } })
      }, hang ? params.options?.abortController?.signal : undefined)
      capture.closed = closed
      return q
    }) as unknown as RunDeps['queryFn'],
    // Tests that are not about the sandbox pin a host that cannot enforce, so a
    // Linux runner (where `apply` fails closed on a spec with no policy) sees the
    // same behaviour as a developer machine; the sandbox block below overrides it.
    host: UNENFORCED,
  }
}

async function collect(events: AsyncIterable<LoopEvent>): Promise<LoopEvent[]> {
  const out: LoopEvent[] = []
  for await (const e of events) out.push(e)
  return out
}

describe('sandbox', () => {
  const linux: SandboxHost = { platform: 'linux', enforcement: 'full', launcher: '/opt/landlock-run', exists: () => true }
  const mac = UNENFORCED

  it('spawns the CLI under the launcher with the attempt policy on an enforcing host', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lcc-'))
    const spec = makeSpec(root)
    spec.sandbox = policyFor({ workdir: spec.workdir, packDir: join(root, 'pack') })
    const cap: Parameters<typeof deps>[1] = {}
    const run = await startRun(spec, { ...deps(stream(), cap), host: linux })
    await run.result
    const argv = cap.spawnSpec!.argv
    expect(argv[0]).toBe('/opt/landlock-run')
    expect(argv.slice(argv.indexOf('--') + 1)).toEqual(['/sdk/claude', '-p'])
    expect(argv).toContain('--rw')
    expect(argv[argv.indexOf('--rw') + 1]).toBe(spec.workdir)
    expect(cap.spawnSpec!.cwd).toBe('/work')
    for (const d of spec.sandbox.denied) expect(argv).not.toContain(d)
  })

  it('leaves the spawn unchanged where nothing enforces, and fails closed on an enforcing host without a policy', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lcc-'))
    const cap: Parameters<typeof deps>[1] = {}
    const run = await startRun(makeSpec(root), { ...deps(stream(), cap), host: mac })
    await run.result
    expect(cap.spawnSpec!.argv).toEqual(['/sdk/claude', '-p'])
    await expect(startRun(makeSpec(root), { ...deps(stream(), {}), host: linux })).rejects.toThrow(/no sandbox policy/)
  })

  it('records the enforcement mode in the provider facts so it lands in facts_sha', () => {
    const ctx = { effect: () => () => {}, subprocess: { spawn: () => { throw new Error('unused') } }, credentials: { resolve: async () => undefined } }
    const onLinux = new ClaudeCodeLoopProvider(ctx as never, 100, linux)
    const onMac = new ClaudeCodeLoopProvider(ctx as never, 100, mac)
    expect(onLinux.harnessFacts.sandbox).toBe('landlock')
    expect(onMac.harnessFacts.sandbox).toBe('none')
    expect(factsSha(onLinux.harnessFacts)).not.toBe(factsSha(onMac.harnessFacts))
  })
})

describe('startRun', () => {
  it('runs a stream to completion with submit-tool output and a native transcript artifact', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lcc-'))
    const spec = makeSpec(root)
    const cap: Parameters<typeof deps>[1] = {}
    const messages = stream()
    // The agent "writes" its submit file before the result arrives.
    writeFileSync(join(spec.workdir, 'submit_demo.json'), JSON.stringify({ answer: 42 }))
    const run = await startRun(spec, deps(messages, cap))
    expect(run.id).toBe('att-1')
    const events = await collect(run.events)
    const finished = await run.result
    expect(events.map((e) => e.t)).toEqual(['started', 'system_prompt', 'tool_call', 'assistant', 'tool_result', 'assistant', 'output', 'finished'])
    expect(events.find((e) => e.t === 'output')).toMatchObject({ source: 'submit-tool', structured: { answer: 42 } })
    expect(finished).toMatchObject({
      status: 'COMPLETED',
      stopReason: 'completed',
      turns: 2,
      toolCalls: 1,
      usage: { inputTokens: 300, outputTokens: 60 },
      cost: { usd: 0.0123, source: 'self-reported' },
    })
    const art = finished.artifacts[0]!
    expect(art.kind).toBe('transcript-native')
    expect(art.path).toBe(join(spec.tmpdir, 'claude-stream.jsonl'))
    const raw = readFileSync(art.path, 'utf8')
    expect(raw.trim().split('\n')).toHaveLength(messages.length)
    expect(raw).not.toContain(SECRET)
    expect(JSON.stringify(finished)).not.toContain(SECRET)
    expect(JSON.stringify(events)).not.toContain(SECRET)

    // SDK options: system prompt preset + skill body + submit instruction; env carries the credential only there.
    const opts = cap.queryOptions as { systemPrompt: { type: string; preset: string; append: string }; env: Record<string, string>; maxTurns: number; permissionMode: string }
    expect(opts.systemPrompt.type).toBe('preset')
    expect(opts.systemPrompt.preset).toBe('claude_code')
    expect(opts.systemPrompt.append).toContain('# Demo skill')
    expect(opts.systemPrompt.append).not.toContain('name: demo')
    expect(opts.systemPrompt.append).toContain('submit_demo.json')
    expect(opts.env['ANTHROPIC_AUTH_TOKEN']).toBe(SECRET)
    expect(opts.env['ANTHROPIC_BASE_URL']).toBe('http://proxy.local/att-1')
    expect(opts.maxTurns).toBe(5)
    expect(opts.permissionMode).toBe('bypassPermissions')
    expect(cap.spawnSpec).toMatchObject({ argv: ['/sdk/claude', '-p'], cwd: '/work', graceMs: 100, stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' } })

    await run.dispose()
    await run.dispose()
    expect(cap.closed!()).toBe(true)
    expect(cap.child!.terminated).toBeGreaterThan(0)
    expect(existsSync(join(spec.tmpdir, 'claude-config'))).toBe(false)
    expect(existsSync(art.path)).toBe(true)
  })

  it('parsed-text output when no submit file; TRUNCATED on max turns', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lcc-'))
    const spec = makeSpec(root)
    const run = await startRun(spec, deps([resultMessage('error_max_turns')], {}))
    const events = await collect(run.events)
    expect(events.find((e) => e.t === 'output')).toMatchObject({ source: 'parsed-text', text: '' })
    expect(await run.result).toMatchObject({ status: 'TRUNCATED', stopReason: 'max_turns' })
    await run.dispose()
  })

  it('cancel → ABORTED; stream without result → FAILED', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lcc-'))
    const spec = makeSpec(root)
    const run = await startRun(spec, deps([], {}, true))
    run.cancel('test')
    expect(await run.result).toMatchObject({ status: 'ABORTED', stopReason: 'aborted' })
    await run.dispose()

    const run2 = await startRun(makeSpec(mkdtempSync(join(tmpdir(), 'lcc-'))), deps([], {}))
    expect(await run2.result).toMatchObject({ status: 'FAILED', stopReason: 'error', cost: { source: 'unknown' } })
    await run2.dispose()
  })

  it('times out → TRUNCATED/timeout', async () => {
    const spec = makeSpec(mkdtempSync(join(tmpdir(), 'lcc-')))
    spec.limits.maxDurationMs = 20
    const run = await startRun(spec, deps([], {}, true))
    expect(await run.result).toMatchObject({ status: 'TRUNCATED', stopReason: 'timeout' })
    await run.dispose()
  })

  it('rejects before publication when the attempt signal is already aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    await expect(startRun(makeSpec(mkdtempSync(join(tmpdir(), 'lcc-')), ac.signal), deps([], {}))).rejects.toThrow(/aborted/)
  })
})
