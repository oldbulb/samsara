// The SDK's zod schema and the host's JSON schema (packages/proposers) describe
// the same proposal.json; this test fails when one side changes without the other.
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { PROPOSAL_DRAFT_SCHEMA, SURFACES as HOST_SURFACES } from '../../proposers/src/types.ts'
import { SURFACES, DIRECTIONS, predictionSchema, proposalSchema, rowsPatchSchema, skillPatchSchema } from '../src/index.ts'

type Shape = Record<string, z.ZodType>

function keys(shape: Shape): string[] {
  return Object.keys(shape).sort()
}

function required(shape: Shape): string[] {
  return keys(shape).filter((k) => !shape[k]!.safeParse(undefined).success)
}

const host = PROPOSAL_DRAFT_SCHEMA
const hostPatch = host.properties.patch.oneOf
const hostPrediction = host.properties.prediction

describe('schema parity with @oldbulb/samsara-proposers', () => {
  it('has the same top-level keys and required set', () => {
    expect(keys(proposalSchema.shape)).toEqual(Object.keys(host.properties).sort())
    expect(required(proposalSchema.shape)).toEqual([...host.required].sort())
  })

  it('names the same surfaces', () => {
    expect([...SURFACES]).toEqual([...HOST_SURFACES])
    expect([...host.properties.surface.enum]).toEqual([...SURFACES])
  })

  it('has the same two patch variants', () => {
    expect(hostPatch).toHaveLength(2)
    type Variant = { required: readonly string[]; properties: Record<string, { const?: string; enum?: readonly string[] }> }
    const [skill, rows] = hostPatch as unknown as [Variant, Variant]
    expect(keys(skillPatchSchema.shape)).toEqual(Object.keys(skill.properties).sort())
    expect(required(skillPatchSchema.shape)).toEqual([...skill.required].sort())
    expect(skillPatchSchema.shape.surface.value).toBe(skill.properties['surface']!.const)
    expect(keys(rowsPatchSchema.shape)).toEqual(Object.keys(rows.properties).sort())
    expect(required(rowsPatchSchema.shape)).toEqual([...rows.required].sort())
    expect([...rowsPatchSchema.shape.surface.options]).toEqual([...rows.properties['surface']!.enum!])
  })

  it('has the same prediction keys, required set and directions', () => {
    expect(keys(predictionSchema.shape)).toEqual(Object.keys(hostPrediction.properties).sort())
    expect(required(predictionSchema.shape)).toEqual([...hostPrediction.required].sort())
    expect([...DIRECTIONS]).toEqual([...hostPrediction.properties.direction.enum])
  })
})
