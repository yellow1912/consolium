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

describe("extended types", () => {
  it("QueryOptions accepts agentSessionId and systemPrompt", () => {
    const opts: import("./types").QueryOptions = {
      model: "claude-sonnet-4-6",
      agentSessionId: "some-uuid",
      systemPrompt: "You are an assistant.",
    }
    expect(opts.agentSessionId).toBe("some-uuid")
    expect(opts.systemPrompt).toBe("You are an assistant.")
  })
  it("AgentResponse accepts optional sessionId", () => {
    const resp: import("./types").AgentResponse = {
      agent: "claude", content: "hi", durationMs: 10, sessionId: "s-uuid",
    }
    expect(resp.sessionId).toBe("s-uuid")
  })
})
