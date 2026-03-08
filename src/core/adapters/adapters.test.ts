import { describe, it, expect } from "bun:test"
import { CodexAdapter } from "./codex"
import { GeminiAdapter } from "./gemini"

describe("CodexAdapter", () => {
  it("has correct name", () => { expect(new CodexAdapter().name).toBe("codex") })
  it("has correct bin", () => { expect(new CodexAdapter().bin).toBe("codex") })

  it("builds args with no model by default", () => {
    const args = new CodexAdapter().buildArgs("my prompt")
    expect(args[0]).toBe("exec")
    expect(args).toContain("my prompt")
    expect(args).toContain("approval_policy=never")
    expect(args.join(" ")).not.toContain("model=")
  })

  it("builds args with model when specified", () => {
    const args = new CodexAdapter("gpt-4o").buildArgs("my prompt")
    expect(args).toContain("model=gpt-4o")
  })

  it("builds context prompt", async () => {
    const adapter = new CodexAdapter()
    let captured: string[] = []
    ;(adapter as any).query = async (prompt: string, ctx: any[]) => {
      captured = (adapter as any).buildArgs((adapter as any).buildContextPrompt(prompt, ctx))
      return { agent: "codex", content: "ok", durationMs: 0 }
    }
    await adapter.query("question", [{ role: "user" as const, agent: null, content: "context" }])
    expect(captured.join(" ")).toContain("context")
    expect(captured.join(" ")).toContain("question")
  })
})

describe("GeminiAdapter", () => {
  it("has correct name", () => { expect(new GeminiAdapter().name).toBe("gemini") })
  it("has correct bin", () => { expect(new GeminiAdapter().bin).toBe("gemini") })

  it("builds args with no model by default", () => {
    const args = new GeminiAdapter().buildArgs("my prompt")
    expect(args).toContain("my prompt")
    expect(args).toContain("-p")
    expect(args).toContain("--yolo")
    expect(args).not.toContain("-m")
  })

  it("builds args with model when specified", () => {
    const args = new GeminiAdapter("gemini-2.5-pro").buildArgs("my prompt")
    expect(args).toContain("-m")
    expect(args).toContain("gemini-2.5-pro")
  })
})
