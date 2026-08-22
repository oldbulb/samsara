// The submit file: the agent writes `<workdir>/<submitTool.name>.json`; the
// host validates it against the pack contract regardless of what we say here.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AttemptSpec } from './seam.ts'

export function submitPath(workdir: string, submitName: string): string {
  return join(workdir, `${submitName}.json`)
}

/** Returns the parsed submit object, or undefined when the file does not exist. Malformed JSON is reported as `{ error }`. */
export function readSubmit(workdir: string, submitName: string): { structured: unknown; text: string } | undefined {
  const path = submitPath(workdir, submitName)
  if (!existsSync(path)) return undefined
  const text = readFileSync(path, 'utf8')
  try {
    return { structured: JSON.parse(text), text }
  } catch (e) {
    return { structured: { error: `submit file is not JSON: ${(e as Error).message}` }, text }
  }
}

/** Instruction appended to the system prompt telling the agent how to submit. */
export function submitFileInstruction(spec: Pick<AttemptSpec, 'workdir' | 'tools'>): string {
  const { name, schema } = spec.tools.submitTool
  return [
    `# Submitting your answer`,
    ``,
    `When you are done, write your final structured answer as a single JSON object to the file \`${submitPath(spec.workdir, name)}\`.`,
    `The object must satisfy this JSON Schema:`,
    ``,
    '```json',
    JSON.stringify(schema, null, 2),
    '```',
    ``,
    `Write the file exactly once, then stop. Do not ask questions; there is no human in this session.`,
  ].join('\n')
}

/** SKILL.md body with its YAML frontmatter removed. */
export function stripFrontmatter(text: string): string {
  if (!text.startsWith('---')) return text
  const end = text.indexOf('\n---', 3)
  if (end < 0) return text
  const rest = text.slice(end + 4)
  return rest.startsWith('\n') ? rest.slice(1) : rest
}
