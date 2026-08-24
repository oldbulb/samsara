// @oldbulb/samsara-submit — how an attempt ends.
//
// A loop finishes by recording exactly one value. With a custom-tool harness
// (dsh in-process) that is a tool call shaped like dsh's own structured-output
// tool; with a file-only harness it is `<name>.json` in the working directory.
// Either way the host reads the same file back with `readSubmit` and validates
// it against the pack contract itself — the tool-side ajv check only gives the
// model an in-turn retry.

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Ajv2020, type ErrorObject } from 'ajv/dist/2020.js'
import { ToolArgsError, type ToolDefinition, type ToolRunContext } from '@oldbulb/samsara-kernel'

export interface SubmitToolOptions {
  /** Model-facing tool name; also the basename of `<workdir>/<name>.json`. */
  name: string
  description?: string
  /** JSON Schema for the submitted value (the tool's `parameters`). */
  schema: object
  /** Absolute attempt workdir the file is written into. */
  workdir: string
  /** Called after the file is durably on disk, before the turn concludes. */
  onSubmit?: (value: unknown) => void
}

export interface SubmitRecord {
  value: unknown
  /** sha256 (hex) of the file bytes exactly as written. */
  sha256: string
}

export const SUBMIT_OUTPUT_SCHEMA = {
  type: 'object',
  properties: { recorded: { type: 'boolean', const: true } },
  required: ['recorded'],
  additionalProperties: false,
} as const

export function submitPath(workdir: string, name: string): string {
  return join(workdir, `${name}.json`)
}

function formatViolations(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`)
}

/** Atomic write: tmp file in the same directory, then rename over the target. */
export function writeSubmit(workdir: string, name: string, value: unknown): SubmitRecord {
  mkdirSync(workdir, { recursive: true })
  const target = submitPath(workdir, name)
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`
  const bytes = JSON.stringify(value, null, 2) + '\n'
  writeFileSync(tmp, bytes, { encoding: 'utf8', flag: 'wx' })
  renameSync(tmp, target)
  return { value, sha256: createHash('sha256').update(bytes).digest('hex') }
}

/** Read `<workdir>/<name>.json` back; undefined when the attempt never submitted. */
export function readSubmit(workdir: string, name: string): SubmitRecord | undefined {
  let bytes: string
  try {
    bytes = readFileSync(submitPath(workdir, name), 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw e
  }
  return { value: JSON.parse(bytes), sha256: createHash('sha256').update(bytes).digest('hex') }
}

/** A dsh ToolDefinition shaped like dsh's structured-output tool, writing to the attempt workdir. */
export function createSubmitTool(options: SubmitToolOptions): ToolDefinition {
  const { name, workdir, schema, onSubmit } = options
  const ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true })
  const validate = ajv.compile(schema)
  return {
    name,
    description:
      options.description
      ?? 'Report your final result. Call this exactly once, when your answer is complete; '
      + 'the arguments must match this tool\'s parameter schema exactly.',
    parameters: schema as Record<string, unknown>,
    output: {
      schema: SUBMIT_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
      render: () => [{ type: 'text', text: 'Result recorded.' }],
    },
    execute(args: unknown, exec: ToolRunContext): Promise<{ recorded: true }> {
      if (!validate(args)) throw new ToolArgsError(formatViolations(validate.errors))
      const record = writeSubmit(workdir, name, args)
      onSubmit?.(record.value)
      exec.concludeTurn()
      return Promise.resolve({ recorded: true })
    },
  }
}

/** System-prompt text for harnesses that expose `<name>` as a tool. */
export function submitInstruction(name: string, schema: object): string {
  return `When you have your final answer, you MUST report it by calling the \`${name}\` tool `
    + 'with arguments matching its parameter schema exactly. Do not finish with a plain text answer: '
    + 'only the tool call counts as your result. The parameter schema is:\n'
    + JSON.stringify(schema, null, 2)
}

/** Equivalent text for harnesses without custom tools: finish by writing the file. */
export function submitFileInstruction(name: string, schema: object): string {
  return `When you have your final answer, you MUST record it by writing the file \`${name}.json\` `
    + 'in the working directory, containing a single JSON value that matches the schema below exactly. '
    + 'Do not finish with a plain text answer: only that file counts as your result. The schema is:\n'
    + JSON.stringify(schema, null, 2)
}
