import { describe, it, expect } from "bun:test"
import { CodexAdapter } from "./codex"
import { GeminiAdapter } from "./gemini"
import { AgyAdapter } from "./agy"
import { SubprocessAdapter } from "./base"
import { buildBoundedContextPrompt } from "./context"
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

describe("AgyAdapter", () => {
  it("has correct name", () => { expect(new AgyAdapter().name).toBe("agy") })
  it("has correct bin", () => { expect(new AgyAdapter().bin).toBe("agy") })

  it("builds args correctly", () => {
    const args = new AgyAdapter().buildArgs("my prompt")
    expect(args).toContain("my prompt")
    expect(args).toContain("-p")
    expect(args).toContain("--dangerously-skip-permissions")
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

  it("does not retry on non-model errors", async () => {
    class TestAdapter extends SubprocessAdapter {
      readonly name = "test"
      readonly bin = "test-bin"
      getModels = async () => []
      buildArgs(prompt: string, options?: QueryOptions) {
        return options?.model ? ["--model", options.model, prompt] : [prompt]
      }
    }
    const adapter = new TestAdapter()
    let callCount = 0
    ;(adapter as any).spawnAndRead = async () => {
      callCount++
      return { exitCode: 1, stdout: "", stderr: "permission denied" }
    }
    await expect(adapter.query("hello", [], { model: "some-model" })).rejects.toThrow("permission denied")
    expect(callCount).toBe(1)
  })

  it("throws retry error when fallback also fails", async () => {
    class TestAdapter extends SubprocessAdapter {
      readonly name = "test"
      readonly bin = "test-bin"
      getModels = async () => []
      buildArgs(prompt: string, options?: QueryOptions) {
        return options?.model ? ["--model", options.model, prompt] : [prompt]
      }
    }
    const adapter = new TestAdapter()
    let callCount = 0
    ;(adapter as any).spawnAndRead = async () => {
      callCount++
      if (callCount === 1) return { exitCode: 1, stdout: "", stderr: "unknown model: bad-model" }
      return { exitCode: 1, stdout: "", stderr: "default model also unavailable" }
    }
    await expect(adapter.query("hello", [], { model: "bad-model" })).rejects.toThrow("default model also unavailable")
    expect(callCount).toBe(2)
  })
})

describe("Bounded Context Prompt Builder", () => {
  it("returns plain prompt when context is empty", () => {
    const prompt = "hello world"
    const result = buildBoundedContextPrompt(prompt, [])
    expect(result).toBe("hello world")
  })

  it("builds correct chronological prompt when context fits entirely", () => {
    const context = [
      { role: "user" as const, agent: null, content: "First turn" },
      { role: "agent" as const, agent: "claude", content: "Response one" },
    ]
    const result = buildBoundedContextPrompt("Next turn", context)
    expect(result).toContain("[user]: First turn")
    expect(result).toContain("[claude]: Response one")
    expect(result).toContain("[user]: Next turn")
    expect(result).not.toContain("Omitted")
  })

  it("truncates older history turns when character boundary is exceeded", () => {
    const context = [
      { role: "user" as const, agent: null, content: "This is a very long first turn that will be omitted" },
      { role: "agent" as const, agent: "gemini", content: "Short recent response" },
    ]
    // Bound to 130: fits prompt + recent turn + omitted banner but not the long first turn
    const result = buildBoundedContextPrompt("Next prompt", context, 130)
    expect(result).toContain("[gemini]: Short recent response")
    expect(result).toContain("[user]: Next prompt")
    expect(result).toContain("Omitted 1 older history turns")
    expect(result).not.toContain("omitted") // "omitted" from the first turn is not there
  })

  it("truncates all history when even the second turn does not fit", () => {
    const context = [
      { role: "user" as const, agent: null, content: "First turn" },
      { role: "agent" as const, agent: "claude", content: "This is a super long turn that will not fit" },
    ]
    // Bound characters strictly to 50, which only fits the next prompt itself
    const result = buildBoundedContextPrompt("Next prompt", context, 50)
    expect(result).toContain("[user]: Next prompt")
    expect(result).toContain("Omitted 2 older history turns")
    expect(result).not.toContain("First turn")
    expect(result).not.toContain("super long")
  })
})
