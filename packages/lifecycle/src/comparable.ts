// Rule 0, pure (architecture.md § Comparability): two rows are comparable iff
// their coordinate tuples are equal on every coordinate except `parent_ids`,
// `patch_sha`, `skill_sha` (when the surface is the skill) and
// `optimizer_config_sha`. `environment_sha` is one of the strict ones: absent
// on both rows is equal, absent on one is not. The gate's own facts check
// covers the attempts.
// Also here: the gate reference a round pins (name, version, policy sha).

import { gatePolicy, type GatePolicy } from '@oldbulb/samsara-gate'
import { canonicalJson, evalConfigSha, sha256, type ChallengerRow, type GateRef } from '@oldbulb/samsara-ledger'

export type Comparable = { ok: true } | { ok: false; coordinate: string }

/** The coordinates that must be equal whatever the surface, in the order a difference is reported. */
const STRICT = ['harness_sha', 'env_sha', 'environment_sha', 'taskset_sha', 'route', 'surface', 'runtime'] as const

/** The row's evaluation configuration sha; recomputed for a row recorded before the field existed. */
export function evalConfigShaOf(row: ChallengerRow): string {
  return row.eval_config_sha ?? evalConfigSha(row)
}

export function comparable(a: ChallengerRow, b: ChallengerRow): Comparable {
  for (const name of STRICT) {
    if (canonicalJson(a[name]) !== canonicalJson(b[name])) return { ok: false, coordinate: name }
  }
  if (a.surface !== 'skill' && a.skill_sha !== b.skill_sha) return { ok: false, coordinate: 'skill_sha' }
  if (evalConfigShaOf(a) !== evalConfigShaOf(b)) return { ok: false, coordinate: 'eval_config_sha' }
  return { ok: true }
}

/** sha256 of the canonical JSON of a gate policy: what a round pins as `gate.policy_sha`. */
export function policySha(policy: GatePolicy): string {
  return sha256(canonicalJson(policy))
}

export function gateRefOf(provider: { name: string; version: string }, policy: GatePolicy): GateRef {
  return { name: provider.name, version: provider.version, policy_sha: policySha(policy) }
}

export const refMethod = (ref: Pick<GateRef, 'name' | 'version'>) => `${ref.name}@${ref.version}`

/** The policy a round judges with: the gate defaults at the pack's SESOI (`holdout.mde`) and the caller's n_eff floor. */
export function roundPolicy(nEffFloor: number, mde: number | undefined): GatePolicy {
  return gatePolicy({ nEffFloor, ...(mde !== undefined ? { mde } : {}) })
}
