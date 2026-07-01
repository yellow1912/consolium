export type SlashCommand = { command: string; args: string[] }

/**
 * Tokenize a slash command string, respecting single and double quoted spans.
 * Quoted tokens may contain spaces: /start claude --cwd "/My Projects/app"
 */
function tokenize(input: string): string[] {
  const tokens: string[] = []
  let current = ""
  let quote: '"' | "'" | null = null
  let inToken = false  // true once a non-space char or opening quote is seen

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (quote) {
      if (ch === quote) {
        quote = null  // closing quote — inToken already true from when we opened
      } else {
        current += ch
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch
      inToken = true  // opening a quote starts a token (may stay empty for "")
    } else if (/\s/.test(ch)) {
      if (inToken) { tokens.push(current); current = ""; inToken = false }
    } else {
      current += ch
      inToken = true
    }
  }
  // flush remaining (handles unclosed quotes and normal trailing tokens)
  if (inToken) tokens.push(current)
  return tokens
}

export function parseSlash(input: string): SlashCommand | null {
  const trimmed = input.trim()
  if (!trimmed.startsWith("/")) return null
  const parts = tokenize(trimmed.slice(1).trim())
  if (parts.length === 0) return null
  const [cmd, ...args] = parts
  return { command: cmd, args }
}
