// The installed loop: the agent lives in the environment's image and runs
// there through `exec` — `dsh` headless, `claude`, `codex`, a task's own
// oracle — while this process only starts it, waits, and reads back what it
// left (docs/design/notes/environments-harbor-modal-2026-08-26.md § 1,
// "loops"). One exec is the attempt: exit 0 is COMPLETED, any other exit
// FAILED, the deadline (`limits.maxDurationMs`, judged by the loop's own
// clock — the seam carries no timed-out flag) is TRUNCATED, the host's abort
// ABORTED. Usage is unknown — an installed agent's accounting is its own —
// so the tokens read zero and the cost source is 'unknown'. The route does
// not reach the agent either: what it calls is the image's and this config's
// business (`--model` is a label here), so the config is the coordinate. The
// provider disposes nothing: the runner owns the environment, and a
// timed-out exec is the provider's kill.

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, type Dirent } from 'node:fs'
import { extname, join, posix, relative, sep } from 'node:path'
import type { ExecResult } from '@oldbulb/samsara-environments'
import { canonicalJson, type Artifact, type AttemptSpec, type FinishedEvent, type HarnessFacts, type LoopCapabilities, type LoopEvent, type LoopProvider, type LoopRun } from './types.ts'

export const PROVIDER_NAME = 'installed'
/** `.task/token.json` under the workdir: the pack-facing record of the attempt, put there with the sealed workdir (@oldbulb/samsara-workdir). */
export const TOKEN_PATH = '.task/token.json'
/** Under `localWorkdir`: what the loop brings back from the environment (stdout, stderr, the transcript). */
export const INSTALLED_DIR = '.installed'

export interface InstalledLoopOptions {
  /** The argv run inside the environment; `{workdir}`, `{skill}` and `{attempt}` in any element are filled in per attempt. */
  command: string[]
  /** Working directory inside the environment; the environment's workdir by default. */
  cwd?: string
  /** A path inside the environment fetched back as the `transcript-native` artifact; a directory (an agent's whole log dir) is fetched and hashed as a tree. */
  transcript?: string
  /** A path inside the environment whose content becomes the attempt's submit file (`<workdir>/<submitTool>.json`), on the host and in the environment. */
  submit?: string
  /** Environment variables for the command, under the attempt's own (`AttemptSpec.env`). Non-secret — names and values enter the loop's facts; a secret goes through `credentialRef`. */
  env?: Record<string, string>
  /** Credential resolved per attempt into `credentialVar`; absent while `credentialVar` is set, the attempt's own `route.credentialRef` is resolved instead. */
  credentialRef?: string
  /** Environment variable the credential is injected as (E5: explicit per loop). Its name enters the loop's facts; its value never does. */
  credentialVar?: string
}

export interface InstalledLoopDeps {
  /** Resolves a credential ref to its value (the plugin binds ctx.credentials); required when `credentialVar` is configured. */
  resolveCredential?: (ref: string) => Promise<string>
}

export const capabilities: LoopCapabilities = {
  perAttemptBaseUrl: false,
  perAttemptEnv: true,
  nativeSchema: 'none',
  toolFilter: false,
  nativeMaxTurns: false,
  installed: true,
}

function sha256(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** sha256 over the sorted (relative posix path, bytes) pairs under `dir`; a missing directory hashes as empty. Symlinks are not followed. The same shape as a skill snapshot's sha (@oldbulb/samsara-workdir's hashDir). */
export function treeSha(dir: string): string {
  const files: string[] = []
  const walk = (d: string) => {
    let entries: Dirent[]
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const abs = join(d, e.name)
      if (e.isDirectory()) walk(abs)
      else if (e.isFile()) files.push(abs)
    }
  }
  walk(dir)
  const h = createHash('sha256')
  for (const abs of files.sort()) {
    const rel = relative(dir, abs).split(sep).join('/')
    const bytes = readFileSync(abs)
    h.update(rel).update('\0').update(String(bytes.length)).update('\0').update(bytes)
  }
  return h.digest('hex')
}

