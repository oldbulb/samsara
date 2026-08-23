// samsara-runner: the cordis plugin that turns the parsed `samsaraRun` request
// into work. It waits for the loader so every loop provider has registered,
// resolves the route from agentDefaultModel + this plugin's config, dispatches
// on the command (run / challenge / round / certify / promote / demote / serve), prints a
// summary, and exits through ctx.appExit.

import { resolve } from 'node:path'
import { Schema, type Context } from '@samsara/kernel'
import type {} from '@samsara/loops'
import type {} from '@samsara/ledger'
import type {} from '@samsara/scope'
import type {} from '@samsara/gate'
import type {} from '@samsara/champion'
import type {} from '@samsara/proposers'
import type { ConsentRecord, Signoff } from '@samsara/signoff'
import { runSet, type RouteConfig } from './run.ts'
import { challenge, formatChallenge } from './challenge.ts'
import { round, formatRound } from './round.ts'
import { certify, formatCertify } from './certify.ts'
import { formatSummary } from './summary.ts'
import { SAMSARA_RUN_SERVICE, type SamsaraRunValues } from './startup.ts'

export const name = 'samsara-runner'
export const inject = [SAMSARA_RUN_SERVICE, 'loops', 'agentDefaultModel', 'ledger']

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

export { runSet, readSubmit, submitToolName, sanitizeId, newRunId, championProposal } from './run.ts'
export type { RunRequest, RunDeps, RunResult, AttemptRow, ScoreLine, RouteConfig, Loops, LedgerSink, Materialize } from './run.ts'
export { challenge, formatChallenge, challengerProposalOf, scoredAttemptsOf, GATE_PERMISSIVE } from './challenge.ts'
export type { ChallengeRequest, ChallengeDeps, ChallengeResult, GatePolicyName } from './challenge.ts'
export { round, formatRound, renderView } from './round.ts'
export type { RoundRequest, RoundDeps, RoundResult } from './round.ts'
export { certify, formatCertify, utilizationOf } from './certify.ts'
export type { CertifyRequest, CertifyDeps, CertifyResult, CertifyRow, CrossCheck } from './certify.ts'
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

/** A service the command needs beyond the plugin's inject list; absent means its row did not mount. */
function need<K extends 'scopes' | 'gate' | 'champion' | 'signoff' | 'proposers'>(ctx: Context, key: K): Context[K] {
  const v = ctx.get(key) as Context[K] | undefined
  if (v === undefined) throw new Error(`ctx.${key} is not mounted (is its row enabled in the profile, and did it start?)`)
  return v
}

/** Every consent confirmed over the socket becomes a ledger row. */
function recordConsents(ctx: Context, signoff: Signoff): () => void {
  return signoff.onConfirm((c: ConsentRecord) => {
    void ctx.ledger.recordConsent(c).catch(() => {})
  })
}

function waitForConsent(signoff: Signoff, challengerId: string, seconds: number): Promise<ConsentRecord> {
  return new Promise((resolve, reject) => {
    const off = signoff.onConfirm((c) => {
      if (c.challenger_id !== challengerId || c.action !== 'promote') return
      clearTimeout(timer)
      off()
      resolve(c)
    })
    const timer = setTimeout(() => {
      off()
      reject(new Error(`no promote consent for ${challengerId} arrived within ${seconds}s`))
    }, seconds * 1000)
  })
}

async function promote(ctx: Context, req: { challengerId: string; wait?: number }, io: Io): Promise<void> {
  const champion = need(ctx, 'champion')
  const { challengerId } = req
  let consent = ctx.ledger.consentsOf(challengerId).filter((c) => c.action === 'promote').sort((a, b) => (a.at < b.at ? 1 : -1))[0]
  if (!consent && req.wait !== undefined) {
    const signoff = need(ctx, 'signoff')
    await signoff.ready
    const pending = signoff.request(challengerId, 'promote')
    io.stderr.write(`sign-off pending on ${signoff.config.socketPath} until ${pending.expiresAt}; waiting ${req.wait}s\n`)
    const record = recordConsents(ctx, signoff)
    try {
      consent = await waitForConsent(signoff, challengerId, req.wait)
      await ctx.ledger.recordConsent(consent)
    } finally {
      record()
    }
  }
  if (!consent) {
    throw new Error(`no promote consent on the ledger for ${challengerId}; run \`promote ${challengerId} --wait <seconds>\` and confirm with samsara-signoff`)
  }
  const state = await champion.promote(challengerId, consent.id)
  const replay = champion.replayCheck()
  io.stdout.write(`promoted ${challengerId} with consent ${consent.id}\nkept: ${state.rows.join(', ') || '(none)'}\nreplay check: ${replay.equal ? 'ok' : `FAILED ${JSON.stringify(replay)}`}\n`)
}

