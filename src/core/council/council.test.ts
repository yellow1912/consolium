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

describe("modelOverrides in dispatch", () => {
  it("uses modelOverrides in dispatch router prompt instead of getModels()", async () => {
    let capturedPrompt = ""
    const router: AgentAdapter = {
      name: "claude",
      isAvailable: async () => true,
      getModels: async () => [],
      query: async (p: string) => {
        capturedPrompt = p
        return { agent: "claude", content: '{"assignTo":"codex","model":"fast-model"}', durationMs: 1 }
      },
    }
    const codex: AgentAdapter = {
      name: "codex",
      isAvailable: async () => true,
      getModels: async () => [{ id: "slow-model", name: "Slow", capabilities: ["coding"] }],
      query: async () => ({ agent: "codex", content: "ok", durationMs: 1 }),
    }
    const runner = new CouncilRunner({
      router,
      adapters: [codex],
      modelOverrides: { codex: ["fast-model", "other-model"] },
    })
    await runner.dispatch("do something", [])
    // router prompt should contain the cached override models, not getModels() result
    expect(capturedPrompt).toContain("fast-model")
    expect(capturedPrompt).toContain("other-model")
    expect(capturedPrompt).not.toContain("slow-model")
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

describe("debate mode", () => {
  it("round 1 collects responses from all agents", async () => {
    const runner = new CouncilRunner({
      router: mock("claude", "synthesized"),
      adapters: [mock("codex", "codex opinion"), mock("gemini", "gemini opinion")],
    })
    const result = await runner.debate("what is best?", [], { maxRounds: 3 })
    expect(result.rounds[0]).toHaveLength(2)
    expect(result.rounds[0].map(r => r.agent)).toContain("codex")
    expect(result.rounds[0].map(r => r.agent)).toContain("gemini")
  })

  it("agents that pass are excluded from subsequent rounds output", async () => {
    let callCount = 0
    const passingAdapter: AgentAdapter = {
      name: "gemini",
      isAvailable: async () => true,
      getModels: async () => [],
      query: async () => {
        callCount++
        // round 1: speaks; round 2+: passes
        if (callCount === 1) return { agent: "gemini", content: "gemini opinion", durationMs: 1 }
        return { agent: "gemini", content: JSON.stringify({ pass: true }), durationMs: 1 }
      },
    }
    const runner = new CouncilRunner({
      router: mock("claude", "synthesis"),
      adapters: [mock("codex", JSON.stringify({ pass: true })), passingAdapter],
    })
    const result = await runner.debate("topic", [], { maxRounds: 3 })
    // round 2: codex passes, gemini passes → all pass → stop
    expect(result.consensusReached).toBe(true)
    expect(result.roundCount).toBe(2)
    // round 2 has no non-pass responses
    expect(result.rounds[1]).toHaveLength(0)
  })

  it("stops at maxRounds even if agents keep responding", async () => {
    const runner = new CouncilRunner({
      router: mock("claude", "synthesis"),
      adapters: [
        mock("codex", JSON.stringify({ pass: false, content: "still debating" })),
        mock("gemini", JSON.stringify({ pass: false, content: "me too" })),
      ],
    })
    const result = await runner.debate("topic", [], { maxRounds: 2 })
    expect(result.roundCount).toBe(2)
    expect(result.rounds).toHaveLength(2)
    expect(result.consensusReached).toBe(false)
  })

  it("router synthesizes at the end", async () => {
    const runner = new CouncilRunner({
      router: mock("claude", "final synthesis"),
      adapters: [mock("codex", "opinion"), mock("gemini", JSON.stringify({ pass: true }))],
    })
    const result = await runner.debate("topic", [], { maxRounds: 1 })
    expect(result.synthesis).toBe("final synthesis")
  })

  it("router synthesizes after consensus is reached", async () => {
    let codexCall = 0
    const codexAdapter: import("../adapters/types").AgentAdapter = {
      name: "codex",
      isAvailable: async () => true,
      getModels: async () => [],
      query: async () => {
        codexCall++
        if (codexCall === 1) return { agent: "codex", content: "codex says something", durationMs: 1 }
        return { agent: "codex", content: JSON.stringify({ pass: true }), durationMs: 1 }
      },
    }
    const runner2 = new CouncilRunner({
      router: mock("claude", "consensus synthesis"),
      adapters: [codexAdapter, mock("gemini", JSON.stringify({ pass: true }))],
    })
    const result = await runner2.debate("topic", [], { maxRounds: 5 })
    expect(result.consensusReached).toBe(true)
    expect(result.synthesis).toBe("consensus synthesis")
  })
})
