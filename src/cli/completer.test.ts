import { describe, it, expect } from "bun:test"
import { buildCompleter } from "./completer"

const mockRegistry = {
  all: () => [{ name: "claude" }, { name: "gemini" }, { name: "codex" }],
}

const mockModelCache = {
  get: (name: string) => {
    if (name === "claude") return ["claude-opus-4-6", "claude-sonnet-4-6"]
    if (name === "gemini") return ["gemini-2.0-flash"]
    return []
  },
}

const completer = buildCompleter(mockRegistry as any, mockModelCache as any)

describe("buildCompleter — command names", () => {
  it("returns all commands for empty input", () => {
    const [hits] = completer("")
    expect(hits).toContain("/mode")
    expect(hits).toContain("/router")
    expect(hits).toContain("/help")
    expect(hits).toContain("/model")
    expect(hits).toContain("/models")
  })

  it("returns all commands for bare /", () => {
    const [hits] = completer("/")
    expect(hits).toContain("/mode")
    expect(hits).toContain("/debate")
    expect(hits).toContain("/model")
    expect(hits).toContain("/models")
  })

  it("completes partial command", () => {
    const [hits] = completer("/mo")
    expect(hits).toContain("/mode ")
    expect(hits).toContain("/model ")
    expect(hits).toContain("/models ")
  })

  it("completes /de to /debate", () => {
    const [hits] = completer("/de")
    expect(hits).toEqual(["/debate "])
  })

  it("returns empty for unknown prefix", () => {
    const [hits] = completer("/zzz")
    expect(hits).toEqual([])
  })
})
