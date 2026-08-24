// @oldbulb/samsara-proposers — `ctx.proposers`: the registry of proposer adapters.
//
// An adapter plugin registers itself with `ctx.effect(() => ctx.proposers.register(a))`,
// so the host's proposer set equals its enabled plugins. The registry holds
// adapters; it never renders a view and never touches the ledger.

import { Context, Service } from '@oldbulb/samsara-kernel'
import type { ProposerAdapter } from './types.ts'

export * from './types.ts'
export { HumanAdapter, HUMAN_NAME, HUMAN_VERSION, type HumanProposalConfig } from './human.ts'
export {
  ClaudePAdapter,
  CLAUDE_P_NAME,
  DEFAULT_TEMPLATE,
  PROPOSAL_FILE,
  SKILL_DIR,
  argvOf,
  buildEnv,
  renderPrompt,
  resolveConfig,
  type ClaudePDeps,
  type Config as ClaudePConfig,
  type ResolvedConfig as ClaudePResolvedConfig,
  type SpawnFn,
} from './claude-p.ts'

declare module '@oldbulb/samsara-kernel' {
  interface Context {
    proposers: Proposers
  }
}

export class ProposerRegistryError extends Error {
  constructor(message: string, readonly code: 'DUPLICATE_PROPOSER' | 'UNKNOWN_PROPOSER') {
    super(message)
    this.name = 'ProposerRegistryError'
  }
}

export class Proposers extends Service {
  private readonly adapters = new Map<string, ProposerAdapter>()

  constructor(ctx: Context) {
    super(ctx, 'proposers')
  }

  /** Register an adapter; the returned disposer removes it. Throws on a duplicate name. */
  register(adapter: ProposerAdapter): () => void {
    const name = adapter.name
    return this.ctx.effect(() => {
      if (this.adapters.has(name)) {
        throw new ProposerRegistryError(`a proposer named "${name}" is already registered`, 'DUPLICATE_PROPOSER')
      }
      this.adapters.set(name, adapter)
      return () => { this.adapters.delete(name) }
    }, 'proposers.register()')
  }

  get(name: string): ProposerAdapter | undefined {
    return this.adapters.get(name)
  }

  list(): ProposerAdapter[] {
    return [...this.adapters.values()]
  }
}

// The loader mounts this module as the `proposers` row: a Service class is a plugin.
export default Proposers
