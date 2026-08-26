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
export type { ParameterSchemaSpec, InferArgs, JsonValue } from '@deepseek-ai/dsh-tools'
export { ToolArgsError, defineTool } from '@deepseek-ai/dsh-tools'
export type { Session, SessionEvent, SessionId as SessionIdType } from '@deepseek-ai/dsh-session'
export { SessionId } from '@deepseek-ai/dsh-session'
export { createUserMessage } from '@deepseek-ai/dsh-llm/message'
export type { ContentBlock, Message } from '@deepseek-ai/dsh-llm/types'
export type { SubprocessSpawnSpec, SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
export { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
export type { TokenUsage } from '@deepseek-ai/dsh-llm'
export type { CredentialRef, ResolvedCredential } from '@deepseek-ai/dsh-credentials'
export { parseCmdline } from '@deepseek-ai/dsh-cmdline'

// Landlock launcher (Linux-only enforcement; the entry package resolves, probes
// and speaks the binary's CLI contract). @oldbulb/samsara-sandbox is its only consumer.
export {
  launcherPath as landlockLauncherPath,
  probe as landlockProbe,
  grantArgs as landlockGrantArgs,
  LAUNCHER_FAILURE_EXIT as LANDLOCK_LAUNCHER_FAILURE_EXIT,
} from '@deepseek-ai/node-addon-landlock-run'
export type { LandlockEnforcement, LauncherGrants as LandlockGrants } from '@deepseek-ai/node-addon-landlock-run'
export { Command } from 'commander'

// ---------------------------------------------------------------------------
// Interaction seams the workbench sits on: human commands (`ctx.commands`),
// spend approval (`ctx.approval`), the dsh home directory. Importing installs
// the Context augmentations.
import '@deepseek-ai/dsh-commands'
import '@deepseek-ai/dsh-user-approval'

export type { CommandDefinition, CommandInvocation, CommandResult, CommandId } from '@deepseek-ai/dsh-commands'
export type { ApprovalRequest, ApprovalOutcome, ApprovalService } from '@deepseek-ai/dsh-user-approval'
export { dshHomePath } from '@deepseek-ai/dsh-home-paths'

// Jobs (`ctx.jobs`): @deepseek-ai/dsh-jobs is not in the offline store at this
// pin, so its seam is mirrored structurally from the package's `types.ts` (the
// shapes a producer starts, reads and kills jobs with); replace with the
// package's own exports on the next re-pin.
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId as SessionIdBrand } from '@deepseek-ai/dsh-session'
export type JobId = string & { readonly __brand: 'JobId' }
export function JobId(id: string): JobId {
  return id as JobId
}
export type JobStatus = 'running' | 'stopping' | 'completed' | 'killed' | 'failed'
export interface JobOutcome {
  status: 'completed' | 'killed' | 'failed'
  detail?: string
  output?: string
}
export interface JobHooks {
  cancel(reason?: string): void
  done: Promise<JobOutcome>
  readOutput?(): string
}
export interface JobStart {
  kind: string
  label: string
  outputLimitBytes?: number
  owner?: Agent
  run(): JobHooks
}
export interface JobSnapshot {
  id: JobId
  kind: string
  label: string
  outputLimitBytes?: number
  ownerSession?: SessionIdBrand
  status: JobStatus
  detail?: string
  startedAt: number
  finishedAt?: number
  reported: boolean
}
export interface JobRead {
  text: string
  snapshot: JobSnapshot
}
export interface JobRegistry {
  start(spec: JobStart): JobId
  list(caller?: Agent): JobSnapshot[]
  get(id: JobId, caller?: Agent): JobSnapshot
  read(id: JobId, caller?: Agent): JobRead
  kill(id: JobId, caller?: Agent, reason?: string): 'requested' | 'already-finished'
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    jobs: JobRegistry
  }
}

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

// ---------------------------------------------------------------------------
// Web carrier: importing installs the `ctx.webServer` Context augmentation.
// The default export is the plugin module a test composition mounts as the
// webserver row; `Include` is the loader builtin such a composition needs.
import '@deepseek-ai/dsh-host-webserver'

export { default as HttpServer } from '@deepseek-ai/dsh-host-webserver'
export type { WebRoute, WebServer } from '@deepseek-ai/dsh-host-webserver'
export { default as Include } from '@deepseek-ai/cordis-plugin-include'
