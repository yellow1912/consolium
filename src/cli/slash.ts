export type SlashCommand = { command: string; args: string[] }

export function parseSlash(input: string): SlashCommand | null {
  const trimmed = input.trim()
  if (!trimmed.startsWith("/")) return null
  const parts = trimmed.slice(1).trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return null
  const [cmd, ...args] = parts
  return { command: cmd, args }
}
