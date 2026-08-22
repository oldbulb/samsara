// The skill snapshot reaches the model inline (harnessFacts.skillDelivery =
// 'prompt-inline'): SKILL.md minus its YAML frontmatter, whose harness-private
// keys (model, effort, allowed-tools, …) are recorded on other surfaces.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export function skillBody(text: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text)
  return (m ? text.slice(m[0].length) : text).trim()
}

export function readSkill(dir: string): string {
  return skillBody(readFileSync(join(dir, 'SKILL.md'), 'utf8'))
}