/** The facts of one config: the sha over everything that shapes the exec — the command, cwd, the fetch paths, the env (names and values) and the credential variable's name, never its value — is the loop version; the envelope is whatever the installed agent shows (the config stands in for it). */
export function harnessFactsOf(options: InstalledLoopOptions): HarnessFacts {
  const { command, cwd, transcript, submit, env, credentialVar } = options
  return {
    systemPromptMode: 'agent-native',
    skillDelivery: 'agents-skills-dir',
    schemaEnforcement: 'permissive-tool',
    permission: 'environment',
    reasoning: {},
    envelope: { config: 'proxy', system: 'proxy', tools: 'proxy' },
    version: { loop: `${PROVIDER_NAME}@${sha256(canonicalJson({ command, cwd, transcript, submit, env, credentialVar }))}` },
    sandbox: 'environment',
  }
}

/** The command with its templates filled in: the workdir, the skill snapshot and the attempt token, as paths inside the environment. */
export function renderCommand(command: string[], spec: Pick<AttemptSpec, 'workdir' | 'skill'>): string[] {
  const values: Record<string, string> = { workdir: spec.workdir, skill: spec.skill.dir, attempt: posix.join(spec.workdir, TOKEN_PATH) }
  return command.map((arg) => arg.replace(/\{(workdir|skill|attempt)\}/g, (_m, key: string) => values[key]!))
}

function fileArtifact(kind: Artifact['kind'], path: string): Artifact {
  // A fetched directory (Harbor's `/logs/agent`; a transcript whose file name is unknowable up front) is hashed as a tree.
  return { kind, path, sha256: statSync(path).isDirectory() ? treeSha(path) : sha256(readFileSync(path)) }
}

export class InstalledLoopProvider implements LoopProvider {
  readonly name = PROVIDER_NAME
  readonly harnessFacts: HarnessFacts
  readonly capabilities = capabilities

  constructor(private readonly options: InstalledLoopOptions, private readonly deps: InstalledLoopDeps = {}) {
    if (options.command.length === 0) throw new Error('loops-installed: command must not be empty')
    if (options.credentialRef !== undefined && options.credentialVar === undefined) throw new Error('loops-installed: credentialVar is required with credentialRef')
    this.harnessFacts = harnessFactsOf(options)
  }

  /** The credential as one named variable (E5), resolved per attempt: the config's ref, else the attempt's own. */
  private async credentialEnv(spec: AttemptSpec): Promise<Record<string, string>> {
    const { credentialRef, credentialVar } = this.options
    if (credentialVar === undefined) return {}
    const resolve = this.deps.resolveCredential
    if (resolve === undefined) throw new Error('loops-installed: credentialVar needs a credential resolver (the plugin binds ctx.credentials)')
    return { [credentialVar]: await resolve(credentialRef ?? spec.route.credentialRef) }
  }

