import { describe, it, expect } from "bun:test"
import { buildBoundedContextPrompt } from "./context"
import type { Message } from "./types"

const msg = (role: "user" | "system" | "agent", content: string, agent: string | null = null): Message =>
  ({ role, content, agent })

describe("buildBoundedContextPrompt", () => {
  it("returns plain prompt when context is empty", () => {
    expect(buildBoundedContextPrompt("hello", [])).toBe("hello")
  })

  it("includes all turns when they fit within budget", () => {
    const context: Message[] = [
      msg("user", "first message"),
      msg("system", "first reply"),
    ]
    const result = buildBoundedContextPrompt("follow-up", context)
    expect(result).toContain("[user]: first message")
    expect(result).toContain("[system]: first reply")
    expect(result).toContain("[user]: follow-up")
    expect(result).not.toContain("Omitted")
  })

  it("always includes last 2 turns even if budget is very tight", () => {
    // Budget so small only ~2 short turns fit
    const context: Message[] = [
      msg("user", "old irrelevant turn 1"),
      msg("system", "old irrelevant reply 1"),
      msg("user", "recent turn A"),
      msg("system", "recent turn B"),
    ]
    const result = buildBoundedContextPrompt("question", context, 200)
    expect(result).toContain("recent turn A")
    expect(result).toContain("recent turn B")
  })

  it("prefers relevant old turns over irrelevant ones when budget is tight", () => {
    const context: Message[] = [
      msg("user", "typescript typescript typescript coding typescript"),  // high relevance
      msg("system", "banana orange mango fruit salad"),                // low relevance
      msg("user", "recent A"),
      msg("system", "recent B"),
    ]
    // Budget: tight enough to require dropping one older turn
    const result = buildBoundedContextPrompt("typescript question", context, 300)
    // Relevant old turn should be preferred over irrelevant one
    expect(result).toContain("typescript typescript typescript")
    expect(result).toContain("recent A")
    expect(result).toContain("recent B")
  })

  it("adds omitted banner when turns are dropped", () => {
    const context: Message[] = Array.from({ length: 10 }, (_, i) =>
      msg("user", `turn number ${i} with some text`)
    )
    const result = buildBoundedContextPrompt("prompt", context, 200)
    expect(result).toMatch(/Omitted \d+ older history turns/)
  })

  it("output is chronologically ordered", () => {
    const context: Message[] = [
      msg("user", "alpha first"),
      msg("agent", "beta second"),
      msg("user", "gamma third"),
    ]
    const result = buildBoundedContextPrompt("prompt", context)
    const alphaPos = result.indexOf("alpha first")
    const betaPos = result.indexOf("beta second")
    const gammaPos = result.indexOf("gamma third")
    expect(alphaPos).toBeLessThan(betaPos)
    expect(betaPos).toBeLessThan(gammaPos)
  })

  it("uses agent name instead of role when agent field is set", () => {
    const context: Message[] = [
      msg("agent", "agent response", "hermes"),
    ]
    const result = buildBoundedContextPrompt("prompt", context)
    expect(result).toContain("[hermes]: agent response")
    expect(result).not.toContain("[agent]:")
  })

  it("normalizes excess blank lines in content", () => {
    const context: Message[] = [
      msg("user", "line one\n\n\n\nline two"),
    ]
    const result = buildBoundedContextPrompt("prompt", context)
    expect(result).toContain("line one\n\nline two")
    expect(result).not.toContain("line one\n\n\n\nline two")
  })

  it("current prompt always appears at the end", () => {
    const context: Message[] = [msg("user", "prior"), msg("system", "reply")]
    const result = buildBoundedContextPrompt("final question", context)
    expect(result.endsWith("[user]: final question")).toBe(true)
  })
})
