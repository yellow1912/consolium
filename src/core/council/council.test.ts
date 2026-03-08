import { describe, it, expect } from "bun:test"
import { CouncilRunner } from "./index"
import type { AgentAdapter, Message } from "../adapters/types"

const mock = (name: string, response: string): AgentAdapter => ({
  name,
  isAvailable: async () => true,
  getModels: async () => [],
  query: async () => ({ agent: name, content: response, durationMs: 1 }),
})

describe("council mode", () => {
  it("queries all non-router agents in parallel and returns responses + synthesis", async () => {
    const runner = new CouncilRunner({
      router: mock("claude", "synthesized answer"),
      adapters: [mock("codex", "codex answer"), mock("gemini", "gemini answer")],
    })
    const result = await runner.council("what is 2+2?", [])
    expect(result.responses).toHaveLength(2)
    expect(result.responses.map(r => r.agent)).toContain("codex")
    expect(result.responses.map(r => r.agent)).toContain("gemini")
    expect(result.synthesis).toBe("synthesized answer")
  })

  it("router is excluded from council respondents", async () => {
    const called: string[] = []
    const trackingAdapter = (name: string): AgentAdapter => ({
      name,
      isAvailable: async () => true,
      getModels: async () => [],
      query: async () => { called.push(name); return { agent: name, content: "ok", durationMs: 1 } },
    })
    const runner = new CouncilRunner({
      router: trackingAdapter("claude"),
      adapters: [trackingAdapter("codex"), trackingAdapter("gemini")],
    })
    await runner.council("question", [])
    // router (claude) is called for synthesis but not as a respondent
    const respondentCalls = called.filter(n => n !== "claude")
    expect(respondentCalls).toHaveLength(2)
    expect(respondentCalls).toContain("codex")
    expect(respondentCalls).toContain("gemini")
  })
})

describe("dispatch mode", () => {
  it("router assigns task to one agent", async () => {
    const runner = new CouncilRunner({
      router: mock("claude", JSON.stringify({ assignTo: "codex" })),
      adapters: [mock("codex", "codex did the work"), mock("gemini", "gemini response")],
    })
    const result = await runner.dispatch("write a function", [])
    expect(result.agent).toBe("codex")
    expect(result.content).toBe("codex did the work")
  })

  it("falls back to first adapter if router JSON is malformed", async () => {
    const runner = new CouncilRunner({
      router: mock("claude", "not json"),
      adapters: [mock("codex", "fallback response"), mock("gemini", "")],
    })
    const result = await runner.dispatch("task", [])
    expect(result.agent).toBe("codex")
  })
})

describe("pipeline mode", () => {
  it("executes task then peer-reviews", async () => {
    const runner = new CouncilRunner({
      router: mock("claude", JSON.stringify({ assignTo: "codex" })),
      adapters: [
        mock("codex", "here is my code"),
        mock("gemini", JSON.stringify({ verdict: "approved", content: "looks good" })),
      ],
    })
    const result = await runner.pipeline("write a function", [])
    expect(result.taskContent).toBe("here is my code")
    expect(result.reviews).toHaveLength(1)
    expect(result.reviews[0].reviewer).toBe("gemini")
    expect(result.reviews[0].verdict).toBe("approved")
    expect(result.approved).toBe(true)
  })

  it("approved is false if any reviewer requests changes", async () => {
    const runner = new CouncilRunner({
      router: mock("claude", JSON.stringify({ assignTo: "codex" })),
      adapters: [
        mock("codex", "draft code"),
        mock("gemini", JSON.stringify({ verdict: "changes_requested", content: "needs work" })),
      ],
    })
    const result = await runner.pipeline("write a function", [])
    expect(result.approved).toBe(false)
  })
})
