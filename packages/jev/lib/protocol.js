export function parsePayload(source) {
  if (Buffer.byteLength(source) > 1048576) throw new Error('jev protocol error: response too large')
  let result
  try {result = JSON.parse(source)} catch {throw new Error('jev returned a non-JSON body')}
  let cursor = 0
  const whitespace = () => {while (/\s/.test(source[cursor] ?? '') && cursor < source.length) cursor++}
  const string = () => {const start = cursor++; while (cursor < source.length) {if (source[cursor] === '\\') {cursor += 2; continue} if (source[cursor++] === '"') break} return JSON.parse(source.slice(start,cursor))}
  const visit = depth => {
    if (depth > 64) throw new Error('jev protocol error: response nesting')
    whitespace()
    if (source[cursor] === '{') {
      cursor++; whitespace(); const used = new Set()
      if (source[cursor] === '}') {cursor++; return}
      while (true) {whitespace(); const key = string(); if (used.has(key)) throw new Error('jev protocol error: duplicate key'); used.add(key); whitespace(); cursor++; visit(depth+1); whitespace(); if (source[cursor++] === '}') break}
    } else if (source[cursor] === '[') {
      cursor++; whitespace(); if (source[cursor] === ']') {cursor++; return}
      while (true) {visit(depth+1); whitespace(); if (source[cursor++] === ']') break}
    } else if (source[cursor] === '"') string()
    else {while(cursor < source.length && !/[\s,}\]]/.test(source[cursor])) cursor++}
  }
  visit(0)
  return result
}
