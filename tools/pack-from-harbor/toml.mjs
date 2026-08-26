// A small TOML reader for task.toml: tables, dotted keys, strings (basic,
// literal, triple-quoted), numbers, booleans, arrays (single- or multi-line),
// inline tables, and `[[array of tables]]`. Enough for what Harbor writes;
// anything else throws with the line it stopped at.

export function parseToml(text) {
  const root = {}
  let table = root
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = stripComment(lines[i]).trim()
    if (line === '') continue
    const fail = (why) => new Error(`task.toml:${i + 1}: ${why}`)
    if (line.startsWith('[[')) {
      if (!line.endsWith(']]')) throw fail('unterminated [[table]]')
      const parent = walk(root, keyPath(line.slice(2, -2)).slice(0, -1))
      const last = keyPath(line.slice(2, -2)).at(-1)
      const arr = (parent[last] ??= [])
      if (!Array.isArray(arr)) throw fail(`${last} is not an array of tables`)
      table = {}
      arr.push(table)
      continue
    }
    if (line.startsWith('[')) {
      if (!line.endsWith(']')) throw fail('unterminated [table]')
      table = walk(root, keyPath(line.slice(1, -1)))
      continue
    }
    const eq = findAssign(line)
    if (eq < 0) throw fail(`expected key = value, got ${JSON.stringify(line)}`)
    const path = keyPath(line.slice(0, eq))
    let raw = line.slice(eq + 1).trim()
    // a value spanning lines: gather until the brackets or quotes balance
    while (!balanced(raw)) {
      i++
      if (i >= lines.length) throw fail('unterminated value')
      raw += '\n' + stripComment(lines[i])
    }
    const target = walk(root, path.slice(0, -1), table)
    target[path.at(-1)] = parseValue(raw.trim(), fail)
  }
  return root
}

/** Everything before a `#` that is not inside a string. */
function stripComment(line) {
  let quote = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) {
      if (c === '\\' && quote === '"') i++
      else if (c === quote) quote = null
    } else if (c === '"' || c === "'") quote = c
    else if (c === '#') return line.slice(0, i)
  }
  return line
}

function findAssign(line) {
  let quote = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) { if (c === quote) quote = null }
    else if (c === '"' || c === "'") quote = c
    else if (c === '=') return i
  }
  return -1
}

function keyPath(s) {
  const out = []
  let cur = ''
  let quote = null
  for (const c of s) {
    if (quote) { if (c === quote) quote = null; else cur += c }
    else if (c === '"' || c === "'") quote = c
    else if (c === '.') { out.push(cur.trim()); cur = '' }
    else cur += c
  }
  out.push(cur.trim())
  return out
}

function walk(root, path, from = root) {
  let t = from
  for (const k of path) {
    const next = (t[k] ??= {})
    t = Array.isArray(next) ? next.at(-1) : next
  }
  return t
}

function balanced(s) {
  let depth = 0
  let quote = null
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quote) {
      if (c === '\\' && quote[0] === '"') i++
      else if (s.startsWith(quote, i)) { i += quote.length - 1; quote = null }
    } else if (s.startsWith('"""', i) || s.startsWith("'''", i)) { quote = s.slice(i, i + 3); i += 2 }
    else if (c === '"' || c === "'") quote = c
    else if (c === '[' || c === '{') depth++
    else if (c === ']' || c === '}') depth--
  }
  return depth <= 0 && quote === null
}

function parseValue(raw, fail) {
  const [value, rest] = readValue(raw, fail)
  if (rest.trim() !== '') throw fail(`trailing text after value: ${JSON.stringify(rest.trim())}`)
  return value
}

/** Read one value at the start of `s`; return it and what follows. */
function readValue(s, fail) {
  s = s.trimStart()
  if (s.startsWith('"""') || s.startsWith("'''")) {
    const q = s.slice(0, 3)
    let end = s.indexOf(q, 3)
    if (end < 0) throw fail('unterminated multi-line string')
    let body = s.slice(3, end)
    if (body.startsWith('\n')) body = body.slice(1)
    return [q === '"""' ? unescape(body) : body, s.slice(end + 3)]
  }
  if (s[0] === '"') {
    let i = 1
    while (i < s.length && s[i] !== '"') { if (s[i] === '\\') i++; i++ }
    if (i >= s.length) throw fail('unterminated string')
    return [unescape(s.slice(1, i)), s.slice(i + 1)]
  }
  if (s[0] === "'") {
    const end = s.indexOf("'", 1)
    if (end < 0) throw fail('unterminated literal string')
    return [s.slice(1, end), s.slice(end + 1)]
  }
  if (s[0] === '[') {
    const out = []
    let rest = s.slice(1)
    for (;;) {
      rest = rest.trimStart()
      if (rest.startsWith(']')) return [out, rest.slice(1)]
      const [v, r] = readValue(rest, fail)
      out.push(v)
      rest = r.trimStart()
      if (rest.startsWith(',')) rest = rest.slice(1)
      else if (!rest.startsWith(']')) throw fail('expected , or ] in array')
    }
  }
  if (s[0] === '{') {
    const out = {}
    let rest = s.slice(1)
    for (;;) {
      rest = rest.trimStart()
      if (rest.startsWith('}')) return [out, rest.slice(1)]
      const eq = findAssign(rest)
      if (eq < 0) throw fail('expected key = value in inline table')
      const path = keyPath(rest.slice(0, eq))
      const [v, r] = readValue(rest.slice(eq + 1), fail)
      walk(out, path.slice(0, -1))[path.at(-1)] = v
      rest = r.trimStart()
      if (rest.startsWith(',')) rest = rest.slice(1)
      else if (!rest.startsWith('}')) throw fail('expected , or } in inline table')
    }
  }
  const m = /^[^,\]}\s]+/.exec(s)
  if (!m) throw fail(`expected a value, got ${JSON.stringify(s.slice(0, 20))}`)
  const tok = m[0]
  const rest = s.slice(tok.length)
  if (tok === 'true') return [true, rest]
  if (tok === 'false') return [false, rest]
  if (/^[+-]?(inf|nan)$/.test(tok)) return [tok.endsWith('nan') ? NaN : tok.startsWith('-') ? -Infinity : Infinity, rest]
  if (/^[+-]?(0x[0-9a-fA-F_]+|0o[0-7_]+|0b[01_]+|\d[\d_]*(\.\d[\d_]*)?([eE][+-]?\d+)?)$/.test(tok)) return [Number(tok.replace(/_/g, '')), rest]
  if (/^\d{4}-\d{2}-\d{2}/.test(tok)) return [tok, rest]
  throw fail(`unrecognized value ${JSON.stringify(tok)}`)
}

function unescape(s) {
  return s.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/gs, (_, e) => {
    switch (e[0]) {
      case 'n': return '\n'
      case 't': return '\t'
      case 'r': return '\r'
      case 'b': return '\b'
      case 'f': return '\f'
      case '"': return '"'
      case '\\': return '\\'
      case 'u': case 'U': return String.fromCodePoint(parseInt(e.slice(1), 16))
      default: return e
    }
  })
}
