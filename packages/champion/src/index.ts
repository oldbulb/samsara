// @oldbulb/samsara-champion — `ctx.champion`: the served configuration.
//
// The champion is an alias to content-addressed refs; its on-disk form is the
// generated section of the host profile's patch layer. promote() needs a
// gate verdict of `promote` from the promotion gate (gate-default mounted on
// ctx.gate, or a gate a `gate_change` consent names) AND a consents row from
// signoff whose proof still verifies under the public key (two fixed points
// the loop cannot write), rewrites the file atomically, and proves the
// hot-apply by recomposing the profile exactly as `--dump-config` does and
// hashing what the kept rows read back as (E7); for a skill promotion the
// snapshot the host now serves (`current().skill_ref`) must hash to the row's
// `skill_sha`. The only ledger write here is
// the settlement append; every status flip and compare row is ctx.lifecycle's,
// which drives promote/demote and records what they decided.

import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { basename, dirname, join, resolve } from 'node:path'
import { Context, Schema, Service, loadProfile, renderConfigDump, PROFILE_PATCH_FILENAME, type PatchOptions } from '@oldbulb/samsara-kernel'
import { gateMethodOf, GATE_DEFAULT_NAME, GATE_DEFAULT_VERSION, type GateRegistry } from '@oldbulb/samsara-gate'
import type { AttemptRow, ChallengerRow, ConsentRow, SettlementRow } from '@oldbulb/samsara-ledger'
import type {} from '@oldbulb/samsara-signoff'
import { hashDir } from '@oldbulb/samsara-workdir'
import {
  EMPTY_STATE,
  parseProfilePatch,
  refOf,
  renderProfilePatch,
  replayCheck as replayCheckRefs,
  stateOf,
  verifyHotApply,
  type ChampionState,
  type ContentRef,
  type HotApplyResult,
  type KeptPatch,
  type ReplayResult,
} from './state.ts'
import { planRescore, type RescoreEvent, type SettledEvent } from './settlement.ts'

export * from './state.ts'
export * from './settlement.ts'

declare module '@oldbulb/samsara-kernel' {
  interface Context {
    champion: Champion
  }
}

export type ChampionErrorCode =
  | 'UNKNOWN_CHALLENGER'
  | 'NOT_PROMOTABLE'
  | 'NO_CONSENT'
  | 'BAD_CONSENT'
  | 'FOREIGN_GATE'
  | 'BAD_PATCH'
  | 'HOT_APPLY_MISMATCH'
  | 'NOT_KEPT'
  | 'PROFILE_LAYOUT'

export class ChampionError extends Error {
  constructor(message: string, readonly code: ChampionErrorCode, readonly detail?: unknown) {
    super(message)
    this.name = 'ChampionError'
  }
}

export interface Config {
  /** The profile directory whose cordis.patch.yml the champion owns; must be `<home>/profiles/<name>`. */
  profileDir: string
  /** Directory of content-addressed skill snapshots (`<skillStore>/<skill_sha>/`). */
  skillStore: string
  /**
   * A file inside the dsh app package: the first anchor in-box bundles
   * (`@deepseek-ai/dsh-base`) resolve from when the profile is recomposed for
   * E7. Default: the running launcher (`process.argv[1]`), i.e. the same
   * installation that booted this host.
   */
  installAnchor?: string
}

export const Config: Schema<Config> = Schema.object({
  profileDir: Schema.string().required(),
  skillStore: Schema.string().required(),
  installAnchor: Schema.string(),
})

/** The slice of `ctx.ledger` the champion uses (structural, so fakes compose). */
export interface ChampionLedger {
  challenger(id: string): ChallengerRow | undefined
  consentsOf(challengerId: string): ConsentRow[]
  attemptsOf(challengerId: string): AttemptRow[]
  lineage(id: string): ChallengerRow[]
  recordSettlement(row: SettlementRow): Promise<string>
}

export interface ChampionEvents {
  'samsara/rescore': [event: RescoreEvent]
  'champion/changed': [state: ChampionState]
}

const BIN = 'samsara'

export class Champion extends Service {
  static inject = ['ledger', 'signoff']
  static Config = Config

  private readonly emitter = new EventEmitter()
  private readonly profileDir: string
  private readonly skillStore: string
  private readonly installAnchor: string

  constructor(ctx: Context, config: Config) {
    super(ctx, 'champion')
    this.profileDir = resolve(config.profileDir)
    this.skillStore = resolve(config.skillStore)
    this.installAnchor = config.installAnchor !== undefined ? resolve(config.installAnchor) : launcherAnchor()
    if (basename(dirname(this.profileDir)) !== 'profiles') {
      throw new ChampionError(`profileDir must be <home>/profiles/<name>, got ${this.profileDir}`, 'PROFILE_LAYOUT')
    }
  }

  private get ledger(): ChampionLedger {
    return this.ctx.ledger
  }

  private get patchPath(): string {
    return join(this.profileDir, PROFILE_PATCH_FILENAME)
  }

