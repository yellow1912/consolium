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

  it("parses /debate command", () => {
    expect(parseSlash("/debate rounds 3")).toEqual({ command: "debate", args: ["rounds", "3"] })
    expect(parseSlash("/debate autopilot on")).toEqual({ command: "debate", args: ["autopilot", "on"] })
    expect(parseSlash("/debate autopilot off")).toEqual({ command: "debate", args: ["autopilot", "off"] })
  })
})

describe("quoted tokens", () => {
  it("double-quoted path is preserved as a single token", () => {
    expect(parseSlash('/start claude --cwd "/My Projects/app"')).toEqual({
      command: "start",
      args: ["claude", "--cwd", "/My Projects/app"],
    })
  })

  it("single-quoted path is preserved as a single token", () => {
    expect(parseSlash("/start claude --cwd '/path with spaces'")).toEqual({
      command: "start",
      args: ["claude", "--cwd", "/path with spaces"],
    })
  })

  it("unquoted path with spaces still splits (user must quote)", () => {
    expect(parseSlash("/start claude --cwd /My Projects/app")).toEqual({
      command: "start",
      args: ["claude", "--cwd", "/My", "Projects/app"],
    })
  })

  it("mixed quoted and unquoted args work together", () => {
    expect(parseSlash('/start claude --cwd "/My Projects/app" --model opus')).toEqual({
      command: "start",
      args: ["claude", "--cwd", "/My Projects/app", "--model", "opus"],
    })
  })

  it("quoted title in /memory store splits correctly", () => {
    expect(parseSlash('/memory store "JWT expiry" | JWT tokens expire after 1h')).toEqual({
      command: "memory",
      args: ["store", "JWT expiry", "|", "JWT", "tokens", "expire", "after", "1h"],
    })
  })

  it("empty double quotes produce an empty string token", () => {
    expect(parseSlash('/cmd ""')).toEqual({
      command: "cmd",
      args: [""],
    })
  })

  it("unclosed quote treats the rest of the string as one token", () => {
    expect(parseSlash('/cmd "unclosed')).toEqual({
      command: "cmd",
      args: ["unclosed"],
    })
  })
})
