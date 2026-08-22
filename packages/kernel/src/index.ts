// samsara kernel — the single entry point to dsh.
//
// Every other samsara package imports dsh-provided functionality from here and
// never from a `@deepseek-ai/*` path directly. Re-pinning dsh is an edit to this
// package's dependencies plus whatever this file needs to adapt.
//
// dsh pin: 0.1.1-rc.2 (git tag dsh-v0.1.1-rc.2 == b150a551)

export const DSH_PIN = '0.1.1-rc.2'

// Cordis runtime: contexts, plugins, services, fibers.
export { Context, Service } from '@deepseek-ai/cordis'
export type { Plugin, Fiber, Inject } from '@deepseek-ai/cordis'

// Configuration schema vocabulary used by every dsh plugin.
export { default as Schema } from '@deepseek-ai/schemastery'

// Profile composition and config rendering (what `dsh --profile X` boots).
export {
  composeEntries,
  loadProfile,
  renderConfigDump,
  readProfileManifest,
  resolveProfileDir,
  PROFILE_PATCH_FILENAME,
} from '@deepseek-ai/dsh-app-boot'
export type { Profile, ProfileLayer, ProfileManifest, ConfigDumpLayer } from '@deepseek-ai/dsh-app-boot'

// Loader entry/patch types (challengers are entries created into the in-memory tree).
export type { EntryOptions, Entry, EntryTree, EntryGroup } from '@deepseek-ai/cordis-plugin-loader'
export type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
