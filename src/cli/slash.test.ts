import { describe, it, expect } from "bun:test"
import { parseSlash } from "./slash"

describe("parseSlash", () => {
  it("parses /mode command", () => {
    expect(parseSlash("/mode council")).toEqual({ command: "mode", args: ["council"] })
  })

  it("parses /router command", () => {
    expect(parseSlash("/router gemini")).toEqual({ command: "router", args: ["gemini"] })
  })

  it("returns null for non-slash input", () => {
    expect(parseSlash("hello world")).toBeNull()
    expect(parseSlash("")).toBeNull()
    expect(parseSlash("  ")).toBeNull()
  })

  it("parses commands with no args", () => {
    expect(parseSlash("/help")).toEqual({ command: "help", args: [] })
    expect(parseSlash("/sessions")).toEqual({ command: "sessions", args: [] })
  })

  it("handles extra whitespace", () => {
    expect(parseSlash("  /mode  council  ")).toEqual({ command: "mode", args: ["council"] })
  })

  it("parses /models command", () => {
    expect(parseSlash("/models")).toEqual({ command: "models", args: [] })
    expect(parseSlash("/models refresh")).toEqual({ command: "models", args: ["refresh"] })
  })

  it("parses /model command", () => {
    expect(parseSlash("/model claude claude-opus-4-6")).toEqual({ command: "model", args: ["claude", "claude-opus-4-6"] })
    expect(parseSlash("/model claude clear")).toEqual({ command: "model", args: ["claude", "clear"] })
  })
})
