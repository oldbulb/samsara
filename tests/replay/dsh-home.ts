// Where `dsh --profile host` reads its profile: `$DSH_HOME/profiles/host`
// (default `~/.dsh`). dsh fails when the directory has no package.json, and
// `run` fails when `dsh plugin --profile host install` has not populated its
// node_modules; the replay test must skip on both, never fail — the README
// runs `pnpm test` before the profile is linked and installed.

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const PROFILE = 'host'

/** The Harness home dsh resolves: `$DSH_HOME`, else `~/.dsh`. */
export function dshHome(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return env['DSH_HOME'] || join(home, '.dsh')
}

/** The reason the profile cannot run, with the README's remedy; undefined when it is linked and installed. */
export function hostProfileMissing(env: NodeJS.ProcessEnv = process.env, home = homedir()): string | undefined {
  const dir = join(dshHome(env, home), 'profiles', PROFILE)
  if (!existsSync(join(dir, 'package.json'))) {
    return `dsh profile "${PROFILE}" is not linked at ${dir} (mkdir -p ${dirname(dir)} && ln -s "$PWD/profiles/${PROFILE}" ${dir})`
  }
  if (!existsSync(join(dir, 'node_modules'))) {
    return `dsh profile "${PROFILE}" at ${dir} is not installed (dsh plugin --profile ${PROFILE} install)`
  }
  return undefined
}

function dirname(path: string): string {
  return path.slice(0, path.lastIndexOf('/'))
}
