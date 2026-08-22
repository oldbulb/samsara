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
// Runtime loader pieces the scope manager needs: `Loader` (mounted by tests on a
// bare Context) and `Group` (the `cordis:group` builtin a scope mounts its rows under).
export { default as Loader, Group } from '@deepseek-ai/cordis-plugin-loader'
export type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'

// ---------------------------------------------------------------------------
// Runtime seams used by loop providers and the runner. Importing these modules
// also installs their `Context` augmentations (ctx.agents, ctx.tools, ctx.sessions,
// ctx.subprocess, ctx.credentials, ctx.agentDefaultModel, ctx.systemPrompt, ...).
import '@deepseek-ai/dsh-agent'
import '@deepseek-ai/dsh-tools'
import '@deepseek-ai/dsh-session'
import '@deepseek-ai/dsh-subprocess'
import '@deepseek-ai/dsh-credentials'
import '@deepseek-ai/dsh-agent-default-model'
import '@deepseek-ai/dsh-agent-presets'
import '@deepseek-ai/dsh-system-prompt'

export type { Agent, AgentHandle, AgentOptions, CreateAgentOptions, AgentSetup } from '@deepseek-ai/dsh-agent'
export type { ToolDefinition, ToolRunContext, ToolRestriction, ToolExecution, PreToolDecision } from '@deepseek-ai/dsh-tools'
export { ToolArgsError } from '@deepseek-ai/dsh-tools'
export type { Session, SessionEvent, SessionId as SessionIdType } from '@deepseek-ai/dsh-session'
export { SessionId } from '@deepseek-ai/dsh-session'
export { createUserMessage } from '@deepseek-ai/dsh-llm/message'
export type { ContentBlock, Message } from '@deepseek-ai/dsh-llm/types'
export type { SubprocessSpawnSpec, SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
export { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
export type { TokenUsage } from '@deepseek-ai/dsh-llm'
export type { CredentialRef, ResolvedCredential } from '@deepseek-ai/dsh-credentials'
export { parseCmdline } from '@deepseek-ai/dsh-cmdline'
export { Command } from 'commander'

// ---------------------------------------------------------------------------
// Storage: the hub (`ctx.storage`), the domain data form (`ctx.storageDomain`)
// and the json backend. Importing storage-domain installs the `storageDomain`
// Context augmentation; the ledger declares its domain with `defineDomain`.
import '@deepseek-ai/dsh-storage-domain'

export { default as Storage, storageBackendServiceKey, StorageError } from '@deepseek-ai/dsh-storage'
export type { StorageBackend, KvFacet, KvUnit, KvUnitDescriptor } from '@deepseek-ai/dsh-storage'
export { defineDomain, domainTable, DomainFacility, DomainError } from '@deepseek-ai/dsh-storage-domain'
export type { Domain, KvTable, DomainSpec, DomainTableSpec, TableKeyOf, TableValueOf, DomainChanged } from '@deepseek-ai/dsh-storage-domain'
export { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
export { z } from 'zod'
