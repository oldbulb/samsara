// workbench-presets: installs the shipped `samsara-operator` preset into dsh's
// user preset root (`<dsh home>/.agent-presets/<id>`), where `dsh-agent-presets`
// discovers it. Idempotent: the installed copy carries a `.samsara-preset-sha`
// marker with the hash of the shipped directory; the copy is refreshed when
// the marker differs and left alone when it matches. A directory without the
// marker is a person's own preset and is never overwritten.

import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { Schema, type Context } from '@oldbulb/samsara-kernel'

export const name = 'workbench-presets'

export const PRESET_ID = 'samsara-operator'
export const MARKER_FILE = '.samsara-preset-sha'
/** dsh's user preset root, relative to the harness home (`USER_PRESET_DIR` in dsh-agent-presets). */
export const USER_PRESET_DIR = '.agent-presets'
/** The preset directory shipped with this package. */
export const SHIPPED_DIR = resolve(import.meta.dirname, '..', 'presets', PRESET_ID)

export interface Config {
  /** The preset root to install into; default: dsh's user preset root. */
  root?: string
}

export const Config: Schema<Config> = Schema.object({
  root: Schema.string(),
})

export type InstallOutcome = 'installed' | 'updated' | 'unchanged' | 'kept'

/** sha256 over the directory's files (relative path + content, sorted), the marker excluded. */
export function presetSha(dir: string): string {
  const hash = createHash('sha256')
  for (const file of filesUnder(dir).sort()) {
    hash.update(file).update('\0').update(readFileSync(join(dir, file))).update('\0')
  }
  return hash.digest('hex')
}

function filesUnder(dir: string, root = dir): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...filesUnder(path, root))
    else if (relative(root, path) !== MARKER_FILE) out.push(relative(root, path))
  }
  return out
}

/** Copy `from` to `to` (tmp + rename) with the marker; see the outcomes. */
export function installPreset(from: string, to: string): InstallOutcome {
  const sha = presetSha(from)
  const marker = join(to, MARKER_FILE)
  let outcome: InstallOutcome = 'installed'
  if (existsSync(to)) {
    if (!existsSync(marker)) return 'kept'
    if (readFileSync(marker, 'utf8').trim() === sha) return 'unchanged'
    outcome = 'updated'
  }
  mkdirSync(resolve(to, '..'), { recursive: true })
  const tmp = `${to}.tmp-${process.pid}`
  rmSync(tmp, { recursive: true, force: true })
  cpSync(from, tmp, { recursive: true })
  writeFileSync(join(tmp, MARKER_FILE), `${sha}\n`)
  rmSync(to, { recursive: true, force: true })
  renameSync(tmp, to)
  return outcome
}

/** `$DSH_HOME` when set and non-blank, else `~/.dsh` — the precedence `resolveDshHome` in dsh-home-paths uses. */
function fallbackDshHome(): string {
  const fromEnv = process.env.DSH_HOME
  return resolve(fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : join(homedir(), '.dsh'))
}

/** The preset root: the row's config, else `ctx.dshHomePath` (app-boot provides it), else the fallback. */
export function presetRoot(ctx: Context, config: Config = {}): string {
  if (config.root !== undefined) return resolve(config.root)
  const dshHomePath = ctx.get('dshHomePath') as ((...segments: string[]) => string) | undefined
  return dshHomePath ? dshHomePath(USER_PRESET_DIR) : join(fallbackDshHome(), USER_PRESET_DIR)
}

export function apply(ctx: Context, config: Config = {}): void {
  const to = join(presetRoot(ctx, config), PRESET_ID)
  const outcome = installPreset(SHIPPED_DIR, to)
  ctx.logger(name).info('preset %s at %s: %s', PRESET_ID, to, outcome)
}
