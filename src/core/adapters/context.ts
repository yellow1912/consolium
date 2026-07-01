import type { Message } from "./types"

const STOP_WORDS = new Set([
  "a","an","the","is","are","was","were","it","this","that","to","of",
  "in","and","or","for","with","on","at","by","as","be","has","had",
  "have","do","did","not","but","so","if","my","your","we","you","i",
  "me","he","she","they","what","how","when","where","who","which",
])

// Number of most-recent turns always included regardless of relevance score
const RECENCY_ANCHOR = 2

function normalizeContent(content: string): string {
  return content
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function tokenize(text: string): Set<string> {
  const words = text.toLowerCase().match(/\b[a-z]{3,}\b/g) ?? []
  return new Set(words.filter(w => !STOP_WORDS.has(w)))
}

function scoreRelevance(content: string, promptTokens: Set<string>, recencyScore: number): number {
  if (promptTokens.size === 0) return recencyScore
  const contentTokens = tokenize(content)
  let overlap = 0
  for (const word of contentTokens) {
    if (promptTokens.has(word)) overlap++
  }
  const relevance = Math.min(1, overlap / promptTokens.size)
  return 0.7 * relevance + 0.3 * recencyScore
}

/**
 * Builds a bounded context prompt using relevance-aware turn selection.
 *
 * Selection strategy (within maxChars budget):
 *   1. Always include the last RECENCY_ANCHOR turns for conversation continuity.
 *   2. Score older turns by weighted keyword overlap with the current prompt + recency.
 *   3. Greedily include highest-scoring turns until budget is exhausted.
 *   4. Re-sort selected turns chronologically before output.
 *
 * This ensures the prompt retains both high-signal older context and recent turns,
 * rather than blindly dropping old turns when the budget is full.
 */
export function buildBoundedContextPrompt(prompt: string, context: Message[], maxChars = 16000): string {
  if (context.length === 0) return prompt

  const promptPart = `\n\n[user]: ${prompt}`
  const omittedBannerBudget = `[... Omitted ${context.length} older history turns due to context length limits ...]\n`.length
  let remainingChars = Math.max(0, maxChars - promptPart.length - omittedBannerBudget + 1)

  const turns = context.map((msg, i) => ({
    str: `[${msg.agent ?? msg.role}]: ${normalizeContent(msg.content)}`,
    index: i,
  }))

  const anchorStart = Math.max(0, turns.length - RECENCY_ANCHOR)
  const anchors = turns.slice(anchorStart)
  const candidates = turns.slice(0, anchorStart)

  const promptTokens = tokenize(prompt)
  const totalTurns = turns.length
  const scored = candidates
    .map(t => ({
      ...t,
      score: scoreRelevance(t.str, promptTokens, t.index / Math.max(1, totalTurns - 1)),
    }))
    .sort((a, b) => b.score - a.score)

  const selected: Array<{ str: string; index: number }> = []

  for (const t of anchors) {
    const len = t.str.length + 1
    if (remainingChars >= len) {
      selected.push(t)
      remainingChars -= len
    }
  }

  for (const t of scored) {
    const len = t.str.length + 1
    if (remainingChars >= len) {
      selected.push(t)
      remainingChars -= len
    }
  }

  selected.sort((a, b) => a.index - b.index)

  const omittedCount = turns.length - selected.length
  let history = selected.map(t => t.str).join("\n")
  if (omittedCount > 0) {
    history = `[... Omitted ${omittedCount} older history turns due to context length limits ...]\n${history}`
  }

  return `${history}${promptPart}`
}

export function buildCoTPrompt(prompt: string): string {
  return `${prompt}\n\nThink step by step before answering. Structure your response exactly as:\n[THINKING]\n<your reasoning>\n[ANSWER]\n<your final answer>`
}

export function extractCoTAnswer(response: string): string {
  const match = response.match(/[\s\S]*\[ANSWER\]\s*([\s\S]+)$/i)
  return match ? match[1].trim() : response
}
