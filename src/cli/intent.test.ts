import { describe, it, expect } from "bun:test"
import { classifyIntent } from "./intent"

function makeClassifier(response: string) {
  return {
    name: "mock",
    query: async () => ({ agent: "mock", content: response, durationMs: 0 }),
    isAvailable: async () => true,
    getModels: async () => [],
  }
}

const mockRegistry = {
  all: () => [{ name: "claude" }, { name: "gemini" }],
}

describe("classifyIntent", () => {
  it("returns command for mode switch", async () => {
    const result = await classifyIntent(
      "switch to debate mode",
      makeClassifier('{"type":"command","command":"mode","args":["debate"]}') as any,
      mockRegistry as any,
    )
    expect(result).toEqual({ type: "command", command: "mode", args: ["debate"] })
  })

  it("returns message for regular input", async () => {
    const result = await classifyIntent(
      "what is quantum computing?",
      makeClassifier('{"type":"message"}') as any,
      mockRegistry as any,
    )
    expect(result).toEqual({ type: "message" })
  })

  it("falls back to message on bad JSON", async () => {
    const result = await classifyIntent(
      "whatever",
      makeClassifier("not json") as any,
      mockRegistry as any,
    )
    expect(result).toEqual({ type: "message" })
  })

  it("falls back to message on unexpected shape", async () => {
    const result = await classifyIntent(
      "whatever",
      makeClassifier('{"type":"unknown"}') as any,
      mockRegistry as any,
    )
    expect(result).toEqual({ type: "message" })
  })

  it("handles command with no args", async () => {
    const result = await classifyIntent(
      "show me all agents",
      makeClassifier('{"type":"command","command":"agents","args":[]}') as any,
      mockRegistry as any,
    )
    expect(result).toEqual({ type: "command", command: "agents", args: [] })
  })

  it("returns command with followup for setup request", async () => {
    const result = await classifyIntent(
      "setup a debate about whether I should buy an iPhone",
      makeClassifier('{"type":"command","command":"mode","args":["debate"],"followup":"whether I should buy an iPhone"}') as any,
      mockRegistry as any,
    )
    expect(result).toEqual({
      type: "command",
      command: "mode",
      args: ["debate"],
      followup: "whether I should buy an iPhone",
    })
  })
})
