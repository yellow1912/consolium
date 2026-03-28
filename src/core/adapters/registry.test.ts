import { describe, it, expect } from "bun:test"
import { AdapterRegistry } from "./registry"
import type { AgentAdapter } from "./types"

const mock = (name: string): AgentAdapter => ({
  name,
  isAvailable: async () => true,
  getModels: async () => [],
  query: async () => ({ agent: name, content: "", durationMs: 0 }),
})

describe("AdapterRegistry", () => {
  it("registers and retrieves adapters", () => {
    const r = new AdapterRegistry()
    const m = mock("mock")
    r.register(m)
    expect(r.get("mock")).toBe(m)
  })

  it("returns null for unknown adapter", () => {
    expect(new AdapterRegistry().get("unknown")).toBeNull()
  })

  it("lists all adapters", () => {
    const r = new AdapterRegistry()
    r.register(mock("a"))
    r.register(mock("b"))
    expect(r.all().map(x => x.name)).toEqual(["a", "b"])
  })

  it("excludes specified adapters", () => {
    const r = new AdapterRegistry()
    r.register(mock("a"))
    r.register(mock("b"))
    r.register(mock("c"))
    expect(r.except("a").map(x => x.name)).toEqual(["b", "c"])
  })

  it("except with multiple names", () => {
    const r = new AdapterRegistry()
    r.register(mock("a"))
    r.register(mock("b"))
    r.register(mock("c"))
    expect(r.except("a", "c").map(x => x.name)).toEqual(["b"])
  })

  it("overwriting a registered adapter replaces it", () => {
    const r = new AdapterRegistry()
    const m1 = mock("x")
    const m2 = mock("x")
    r.register(m1)
    r.register(m2)
    expect(r.get("x")).toBe(m2)
    expect(r.all()).toHaveLength(1)
  })
})
