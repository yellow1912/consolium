import { z } from "zod"

export const dispatchSelectionSchema = z.object({
  assignTo: z.string(),
  model: z.string().optional(),
  subPrompt: z.string().optional(),
})

export const pipelineReviewSchema = z.object({
  verdict: z.enum(["approved", "changes_requested"]),
  content: z.string(),
})

export type DispatchSelection = z.infer<typeof dispatchSelectionSchema>
export type PipelineReviewData = z.infer<typeof pipelineReviewSchema>

/**
 * Extracts and parses a JSON object from a potentially prose-wrapped string.
 * Supports:
 * - Markdown json blocks: ```json { ... } ``` or ``` { ... } ```
 * - First '{' and its matching closing '}' using a balanced-brace scanner
 */
export function extractJson(text: string): any {
  const trimmed = text.trim()
  
  // Try markdown json code block regex first
  const blockRegex = /```(?:json)?\s*([\s\S]*?)\s*```/
  const match = trimmed.match(blockRegex)
  if (match && match[1]) {
    try {
      return JSON.parse(match[1].trim())
    } catch {
      // If code block fails to parse, fall back to balanced brace scanner
    }
  }

  // Balanced brace scanner to find first '{' and its matching closing '}'
  const firstBrace = trimmed.indexOf("{")
  if (firstBrace >= 0) {
    let braceCount = 0
    let inString = false
    let escape = false
    
    for (let i = firstBrace; i < trimmed.length; i++) {
      const char = trimmed[i]
      if (escape) {
        escape = false
        continue
      }
      if (char === "\\") {
        escape = true
        continue
      }
      if (char === '"') {
        inString = !inString
        continue
      }
      if (!inString) {
        if (char === "{") {
          braceCount++
        } else if (char === "}") {
          braceCount--
          if (braceCount === 0) {
            const candidate = trimmed.substring(firstBrace, i + 1)
            try {
              return JSON.parse(candidate)
            } catch {
              // let scanner continue or fail
            }
          }
        }
      }
    }
  }

  // Try parsing the raw text directly
  return JSON.parse(trimmed)
}
