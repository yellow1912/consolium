import type { Message } from "./types"

/**
 * Builds a chronological prompt with bounded character history,
 * preserving recent turns and the latest prompt entirely.
 * If older turns are omitted, the agent is notified via a clear placeholder.
 */
export function buildBoundedContextPrompt(prompt: string, context: Message[], maxChars = 16000): string {
  if (context.length === 0) return prompt
  
  const promptPart = `\n\n[user]: ${prompt}`
  let remainingChars = maxChars - promptPart.length
  
  const turnsToInclude: string[] = []
  let omittedCount = 0
  
  // Traverse from newest to oldest messages
  for (let i = context.length - 1; i >= 0; i--) {
    const msg = context[i]
    const turnStr = `[${msg.agent ?? msg.role}]: ${msg.content}`
    const turnLen = turnStr.length + 1 // +1 for newline character
    
    if (remainingChars >= turnLen) {
      turnsToInclude.unshift(turnStr)
      remainingChars -= turnLen
    } else {
      omittedCount = i + 1
      break
    }
  }
  
  let history = turnsToInclude.join("\n")
  if (omittedCount > 0) {
    history = `[... Omitted ${omittedCount} older history turns due to context length limits ...]\n${history}`
  }
  
  return `${history}${promptPart}`
}

export function buildCoTPrompt(prompt: string): string {
  return `${prompt}\n\nThink step by step before answering. Structure your response exactly as:\n[THINKING]\n<your reasoning>\n[ANSWER]\n<your final answer>`
}

export function extractCoTAnswer(response: string): string {
  const match = response.match(/\[ANSWER\]\s*([\s\S]+)$/i)
  return match ? match[1].trim() : response
}
