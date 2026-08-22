// samsara-runner: the cordis plugin that turns the parsed `samsaraRun` request
// into attempts. It waits for the loader so every loop provider has registered,
// resolves the route from agentDefaultModel + this plugin's config, runs the
// set sequentially, prints a summary, and exits through ctx.appExit.

import { resolve } from 'node:path'
import { Schema, type Context } from '@samsara/kernel'
import type {} from '@samsara/loops'
import { runSet, type RouteConfig } from './run.ts'
import { formatSummary } from './summary.ts'
import { SAMSARA_RUN_SERVICE, type SamsaraRunValues } from './startup.ts'

export const name = 'samsara-runner'
export const inject = [SAMSARA_RUN_SERVICE, 'loops', 'agentDefaultModel']

export interface Config {
  /** Per-attempt base URL handed to the loop (route.baseUrl); empty = provider default. */
  baseUrl?: string
  /** Credential reference resolved by the loop through ctx.credentials (E5); never a secret. */
  credentialRef?: string
  /** Optional lane tag forwarded under route.reasoning.lane for proxies that key on it. */
  lane?: string
}

export const Config: Schema<Config> = Schema.object({
  baseUrl: Schema.string(),
  credentialRef: Schema.string(),
  lane: Schema.string(),
})

export { runSet, readSubmit, submitToolName, sanitizeId, newRunId } from './run.ts'
export type { RunRequest, RunDeps, RunResult, AttemptRow, ScoreLine, RouteConfig, Loops, Materialize } from './run.ts'
export { summarize, formatSummary } from './summary.ts'

interface Io {
  stdout: { write(chunk: string): unknown }
  stderr: { write(chunk: string): unknown }
  exit(code: number): void
}

export const internals: { stdout: Io['stdout']; stderr: Io['stderr'] } = { stdout: process.stdout, stderr: process.stderr }

export function routeOf(selection: { provider: string; model: string; reasoningEffort?: unknown }, config: Config): RouteConfig {
  const reasoning: Record<string, unknown> = {}
  if (selection.reasoningEffort !== undefined) reasoning['effort'] = selection.reasoningEffort
  if (config.lane) reasoning['lane'] = config.lane
  return {
    provider: selection.provider,
    model: selection.model,
    credentialRef: config.credentialRef ?? '',
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    ...(Object.keys(reasoning).length ? { reasoning } : {}),
  }
}

async function run(ctx: Context, config: Config, io: Io): Promise<void> {
  // Loader siblings mount concurrently; wait for the whole tree so every loop
  // provider has registered before the first start().
  await ctx.get('loader')?.await()
  const req = ctx.get(SAMSARA_RUN_SERVICE) as SamsaraRunValues | undefined
  const loops = ctx.get('loops')
  const defaultModel = ctx.get('agentDefaultModel')
  if (req === undefined || loops === undefined || defaultModel === undefined) return
  if (loops.get(req.loop) === undefined) {
    throw new Error(`no loop provider named "${req.loop}" is registered (is its plugin enabled in the profile?)`)
  }
  const controller = new AbortController()
  const disposeAbort = ctx.effect(() => () => controller.abort('scope disposed'))
  try {
    const result = await runSet(
      { ...req, out: resolve(req.out) },
      {
        loops,
        route: routeOf(defaultModel.currentSelection(), config),
        signal: controller.signal,
        log: (line) => io.stderr.write(line + '\n'),
      },
    )
    io.stdout.write(formatSummary(result) + '\n')
    io.exit(0)
  } finally {
    disposeAbort()
  }
}

export function apply(ctx: Context, config: Config): void {
  const exit = ctx.get('appExit')
  if (exit === undefined) throw new Error('samsara-runner: the launcher must provide ctx.appExit before the tree mounts')
  const io: Io = { stdout: internals.stdout, stderr: internals.stderr, exit }
  void run(ctx, config, io).catch((error: unknown) => {
    io.stderr.write(`samsara-runner: ${error instanceof Error ? error.message : String(error)}\n`)
    io.exit(1)
  })
}