  on<K extends keyof ChampionEvents>(event: K, listener: (...args: ChampionEvents[K]) => void): () => void {
    this.emitter.on(event, listener as (...args: unknown[]) => void)
    return () => { this.emitter.off(event, listener as (...args: unknown[]) => void) }
  }

  // ------------------------------------------------------------------ state

  /** The state recorded in the profile file's champion section; empty when there is none. */
  current(): ChampionState {
    const text = this.readFile()
    return text === undefined ? EMPTY_STATE : parseProfilePatch(text).state
  }

  /** The promoted-and-not-reversed challengers on the ledger vs the refs in the file. */
  replayCheck(): ReplayResult {
    const state = this.current()
    const fromLedger: ContentRef[] = state.kept
      .map((k) => this.ledger.challenger(k.challenger_id))
      .filter((row): row is ChallengerRow => row !== undefined && row.status === 'decided' && row.verdict?.value === 'promote')
      .map(refOfRow)
    return replayCheckRefs(fromLedger, state.rows)
  }

  // ---------------------------------------------------------------- promote

  async promote(challengerId: string, consentId: string): Promise<ChampionState> {
    const row = this.ledger.challenger(challengerId)
    if (!row) throw new ChampionError(`no challenger ${challengerId}`, 'UNKNOWN_CHALLENGER')
    if (row.verdict?.value !== 'promote') {
      throw new ChampionError(`challenger ${challengerId} has verdict ${row.verdict?.value ?? 'none'}, not promote`, 'NOT_PROMOTABLE')
    }
    this.checkGate(challengerId, row.verdict.by)
    const consent = this.ledger.consentsOf(challengerId).find((c) => c.id === consentId && c.action === 'promote')
    if (!consent) throw new ChampionError(`no consent ${consentId} to promote ${challengerId}`, 'NO_CONSENT')
    // E2: a consents row is honoured only as the proof it carries verifies now, under the host's public key.
    try {
      this.ctx.signoff.verifyConsent(consent)
    } catch (e) {
      throw new ChampionError(`consent ${consentId} does not verify: ${e instanceof Error ? e.message : String(e)}`, 'BAD_CONSENT', e)
    }

    const before = this.current()
    if (before.kept.some((k) => k.challenger_id === challengerId)) return before
    const kept = this.keptOf(row, consent)
    const after = stateOf([...before.kept, kept])
    const previous = this.readFile()
    await this.write(after)
    if (kept.skill_ref !== undefined) {
      // E7 for the skill surface: what the file now serves is the promoted snapshot, byte for byte.
      const served = this.current().skill_ref
      const observed = served !== undefined && existsSync(served) ? hashDir(served) : ''
      if (served !== kept.skill_ref || observed !== row.skill_sha) {
        this.restore(previous)
        throw new ChampionError(
          `hot-apply mismatch: the skill served is ${served ?? '(none)'} hashing ${observed.slice(0, 12) || '(absent)'}, promoted ${kept.skill_ref} with skill_sha ${row.skill_sha.slice(0, 12)}`,
          'HOT_APPLY_MISMATCH',
          { ok: false, expected_sha: row.skill_sha, observed_sha: observed, mismatches: ['skill_ref did not apply'] } satisfies HotApplyResult,
        )
      }
    }
    this.emitter.emit('champion/changed', after)
    return after
  }

  async demote(challengerId: string): Promise<ChampionState> {
    const before = this.current()
    if (!before.kept.some((k) => k.challenger_id === challengerId)) {
      throw new ChampionError(`challenger ${challengerId} is not kept`, 'NOT_KEPT')
    }
    const after = stateOf(before.kept.filter((k) => k.challenger_id !== challengerId))
    await this.write(after)
    this.emitter.emit('champion/changed', after)
    return after
  }

  // ------------------------------------------------------------- settlement

  /** Bookkeeping for `book/settled`: plan re-scores over the champion's ancestry, record, emit. */
  async onSettlement(event: SettledEvent): Promise<RescoreEvent[]> {
    const plan = planRescore(this.ledger, this.current().kept.map((k) => k.challenger_id), event)
    await this.ledger.recordSettlement({
      id: event.id,
      kind: event.kind,
      taskset_sha: event.taskset_sha,
      as_of: event.as_of,
      truth_snapshot_id: event.truth_snapshot_id,
      n_settled: event.n_settled,
      n_pending: event.n_pending,
      triggered_rescoring: plan.map((p) => p.challenger_id),
    })
    for (const p of plan) this.emitter.emit('samsara/rescore', p)
    return plan
  }

  /**
   * The verdict must come from the promotion gate — the policy mounted on
   * ctx.gate, itself either gate-default or a gate a `gate_change` consent
   * names by `name@version` — or from a gate such a consent names.
   */
  private checkGate(challengerId: string, by: string): void {
    const mounted = (this.ctx.get('gate') as GateRegistry | undefined)?.current()
    const promotionGate = mounted ? gateMethodOf(mounted) : undefined
    if (by === promotionGate && by === `${GATE_DEFAULT_NAME}@${GATE_DEFAULT_VERSION}`) return
    if (this.ledger.consentsOf(by).some((c) => c.action === 'gate_change')) return
    const why = by === promotionGate ? `the mounted gate ${by} is not ${GATE_DEFAULT_NAME}@${GATE_DEFAULT_VERSION}` : `not the promotion gate ${promotionGate ?? '(none mounted)'}`
    throw new ChampionError(`challenger ${challengerId} was judged by ${by}: ${why}, and no gate_change consent names ${by}`, 'FOREIGN_GATE')
  }

