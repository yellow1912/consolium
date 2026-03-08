import { describe, it, expect } from "bun:test"
import { buildCompleter } from "./completer"
import type { AdapterRegistry } from "../core/adapters/registry"
import type { ModelCache } from "../core/models/cache"

const mockRegistry: Pick<AdapterRegistry, "all"> = {
  all: () => [
    { name: "claude" } as any,
    { name: "gemini" } as any,
    { name: "codex" } as any,
  ],
}

const mockModelCache: Pick<ModelCache, "get"> = {
  get: (name: string) => {
    if (name === "claude") return ["claude-opus-4-6", "claude-sonnet-4-6"]
    if (name === "gemini") return ["gemini-2.0-flash"]
    return []
  },
}

const completer = buildCompleter(
  mockRegistry as AdapterRegistry,
  mockModelCache as ModelCache,
)

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

describe("buildCompleter — argument completion", () => {
  it("completes /mode args", () => {
    const [hits] = completer("/mode ")
    expect(hits).toContain("/mode council")
    expect(hits).toContain("/mode dispatch")
    expect(hits).toContain("/mode pipeline")
    expect(hits).toContain("/mode debate")
  })

  it("completes partial /mode arg", () => {
    const [hits] = completer("/mode co")
    expect(hits).toEqual(["/mode council"])
  })

  it("completes /router with agent names", () => {
    const [hits] = completer("/router ")
    expect(hits).toContain("/router claude")
    expect(hits).toContain("/router gemini")
    expect(hits).toContain("/router codex")
  })

  it("completes /models with refresh", () => {
    const [hits] = completer("/models ")
    expect(hits).toContain("/models refresh")
  })

  it("completes /model with agent names", () => {
    const [hits] = completer("/model ")
    expect(hits).toContain("/model claude")
    expect(hits).toContain("/model gemini")
    expect(hits).toContain("/model codex")
  })

  it("completes /model <agent> with model ids and clear", () => {
    const [hits] = completer("/model claude ")
    expect(hits).toContain("/model claude claude-opus-4-6")
    expect(hits).toContain("/model claude claude-sonnet-4-6")
    expect(hits).toContain("/model claude clear")
  })

  it("completes /model <agent> with empty model list still shows clear", () => {
    const [hits] = completer("/model codex ")
    expect(hits).toContain("/model codex clear")
  })

  it("completes /debate subcommands", () => {
    const [hits] = completer("/debate ")
    expect(hits).toContain("/debate rounds")
    expect(hits).toContain("/debate autopilot")
  })

  it("completes /debate autopilot values", () => {
    const [hits] = completer("/debate autopilot ")
    expect(hits).toContain("/debate autopilot on")
    expect(hits).toContain("/debate autopilot off")
  })

  it("returns no completions for /debate rounds (numeric)", () => {
    const [hits] = completer("/debate rounds ")
    expect(hits).toEqual([])
  })

  it("returns no completions for no-arg commands", () => {
    for (const cmd of ["/agents ", "/sessions ", "/history ", "/help "]) {
      const [hits] = completer(cmd)
      expect(hits).toEqual([])
    }
  })
})
