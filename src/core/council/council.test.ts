import { describe, it, expect } from "bun:test"
import { CouncilRunner } from "./index"
import type { AgentAdapter, Message } from "../adapters/types"

function mockAdapter(name: string) {
  return {
    name,
    query: async (_p: string, _c: unknown, _o?: unknown) => ({
      agent: name, content: `${name} response`, durationMs: 0, sessionId: `${name}-session`,
    }),
    isAvailable: async () => true,
    getModels: async () => [],
  }
}

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

describe("council onAgentComplete callback", () => {
  it("fires for each agent as it responds", async () => {
    const completed: string[] = []
    const runner = new CouncilRunner({
      router: mock("claude", "synthesis"),
      adapters: [mock("codex", "codex answer"), mock("gemini", "gemini answer")],
    })
    await runner.council("question", [], {
      onAgentComplete: (resp) => completed.push(resp.agent),
    })
    expect(completed).toContain("codex")
    expect(completed).toContain("gemini")
    expect(completed).toHaveLength(2)
  })

  it("fires before synthesis is returned", async () => {
    const order: string[] = []
    const runner = new CouncilRunner({
      router: mock("claude", "synthesis"),
      adapters: [mock("codex", "codex answer")],
    })
    const result = await runner.council("question", [], {
      onAgentComplete: () => order.push("agent"),
    })
    order.push("synthesis")
    expect(order[0]).toBe("agent")
    expect(result.synthesis).toBe("synthesis")
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

describe("dispatch onRouted callback", () => {
  it("fires with agent name and selected model", async () => {
    let routedAgent = ""
    let routedModel: string | undefined
    const runner = new CouncilRunner({
      router: mock("claude", JSON.stringify({ assignTo: "codex", model: "codex-mini" })),
      adapters: [mock("codex", "result")],
    })
    await runner.dispatch("task", [], {
      onRouted: (agent, model) => { routedAgent = agent; routedModel = model },
    })
    expect(routedAgent).toBe("codex")
    expect(routedModel).toBe("codex-mini")
  })

  it("fires with undefined model when router omits it", async () => {
    let routedModel: string | undefined = "sentinel"
    const runner = new CouncilRunner({
      router: mock("claude", JSON.stringify({ assignTo: "codex" })),
      adapters: [mock("codex", "result")],
    })
    await runner.dispatch("task", [], {
      onRouted: (_agent, model) => { routedModel = model },
    })
    expect(routedModel).toBeUndefined()
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

describe("pipeline callbacks", () => {
  it("onRouted fires with executor name and model", async () => {
    let routedExecutor = ""
    let routedModel: string | undefined
    const runner = new CouncilRunner({
      router: mock("claude", JSON.stringify({ assignTo: "codex", model: "codex-mini" })),
      adapters: [
        mock("codex", "the work"),
        mock("gemini", JSON.stringify({ verdict: "approved", content: "ok" })),
      ],
    })
    await runner.pipeline("task", [], {
      onRouted: (executor, model) => { routedExecutor = executor; routedModel = model },
    })
    expect(routedExecutor).toBe("codex")
    expect(routedModel).toBe("codex-mini")
  })

  it("onExecutorComplete fires with executor content before reviews", async () => {
    const order: string[] = []
    const runner = new CouncilRunner({
      router: mock("claude", JSON.stringify({ assignTo: "codex" })),
      adapters: [
        mock("codex", "the work"),
        mock("gemini", JSON.stringify({ verdict: "approved", content: "ok" })),
      ],
    })
    await runner.pipeline("task", [], {
      onExecutorComplete: (content) => { order.push(`executor:${content}`) },
      onReviewComplete: (review) => { order.push(`review:${review.reviewer}`) },
    })
    expect(order[0]).toBe("executor:the work")
    expect(order[1]).toBe("review:gemini")
  })

  it("onReviewComplete fires for each reviewer with verdict and content", async () => {
    const reviews: { reviewer: string; verdict: string }[] = []
    const runner = new CouncilRunner({
      router: mock("claude", JSON.stringify({ assignTo: "codex" })),
      adapters: [
        mock("codex", "the work"),
        mock("gemini", JSON.stringify({ verdict: "changes_requested", content: "needs work" })),
      ],
    })
    await runner.pipeline("task", [], {
      onReviewComplete: (r) => reviews.push({ reviewer: r.reviewer, verdict: r.verdict }),
    })
    expect(reviews).toHaveLength(1)
    expect(reviews[0].reviewer).toBe("gemini")
    expect(reviews[0].verdict).toBe("changes_requested")
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

describe("reviewContent", () => {
  it("fires onReviewComplete for each reviewer", async () => {
    const completed: string[] = []
    const runner = new CouncilRunner({
      router: mock("claude", ""),
      adapters: [
        mock("codex", JSON.stringify({ verdict: "approved", content: "looks good" })),
        mock("gemini", JSON.stringify({ verdict: "changes_requested", content: "needs work" })),
      ],
    })
    await runner.reviewContent("some content", "original prompt", {
      onReviewComplete: (r) => completed.push(r.reviewer),
    })
    expect(completed).toContain("codex")
    expect(completed).toContain("gemini")
  })

  it("returns approved: true when all reviewers approve", async () => {
    const runner = new CouncilRunner({
      router: mock("claude", ""),
      adapters: [
        mock("codex", JSON.stringify({ verdict: "approved", content: "ok" })),
        mock("gemini", JSON.stringify({ verdict: "approved", content: "ok" })),
      ],
    })
    const result = await runner.reviewContent("content", "prompt")
    expect(result.approved).toBe(true)
    expect(result.reviews).toHaveLength(2)
  })

  it("returns approved: false when any reviewer requests changes", async () => {
    const runner = new CouncilRunner({
      router: mock("claude", ""),
      adapters: [
        mock("codex", JSON.stringify({ verdict: "approved", content: "ok" })),
        mock("gemini", JSON.stringify({ verdict: "changes_requested", content: "fix it" })),
      ],
    })
    const result = await runner.reviewContent("content", "prompt")
    expect(result.approved).toBe(false)
  })

  it("excludes router from reviewers", async () => {
    const called: string[] = []
    const runner = new CouncilRunner({
      router: { name: "claude", isAvailable: async () => true, getModels: async () => [], query: async () => { called.push("claude"); return { agent: "claude", content: "{}", durationMs: 1 } } },
      adapters: [mock("codex", JSON.stringify({ verdict: "approved", content: "ok" }))],
    })
    await runner.reviewContent("content", "prompt")
    expect(called).toHaveLength(0) // router not called for reviews
  })
})

describe("council graceful degradation", () => {
  it("continues with remaining agents when one fails", async () => {
    const failingAdapter: AgentAdapter = {
      name: "codex",
      isAvailable: async () => true,
      getModels: async () => [],
      query: async () => { throw new Error("codex unavailable") },
    }
    const errors: string[] = []
    const runner = new CouncilRunner({
      router: mock("claude", "synthesis"),
      adapters: [failingAdapter, mock("gemini", "gemini answer")],
    })
    const result = await runner.council("question", [], {
      onAgentError: (name) => errors.push(name),
    })
    expect(errors).toContain("codex")
    expect(result.responses).toHaveLength(1)
    expect(result.responses[0].agent).toBe("gemini")
    expect(result.synthesis).toBe("synthesis")
  })

  it("throws when all agents fail", async () => {
    const failing = (name: string): AgentAdapter => ({
      name,
      isAvailable: async () => true,
      getModels: async () => [],
      query: async () => { throw new Error("unavailable") },
    })
    const runner = new CouncilRunner({
      router: mock("claude", ""),
      adapters: [failing("codex"), failing("gemini")],
    })
    expect(runner.council("question", [])).rejects.toThrow("All agents failed")
  })
})

describe("pipeline graceful degradation", () => {
  it("continues if a reviewer fails, skips that review", async () => {
    const failingReviewer: AgentAdapter = {
      name: "gemini",
      isAvailable: async () => true,
      getModels: async () => [],
      query: async () => { throw new Error("gemini unavailable") },
    }
    const runner = new CouncilRunner({
      router: mock("claude", JSON.stringify({ assignTo: "codex" })),
      adapters: [
        mock("codex", "the work"),
        failingReviewer,
      ],
    })
    const result = await runner.pipeline("task", [])
    // gemini failed as reviewer — result still returns with zero reviews
    expect(result.taskContent).toBe("the work")
    expect(result.reviews).toHaveLength(0)
    expect(result.approved).toBe(true) // no reviews = vacuously approved
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
    expect(result.roundCount).toBe(2)  // 2 rounds were run (round 1 spoke, round 2 all passed)
    expect(result.rounds).toHaveLength(1)  // only round 1 has content (round 2 was all-pass, not stored)
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

  it("onRoundComplete returning false triggers early exit with consensusReached: false", async () => {
    let callCount = 0
    const runner = new CouncilRunner({
      router: mock("claude", "early synthesis"),
      adapters: [mock("codex", "codex opinion"), mock("gemini", "gemini opinion")],
    })
    const result = await runner.debate("topic", [], {
      maxRounds: 5,
      onRoundComplete: async () => {
        callCount++
        return false // always stop after round 1
      },
    })
    expect(result.consensusReached).toBe(false)
    expect(result.synthesis).toBe("early synthesis")
    expect(callCount).toBe(1) // callback was called once (after round 1) then returned false
    expect(result.rounds).toHaveLength(1) // only round 1 was stored
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

describe("CouncilRunner.buildDeltaMessage", () => {
  const runner = new CouncilRunner({ router: mockAdapter("router") as any, adapters: [] })

  it("returns plain prompt when context is empty", () => {
    expect((runner as any).buildDeltaMessage("hello", [], "claude")).toBe("hello")
  })

  it("includes peer responses from last turn, excludes self", () => {
    const ctx = [
      { role: "user", agent: null, content: "q1" },
      { role: "agent", agent: "gemini", content: "gemini answer" },
      { role: "agent", agent: "claude", content: "claude answer" },
    ] as any
    const msg = (runner as any).buildDeltaMessage("q2", ctx, "claude")
    expect(msg).toContain("[gemini]: gemini answer")
    expect(msg).toContain("q2")
    expect(msg).not.toContain("claude answer")
  })

  it("returns plain prompt when no prior agent responses exist", () => {
    expect((runner as any).buildDeltaMessage("hi", [], "claude")).toBe("hi")
  })
})

describe("CouncilRunner session management", () => {
  it("stores sessionId after agent call", async () => {
    const stored: Record<string, string> = {}
    const sessionStore = {
      getAgentSession: (_mid: string, _name: string) => null,
      setAgentSession: (_mid: string, name: string, sid: string) => { stored[name] = sid },
    }
    const adapter = mockAdapter("gemini")
    const runner = new CouncilRunner({
      router: mockAdapter("router") as any,
      adapters: [adapter as any],
      masterSessionId: "master-1",
      sessionStore,
    })
    await runner.council("test", [])
    expect(stored["gemini"]).toBe("gemini-session")
  })

  it("passes stored sessionId to agent on subsequent call", async () => {
    let capturedOptions: any
    const adapter = {
      name: "gemini",
      query: async (_p: string, _c: unknown, opts?: any) => {
        capturedOptions = opts
        return { agent: "gemini", content: "resp", durationMs: 0, sessionId: "gemini-session" }
      },
      isAvailable: async () => true,
      getModels: async () => [],
    }
    const sessionStore = {
      getAgentSession: (_mid: string, name: string) => name === "gemini" ? "existing-session" : null,
      setAgentSession: () => {},
    }
    const runner = new CouncilRunner({
      router: mockAdapter("router") as any,
      adapters: [adapter as any],
      masterSessionId: "master-1",
      sessionStore,
    })
    await runner.council("test", [])
    expect(capturedOptions?.agentSessionId).toBe("existing-session")
  })
})
