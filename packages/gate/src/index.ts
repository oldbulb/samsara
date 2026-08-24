// @oldbulb/samsara-gate — `ctx.gate`: the registry of gate policies.
//
// A policy plugin registers itself with `ctx.gate.register(policy)`; the most
// recently registered live policy is `current()`, and `judge(req)` stamps its
// verdict with `gateMethod = name@version` so the ledger can record which
// policy decided. The gate injects nothing from the loop.

import { Context, Service } from '@oldbulb/samsara-kernel'
import type { CompareRequest, GateJudgement, GatePolicyProvider } from './types.ts'

export * from './types.ts'
export * from './stats.ts'
export { gateDefault, GATE_DEFAULT_NAME, GATE_DEFAULT_VERSION } from './default.ts'

declare module '@oldbulb/samsara-kernel' {
  interface Context {
    gate: GateRegistry
  }
}

export class GateRegistryError extends Error {
  constructor(message: string, readonly code: 'DUPLICATE_POLICY' | 'NO_POLICY') {
    super(message)
    this.name = 'GateRegistryError'
  }
}

export interface GateVerdictRow extends GateJudgement {
  gateMethod: string
}

export const gateMethodOf = (p: GatePolicyProvider) => `${p.name}@${p.version}`

export class GateRegistry extends Service {
  private readonly policies: GatePolicyProvider[] = []

  constructor(ctx: Context) {
    super(ctx, 'gate')
  }

  /** Register a policy; the returned disposer removes it. Throws on a duplicate name@version. */
  register(policy: GatePolicyProvider): () => void {
    const method = gateMethodOf(policy)
    return this.ctx.effect(() => {
      if (this.policies.some(p => gateMethodOf(p) === method)) {
        throw new GateRegistryError(`a gate policy "${method}" is already registered`, 'DUPLICATE_POLICY')
      }
      this.policies.push(policy)
      return () => {
        const i = this.policies.indexOf(policy)
        if (i >= 0) this.policies.splice(i, 1)
      }
    }, 'gate.register()')
  }

  /** The policy that decides: the most recently registered one still mounted. */
  current(): GatePolicyProvider | undefined {
    return this.policies.at(-1)
  }

  list(): GatePolicyProvider[] {
    return [...this.policies]
  }

  judge(req: CompareRequest): GateVerdictRow {
    const policy = this.current()
    if (!policy) throw new GateRegistryError('no gate policy is registered', 'NO_POLICY')
    const { compare, verdict } = policy.judge(req)
    return { compare, verdict, gateMethod: gateMethodOf(policy) }
  }
}

// The loader mounts this module as the `gate` row: a Service class is a plugin.
export default GateRegistry