  async start(spec: AttemptSpec): Promise<LoopRun> {
    const environment = spec.environment
    if (environment === undefined) throw new Error(`loops-installed: attempt ${spec.attemptId} has no environment to run in`)
    if (spec.signal.aborted) throw new Error(`loops-installed: attempt ${spec.attemptId} aborted before start`)
    const options = this.options
    const argv = renderCommand(options.command, spec)
    // Resolved before publication: a missing credential rejects start, never the published run.
    const env = { ...options.env, ...(await this.credentialEnv(spec)), ...spec.env }
    const controller = new AbortController()
    const signal = AbortSignal.any([spec.signal, controller.signal])
    const startedAt = Date.now()
    let stdoutBytes = 0
    let submitted: string | undefined

    // The whole attempt, settled once whatever happens; the event stream reads it, so both agree.
    const done: Promise<FinishedEvent> = (async () => {
      const at = () => Date.now()
      const finished = (status: FinishedEvent['status'], stopReason: FinishedEvent['stopReason'], artifacts: Artifact[] = []): FinishedEvent => ({
        t: 'finished', at: at(), status, stopReason,
        usage: { inputTokens: 0, outputTokens: 0 }, cost: { source: 'unknown' }, turns: 0, toolCalls: 0, artifacts,
      })
      let result: ExecResult
      const execAt = Date.now()
      try {
        result = await environment.exec(argv, {
          ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
          env,
          timeoutMs: spec.limits.maxDurationMs,
          signal,
        })
      } catch {
        return finished(signal.aborted ? 'ABORTED' : 'FAILED', signal.aborted ? 'aborted' : 'error')
      }
      // The deadline verdict is the loop's own: no provider flags its kill on the seam, and a child that
      // turned the SIGTERM into an exit code inside the grace would otherwise read as a crash.
      const deadline = result.code === null || Date.now() - execAt >= spec.limits.maxDurationMs
      stdoutBytes = Buffer.byteLength(result.stdout)
      const artifacts: Artifact[] = []
      let fetchError: string | undefined
      const local = spec.localWorkdir
      if (local !== undefined) {
        const dir = join(local, INSTALLED_DIR)
        mkdirSync(dir, { recursive: true })
        const stdoutPath = join(dir, 'stdout')
        writeFileSync(stdoutPath, result.stdout)
        artifacts.push(fileArtifact('stdout', stdoutPath))
        const fetched: Artifact[] = []
        try {
          if (options.transcript !== undefined) {
            const path = join(dir, `transcript${extname(options.transcript)}`)
            // An agent that wrote no transcript (it failed early) is not a host error: the run's status says what happened.
            if (await environment.get(options.transcript, path).then(() => true, () => false)) fetched.push(fileArtifact('transcript-native', path))
          }
          if (options.submit !== undefined) {
            const name = `${spec.tools.submitTool.name}.json`
            const path = join(local, name)
            if (await environment.get(options.submit, path).then(() => true, () => false)) {
              // The environment gets it under the convention too, so an `in_environment` truth reads the same file the host does.
              if (spec.workdir !== local) await environment.put(path, name).catch(() => {})
              submitted = readFileSync(path, 'utf8')
            }
          }
        } catch (e) {
          // A fetch the host could not land (a directory where a file was named, a vanished path) fails the
          // attempt with the message on the stderr artifact — never a rejection after publication.
          fetchError = e instanceof Error ? e.message : String(e)
        }
        const stderrPath = join(dir, 'stderr')
        writeFileSync(stderrPath, fetchError === undefined ? result.stderr : `${result.stderr}${result.stderr === '' || result.stderr.endsWith('\n') ? '' : '\n'}loops-installed: ${fetchError}\n`)
        artifacts.push(fileArtifact('stderr', stderrPath), ...fetched)
      }
      if (signal.aborted) return finished('ABORTED', 'aborted', artifacts)
      if (deadline) return finished('TRUNCATED', 'timeout', artifacts)
      if (fetchError !== undefined) return finished('FAILED', 'error', artifacts)
      return finished(result.code === 0 ? 'COMPLETED' : 'FAILED', result.code === 0 ? 'completed' : 'error', artifacts)
    })()
    done.catch(() => {})

    const events = (async function* (): AsyncGenerator<LoopEvent> {
      yield { t: 'started', at: startedAt, native: { kind: PROVIDER_NAME, id: spec.attemptId } }
      const finished = await done
      yield { t: 'assistant', at: finished.at, turn: 0, textBytes: stdoutBytes }
      if (submitted !== undefined) {
        let structured: unknown
        try { structured = JSON.parse(submitted) } catch { /* the host validates the file; a non-JSON submit is its verdict */ }
        yield { t: 'output', at: finished.at, ...(structured !== undefined ? { structured } : {}), text: submitted, source: 'submit-tool' }
      }
      yield finished
    })()

    return {
      id: spec.attemptId,
      events,
      result: done,
      cancel(reason) { controller.abort(reason) },
      async dispose() {},
    }
  }
}
