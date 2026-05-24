import { describe, it, expect } from "bun:test"
import { extractJson, dispatchSelectionSchema, pipelineReviewSchema } from "./router-utils"

describe("extractJson and Schema validation", () => {
  it("parses pure valid JSON", () => {
    const raw = `{"assignTo": "claude", "model": "sonnet"}`
    const result = extractJson(raw)
    expect(result).toEqual({ assignTo: "claude", model: "sonnet" })
    expect(dispatchSelectionSchema.safeParse(result).success).toBe(true)
  })

  it("extracts and parses markdown-wrapped JSON code blocks", () => {
    const raw = "```json\n{\n  \"assignTo\": \"gemini\",\n  \"model\": \"pro\"\n}\n```"
    const result = extractJson(raw)
    expect(result).toEqual({ assignTo: "gemini", model: "pro" })
    expect(dispatchSelectionSchema.safeParse(result).success).toBe(true)
  })

  it("extracts and parses plain markdown code blocks", () => {
    const raw = "```\n{\n  \"assignTo\": \"agy\"\n}\n```"
    const result = extractJson(raw)
    expect(result).toEqual({ assignTo: "agy" })
    expect(dispatchSelectionSchema.safeParse(result).success).toBe(true)
  })

  it("extracts JSON from surrounding prose using balanced-brace scanner", () => {
    const raw = "Hello, I made a routing decision: {\n  \"assignTo\": \"codex\"\n} let me know if you need anything else."
    const result = extractJson(raw)
    expect(result).toEqual({ assignTo: "codex" })
    expect(dispatchSelectionSchema.safeParse(result).success).toBe(true)
  })

  it("extracts outer balanced object instead of using greedy matching", () => {
    const raw = "Prose before {\"assignTo\": \"gemini\"} intermediate prose {\"other\": \"info\"} prose after"
    const result = extractJson(raw)
    expect(result).toEqual({ assignTo: "gemini" })
    expect(dispatchSelectionSchema.safeParse(result).success).toBe(true)
  })

  it("correctly parses review response", () => {
    const raw = "```json\n{\n  \"verdict\": \"approved\",\n  \"content\": \"Great code!\"\n}\n```"
    const result = extractJson(raw)
    expect(result).toEqual({ verdict: "approved", content: "Great code!" })
    expect(pipelineReviewSchema.safeParse(result).success).toBe(true)
  })

  it("fails validation for missing fields in review schema", () => {
    const raw = `{"content": "missing verdict"}`
    const result = extractJson(raw)
    expect(pipelineReviewSchema.safeParse(result).success).toBe(false)
  })

  it("fails validation for invalid verdict enum value", () => {
    const raw = `{"verdict": "invalid_verdict", "content": "bad review"}`
    const result = extractJson(raw)
    expect(pipelineReviewSchema.safeParse(result).success).toBe(false)
  })
})
