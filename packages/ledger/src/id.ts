// Pure hashing: every ledger key is a sha256 over canonical JSON of its
// coordinate tuple, so the same facts always land on the same row.

import { createHash } from 'node:crypto'

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

/** JSON with object keys sorted recursively; arrays keep their order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[k]
      if (v !== undefined) out[k] = sortKeys(v)
    }
    return out
  }
  return value
}

/** sha256 of the canonical JSON of a tuple of coordinates. */
export function keyOf(...coords: unknown[]): string {
  return sha256(canonicalJson(coords))
}
