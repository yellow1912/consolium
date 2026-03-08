import { describe, it, expect } from "bun:test"
import { ClaudeAdapter } from "./claude"

describe("ClaudeAdapter", () => {
  it("has correct name", () => {
    expect(new ClaudeAdapter().name).toBe("claude")
  })

  it("query returns AgentResponse shape", async () => {
    const adapter = new ClaudeAdapter()
    // Override the protected _query method for testing without real API calls
    ;(adapter as any)._query = async () => "mocked response"
    const result = await adapter.query("hello", [])
    expect(result.agent).toBe("claude")
    expect(result.content).toBe("mocked response")
    expect(typeof result.durationMs).toBe("number")
  })

  it("query builds context prompt correctly", async () => {
    const adapter = new ClaudeAdapter()
    let capturedPrompt = ""
    ;(adapter as any)._query = async (p: string) => { capturedPrompt = p; return "ok" }
    const context = [{ role: "user" as const, agent: null, content: "prior message" }]
    await adapter.query("new prompt", context)
    expect(capturedPrompt).toContain("prior message")
    expect(capturedPrompt).toContain("new prompt")
  })
})
