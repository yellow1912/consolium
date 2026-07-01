export type SlashCommand = { command: string; args: string[] }

/**
 * Tokenize a slash command string, respecting single and double quoted spans.
 * Quoted tokens may contain spaces: /start claude --cwd "/My Projects/app"
 */
function tokenize(input: string): string[] {
  const tokens: string[] = []
  let current = ""
  let quote: '"' | "'" | null = null

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (quote) {
      if (ch === quote) {
        quote = null
      } else {
        current += ch
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (/\s/.test(ch)) {
      if (current) { tokens.push(current); current = "" }
    } else {
      current += ch
    }
  }
  if (current) tokens.push(current)
  return tokens
}

export function parseSlash(input: string): SlashCommand | null {
  const trimmed = input.trim()
  if (!trimmed.startsWith("/")) return null
  const parts = tokenize(trimmed.slice(1).trim()).filter(Boolean)
  if (parts.length === 0) return null
  const [cmd, ...args] = parts
  return { command: cmd, args }
}
