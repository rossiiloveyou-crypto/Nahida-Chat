/** Archive-only filtering. Rendering and raw-message version hashes stay unchanged. */
const BLOCK_RULES = [
  /<think_[a-z0-9_]*>[\s\S]*?<\/think_[a-z0-9_]*\s*>/gi,
  /<StatusBlock(?:\s[^>]*)?>[\s\S]*?<\/StatusBlock\s*>/gi,
  /<options(?:\s[^>]*)?>[\s\S]*?<\/options\s*>/gi,
  /<summary(?:\s[^>]*)?>[\s\S]*?<\/summary\s*>/gi,
  /<comment(?:\s[^>]*)?>[\s\S]*?<\/comment\s*>/gi,
  /<!--[\s\S]*?-->/g
]

/** Unpaired fences stay intact; inline backticks are never fence boundaries. */
function stripPairedFences(text: string): string {
  const lines = text.split('\n')
  const balanced = lines.filter(line => /^[ \t]*\x60\x60\x60/.test(line)).length % 2 === 0
  let inFence = false
  const out: string[] = []
  for (const line of lines) {
    if (balanced && /^[ \t]*\x60\x60\x60/.test(line)) {
      inFence = !inFence
      continue
    }
    if (!inFence) out.push(line)
  }
  return out.join('\n')
}

export function sanitizeChunkText(text: string): string {
  // Complete game blocks take precedence, including nested cards and whitespace.
  const clean = (part: string): string => stripPairedFences(
    BLOCK_RULES.reduce((acc, rule) => acc.replace(rule, ''), part)
  ).replace(/\n{3,}/g, '\n\n').replace(/[ \t]+$/gm, '')
  const game = /<game(?:\s[^>]*)?>[\s\S]*?<\/game\s*>/gi
  let cursor = 0
  let result = ''
  for (const match of text.matchAll(game)) {
    result += clean(text.slice(cursor, match.index)) + match[0]
    cursor = match.index + match[0].length
  }
  return (result + clean(text.slice(cursor))).trim()
}