  // ------------------------------------------------------------------ file

  private keptOf(row: ChallengerRow, consent: ConsentRow): KeptPatch {
    const promoted_at = new Date().toISOString()
    if (row.surface === 'skill') {
      if (!row.patch.skill_ref) throw new ChampionError(`skill challenger ${row.id} has no patch.skill_ref`, 'BAD_PATCH')
      const dest = join(this.skillStore, row.skill_sha)
      if (!existsSync(dest)) {
        mkdirSync(this.skillStore, { recursive: true })
        const tmp = `${dest}.tmp-${process.pid}`
        rmSync(tmp, { recursive: true, force: true })
        cpSync(row.patch.skill_ref, tmp, { recursive: true })
        // The store is content-addressed by the row's skill_sha: a snapshot that hashes to anything else is not this row's.
        const observed = hashDir(tmp)
        if (observed !== row.skill_sha) {
          rmSync(tmp, { recursive: true, force: true })
          throw new ChampionError(
            `hot-apply mismatch: the snapshot at ${row.patch.skill_ref} hashes to ${observed.slice(0, 12)}, the row's skill_sha is ${row.skill_sha.slice(0, 12)}`,
            'HOT_APPLY_MISMATCH',
            { ok: false, expected_sha: row.skill_sha, observed_sha: observed, mismatches: ['skill snapshot differs from skill_sha'] } satisfies HotApplyResult,
          )
        }
        renameSync(tmp, dest)
      }
      return { challenger_id: row.id, surface: row.surface, ref: refOfRow(row), rows: [], skill_ref: dest, consent_id: consent.id, promoted_at }
    }
    const rows = row.patch.cordis
    if (!Array.isArray(rows) || rows.some((r) => typeof r !== 'object' || r === null || Array.isArray(r))) {
      throw new ChampionError(`challenger ${row.id} patch.cordis must be a list of loader patch rows`, 'BAD_PATCH')
    }
    return { challenger_id: row.id, surface: row.surface, ref: refOfRow(row), rows: rows as PatchOptions[], consent_id: consent.id, promoted_at }
  }

  private readFile(): string | undefined {
    return existsSync(this.patchPath) ? readFileSync(this.patchPath, 'utf8') : undefined
  }

  /** tmp + rename, then prove the hot-apply; on mismatch the previous file is restored and the error carries the hashes. */
  private async write(state: ChampionState): Promise<HotApplyResult> {
    const previous = this.readFile()
    const base = previous === undefined ? '' : parseProfilePatch(previous).baseText
    const text = renderProfilePatch(state, base)
    this.replaceFile(text)
    let result: HotApplyResult
    try {
      result = verifyHotApply(state.profilePatchRows, this.dump())
    } catch (e) {
      this.restore(previous)
      throw e
    }
    if (!result.ok) {
      this.restore(previous)
      throw new ChampionError(
        `hot-apply mismatch: expected ${result.expected_sha}, observed ${result.observed_sha}; ${result.mismatches.join('; ')}`,
        'HOT_APPLY_MISMATCH',
        result,
      )
    }
    return result
  }

  private restore(previous: string | undefined): void {
    if (previous === undefined) rmSync(this.patchPath, { force: true })
    else this.replaceFile(previous)
  }

  private replaceFile(text: string): void {
    const tmp = `${this.patchPath}.tmp-${process.pid}`
    writeFileSync(tmp, text)
    renameSync(tmp, this.patchPath)
  }

  /** Recompose the profile exactly as `dsh --profile <name> --dump-config` would, from the file on disk. */
  dump(): string {
    const home = dirname(dirname(this.profileDir))
    const profile = loadProfile(BIN, basename(this.profileDir), this.installAnchor, home)
    const layers = [
      ...profile.layers.map((l) => ({ label: l.patchPath, patches: l.patches })),
      { label: profile.patchPath, patches: profile.patches },
    ]
    return renderConfigDump(BIN, join(this.profileDir, 'cordis.yml'), layers, () => {})
  }
}

/** The script that launched this process, symlinks resolved; a file inside the dsh app package when dsh booted us. */
function launcherAnchor(): string {
  const script = process.argv[1]
  if (!script) return process.cwd()
  try {
    return realpathSync(script)
  } catch {
    return resolve(script)
  }
}

export function refOfRow(row: ChallengerRow): ContentRef {
  return refOf(row.surface, row.surface === 'skill' ? row.skill_sha : row.patch_sha)
}

// The loader mounts this module as the `champion` row: a Service class is a plugin.
export default Champion
