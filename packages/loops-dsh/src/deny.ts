// Deny patterns from the attempt spec, applied to the serialized arguments of
// every tool call. A pattern is tried as a regular expression first and falls
// back to a plain substring when it does not compile.

export function matchesDeny(serializedArgs: string, patterns: readonly string[]): string | undefined {
  for (const pattern of patterns) {
    let hit: boolean
    try {
      hit = new RegExp(pattern).test(serializedArgs)
    } catch {
      hit = serializedArgs.includes(pattern)
    }
    if (hit) return pattern
  }
  return undefined
}

export function serializeArgs(args: unknown): string {
  if (typeof args === 'string') return args
  try {
    return JSON.stringify(args) ?? ''
  } catch {
    return String(args)
  }
}