async function demote(ctx: Context, req: { challengerId: string; reason: string }, io: Io): Promise<void> {
  const champion = need(ctx, 'champion')
  const state = await champion.demote(req.challengerId, req.reason)
  io.stdout.write(`demoted ${req.challengerId}\nkept: ${state.rows.join(', ') || '(none)'}\n`)
}

async function serve(ctx: Context, io: Io): Promise<void> {
  const signoff = need(ctx, 'signoff')
  await signoff.ready
  const record = recordConsents(ctx, signoff)
  const web = (ctx as unknown as { webServer?: { port?: number; host?: string } }).webServer
  const url = web?.port ? `http://${web.host ?? '127.0.0.1'}:${web.port}/samsara` : 'no web server mounted'
  io.stdout.write(`samsara host serving; ui ${url}; sign-off socket ${signoff.config.socketPath} (pid ${process.pid})\n`)
  try {
    await new Promise<void>((done) => {
      process.once('SIGTERM', () => done())
      process.once('SIGINT', () => done())
    })
  } finally {
    record()
  }
}

async function run(ctx: Context, config: Config, io: Io): Promise<void> {
  // Loader siblings mount concurrently; wait for the whole tree so every loop
  // provider has registered before the first start().
  await ctx.get('loader')?.await()
  const req = ctx.get(SAMSARA_RUN_SERVICE) as SamsaraRunValues | undefined
  const loops = ctx.get('loops')
  const defaultModel = ctx.get('agentDefaultModel')
  const ledger = ctx.get('ledger')
  if (req === undefined || loops === undefined || defaultModel === undefined || ledger === undefined) return

  if (req.command === 'promote') { await promote(ctx, req, io); io.exit(0); return }
  if (req.command === 'demote') { await demote(ctx, req, io); io.exit(0); return }
  if (req.command === 'serve') { await serve(ctx, io); io.exit(0); return }

  if (req.command !== 'certify' && loops.get(req.loop) === undefined) {
    throw new Error(`no loop provider named "${req.loop}" is registered (is its plugin enabled in the profile?)`)
  }
  const controller = new AbortController()
  const disposeAbort = ctx.effect(() => () => controller.abort('scope disposed'))
  // The champion's kept skill (promoted through the ledger + sign-off) is the default skill; the pack's is the fallback.
  const championSkillDir = ctx.get('champion')?.current().skill_ref
  const deps = {
    loops,
    ledger,
    route: routeOf(defaultModel.currentSelection(), config),
    signal: controller.signal,
    log: (line: string) => io.stderr.write(line + '\n'),
    ...(championSkillDir !== undefined ? { championSkillDir } : {}),
  }
  if (championSkillDir !== undefined) deps.log(`champion skill: ${championSkillDir}`)
  try {
    if (req.command === 'challenge') {
      const result = await challenge({ ...req, out: resolve(req.out) }, { ...deps, scopes: need(ctx, 'scopes'), gate: need(ctx, 'gate') })
      io.stdout.write(formatChallenge(result) + '\n')
    } else if (req.command === 'certify') {
      const result = await certify({ ...req, out: resolve(req.out) }, { ...deps, scopes: need(ctx, 'scopes'), gate: need(ctx, 'gate') })
      io.stdout.write(formatCertify(result) + '\n')
    } else if (req.command === 'round') {
      const result = await round({ ...req, out: resolve(req.out) }, { ...deps, scopes: need(ctx, 'scopes'), gate: need(ctx, 'gate'), proposers: need(ctx, 'proposers') })
      io.stdout.write(formatRound(result) + '\n')
    } else {
      const result = await runSet({ ...req, out: resolve(req.out) }, deps)
      io.stdout.write(formatSummary(result) + '\n')
    }
    io.exit(0)
  } finally {
    disposeAbort()
  }
}

/** Grace after the tree disposed before a stray handle is no longer allowed to keep the process alive. */
export const DRAIN_GRACE_MS = 3000

export function apply(ctx: Context, config: Config): void {
  const appExit = ctx.get('appExit')
  if (appExit === undefined) throw new Error('samsara-runner: the launcher must provide ctx.appExit before the tree mounts')
  let exitCode: number | undefined
  // A fast one-shot can request exit while the launcher is still opening its
  // patch-file watchers; a watcher opened after the tree disposed keeps the
  // event loop alive forever. Once this plugin is disposed nothing of ours is
  // left, so after a short grace the exit is forced. unref: the timer itself
  // never holds the loop open.
  ctx.effect(() => () => {
    if (exitCode === undefined) return
    setTimeout(() => process.exit(exitCode), DRAIN_GRACE_MS).unref()
  }, 'samsara-runner.drain')
  const exit = (code: number) => {
    exitCode ??= code
    appExit(code)
  }
  const io: Io = { stdout: internals.stdout, stderr: internals.stderr, exit }
  void run(ctx, config, io).catch((error: unknown) => {
    io.stderr.write(`samsara-runner: ${error instanceof Error ? error.message : String(error)}\n`)
    io.exit(1)
  })
}
