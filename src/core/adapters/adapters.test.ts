import { describe, it, expect } from "bun:test"
import { CodexAdapter } from "./codex"
import { GeminiAdapter } from "./gemini"

describe("CodexAdapter", () => {
  it("has correct name", () => { expect(new CodexAdapter().name).toBe("codex") })

  it("query returns correct shape", async () => {
    const adapter = new CodexAdapter()
    ;(adapter as any)._query = async () => "codex response"
    const result = await adapter.query("test", [])
    expect(result.agent).toBe("codex")
    expect(result.content).toBe("codex response")
    expect(typeof result.durationMs).toBe("number")
  })

  it("builds context prompt", async () => {
    const adapter = new CodexAdapter()
    let captured = ""
    ;(adapter as any)._query = async (p: string) => { captured = p; return "ok" }
    await adapter.query("question", [{ role: "user" as const, agent: null, content: "context" }])
    expect(captured).toContain("context")
    expect(captured).toContain("question")
  })
})

describe("GeminiAdapter", () => {
  it("has correct name", () => { expect(new GeminiAdapter().name).toBe("gemini") })
  it("has correct bin", () => { expect(new GeminiAdapter().bin).toBe("gemini") })

  it("builds args correctly", () => {
    const args = new GeminiAdapter().buildArgs("my prompt")
    expect(args).toContain("my prompt")
    expect(args).toContain("-m")
    expect(args).toContain("gemini-2.0-flash")
  })
})
