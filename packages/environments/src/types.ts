// @oldbulb/samsara-environments — the seam types, verbatim from
// docs/design/notes/environments-harbor-modal-2026-08-26.md § 1.
//
// An environment is where one attempt runs: a directory on this host, a
// container, a remote sandbox. The framework never talks to one except
// through these shapes.

import { createHash } from 'node:crypto'

export interface EnvironmentSpec {
  attemptId: string
  /** Absent: the provider's default (local: none). */
  image?: { ref?: string; dockerfileDir?: string }
  resources: { cpus?: number; memoryMb?: number; timeoutS: number }
  network: 'none' | 'allowlist' | 'public'
  allowedHosts?: string[]
  /** E5: explicit, never the host's. */
  env: Record<string, string>
  /** The skill snapshot, the pack's runtime dirs. */
  mounts: { from: string; to: string; readOnly: boolean }[]
  workdir?: string
}

export interface ExecOptions {
  cwd?: string
  env?: Record<string, string>
  stdin?: string
  timeoutMs: number
  user?: string
  signal?: AbortSignal
}

export interface ExecResult {
  code: number | null
  signal?: string
  stdout: string
  stderr: string
}

/** What actually ran: provider@version, the image digest, resources, network. */
export interface EnvironmentFacts {
  provider: string
  version: string
  image?: { ref?: string; digest?: string }
  resources: EnvironmentSpec['resources']
  network: EnvironmentSpec['network']
  allowedHosts?: string[]
}

export interface Environment {
  id: string
  provider: string
  workdir: string
  exec(argv: string[], opts: ExecOptions): Promise<ExecResult>
  put(localPath: string, remotePath: string): Promise<void>
  get(remotePath: string, localPath: string): Promise<void>
  snapshot?(): Promise<{ ref: string; digest: string }>
  facts(): EnvironmentFacts
  /** E4: the scope's effect calls this; kills everything inside. */
  dispose(): Promise<void>
}

export interface EnvironmentProvider {
  readonly name: string
  readonly version: string
  open(spec: EnvironmentSpec): Promise<Environment>
}

// ---------------------------------------------------------------- environmentSha

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key]
      if (v !== undefined) out[key] = canonical(v)
    }
    return out
  }
  return value
}

/** JSON with object keys sorted recursively and `undefined` dropped; arrays keep their order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value))
}

/**
 * The coordinate an environment contributes (rule 0): sha256 over the image
 * (its digest, else its ref, else null), the resources, the network policy
 * and the allowed hosts. The provider is deliberately not part of it — the
 * same image on two providers is one design, two images are two.
 */
export function environmentSha(facts: EnvironmentFacts): string {
  const image = facts.image?.digest ?? facts.image?.ref ?? null
  const text = canonicalJson({ image, resources: facts.resources, network: facts.network, allowedHosts: facts.allowedHosts })
  return createHash('sha256').update(text).digest('hex')
}
