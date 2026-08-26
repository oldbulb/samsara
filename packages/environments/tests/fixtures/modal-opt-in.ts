// The gate on the describes that reach Modal itself: explicit opt-in
// (SAMSARA_TEST_MODAL=1) and credentials the SDK will resolve (MODAL_TOKEN_ID,
// else the config file at MODAL_CONFIG_PATH or ~/.modal.toml). Credentials
// alone do not run them — a plain `pnpm test` on a laptop with ~/.modal.toml
// must stay offline and spend no sandbox time. Tests only.
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export const MODAL_OPT_IN = 'SAMSARA_TEST_MODAL'

export const MODAL_SKIP_REASON = `skipped: needs ${MODAL_OPT_IN}=1 and MODAL_TOKEN_ID or ~/.modal.toml`

export function modalOptedIn(env: Record<string, string | undefined>, home: string): boolean {
  if (env[MODAL_OPT_IN] !== '1') return false
  const tokenId = env['MODAL_TOKEN_ID']
  if (tokenId !== undefined && tokenId !== '') return true
  return existsSync(env['MODAL_CONFIG_PATH'] || join(home, '.modal.toml'))
}
