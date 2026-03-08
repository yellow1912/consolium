import { describe, it, expect } from "bun:test"
import { CodexAdapter } from "./codex"
import { GeminiAdapter } from "./gemini"
import { SubprocessAdapter } from "./base"
import type { QueryOptions, ModelInfo } from "./types"

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

describe("SubprocessAdapter fallback", () => {
  it("retries without model option on model-not-found error", async () => {
    const calls: Array<{ args: string[] }> = []
    class TestAdapter extends SubprocessAdapter {
      readonly name = "test"
      readonly bin = "test-bin"
      getModels = async (): Promise<ModelInfo[]> => []
      buildArgs(prompt: string, options?: QueryOptions) {
        calls.push({ args: options?.model ? ["--model", options.model, prompt] : [prompt] })
        return options?.model ? ["--model", options.model, prompt] : [prompt]
      }
    }
    const adapter = new TestAdapter()
    // First call (with model) fails with model error, second (no model) succeeds
    let callCount = 0
    ;(adapter as any).spawnAndRead = async (args: string[]) => {
      callCount++
      if (callCount === 1) return { exitCode: 1, stdout: "", stderr: "unknown model: bad-model" }
      return { exitCode: 0, stdout: "ok response", stderr: "" }
    }
    const result = await adapter.query("hello", [], { model: "bad-model" })
    expect(result.content).toBe("ok response")
    expect(callCount).toBe(2)
  })
})
