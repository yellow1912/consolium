import { describe, it, expect } from "bun:test"
import type { AgentAdapter, Message } from "./types"

describe("AgentAdapter interface", () => {
  it("mock adapter satisfies interface", async () => {
    const adapter: AgentAdapter = {
      name: "mock",
      isAvailable: async () => true,
      query: async (prompt) => ({ agent: "mock", content: `echo: ${prompt}`, durationMs: 1 }),
    }
    const result = await adapter.query("hello", [])
    expect(result.agent).toBe("mock")
    expect(result.content).toBe("echo: hello")
  })

  it("adapter receives context messages", async () => {
    const received: Message[] = []
    const adapter: AgentAdapter = {
      name: "mock",
      isAvailable: async () => true,
      query: async (_prompt, context) => {
        received.push(...context)
        return { agent: "mock", content: "ok", durationMs: 1 }
      },
    }
    await adapter.query("new prompt", [{ role: "user", agent: null, content: "prior message" }])
    expect(received).toHaveLength(1)
    expect(received[0].content).toBe("prior message")
  })
})
