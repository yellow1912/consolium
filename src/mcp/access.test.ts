import { describe, it, expect, mock } from "bun:test"
import { mcpAccessFor, wrapRegistryForMcp, unknownWriteAgents } from "./access"
import { SessionManager } from "../core/session/index"
import { AdapterRegistry } from "../core/adapters/registry"
import type { AgentAdapter, QueryOptions } from "../core/adapters/types"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

let mockedWorkflow: any = null
mock.module("../workflows/loader", () => ({
  loadWorkflow: async () => mockedWorkflow,
  loadAllWorkflows: async () => new Map(),
}))
const { handleTool } = await import("./server")

describe("mcpAccessFor", () => {
  it("returns read-only when the variable is unset", () => { expect(mcpAccessFor("codex", {})).toBe("read-only") })
  it("returns read-only when the variable is empty", () => { expect(mcpAccessFor("codex", { CONSILIUM_MCP_WRITE_AGENTS: "" })).toBe("read-only") })
  it("returns full for a single listed agent", () => { expect(mcpAccessFor("codex", { CONSILIUM_MCP_WRITE_AGENTS: "codex" })).toBe("full") })
  it("handles several names with spaces", () => {
    const env = { CONSILIUM_MCP_WRITE_AGENTS: " codex , gemini ,, agy " }
    expect(mcpAccessFor("gemini", env)).toBe("full")
    expect(mcpAccessFor("agy", env)).toBe("full")
    expect(mcpAccessFor("claude", env)).toBe("read-only")
  })
  it("returns full for every agent when the variable is *", () => { expect(mcpAccessFor("anything", { CONSILIUM_MCP_WRITE_AGENTS: "*" })).toBe("full") })
  it("returns read-only for an agent not in the list", () => { expect(mcpAccessFor("kimi", { CONSILIUM_MCP_WRITE_AGENTS: "codex" })).toBe("read-only") })
})

type Call = { agent: string; access?: string }

function fake(name: string, calls: Call[], supportsReadOnly: boolean, reply = "reply"): AgentAdapter {
  return {
    name,
    supportsReadOnly,
    async query(_p: string, _c: unknown[], o?: QueryOptions) {
      calls.push({ agent: name, access: o?.access })
      const content = name === "claude" ? JSON.stringify({ assignTo: "codex" }) : reply
      return { agent: name, content, durationMs: 0 }
    },
    async isAvailable() { return true },
    async getModels() { return [] },
  }
}

function setup(specs: Array<[string, boolean]>) {
  const calls: Call[] = []
  const registry = new AdapterRegistry()
  for (const [n, ro] of specs) registry.register(fake(n, calls, ro))
  const mgr = new SessionManager(join(mkdtempSync(join(tmpdir(), "consilium-mcp-")), "t.db"))
  return { calls, registry, mgr }
}

const call = (name: string, args: Record<string, unknown>, s: ReturnType<typeof setup>, env: Record<string, string | undefined>) =>
  handleTool(name, args, s.mgr, s.registry, null as any, null as any, env)

describe("MCP access modes", () => {
  it("send_message in dispatch mode passes read-only to router and agent by default and records it", async () => {
    const s = setup([["claude", true], ["codex", true]])
    const session = s.mgr.create({ mode: "dispatch", router: "claude" })
    const out = await call("send_message", { sessionId: session.id, message: "hi" }, s, {})
    expect(s.calls.length).toBeGreaterThan(0)
    expect(s.calls.every(c => c.access === "read-only")).toBe(true)
    expect(out).toContain("codex=read-only")
  })

  it("send_message passes full to an opted-in agent and read-only to the others", async () => {
    const s = setup([["claude", true], ["codex", true]])
    const session = s.mgr.create({ mode: "dispatch", router: "claude" })
    const out = await call("send_message", { sessionId: session.id, message: "hi" }, s, { CONSILIUM_MCP_WRITE_AGENTS: "codex" })
    expect(s.calls.find(c => c.agent === "codex")!.access).toBe("full")
    expect(s.calls.find(c => c.agent === "claude")!.access).toBe("read-only")
    expect(out).toContain("codex=full")
  })

  it("a tool argument named access cannot change the access mode", async () => {
    const s = setup([["claude", true], ["codex", true]])
    const session = s.mgr.create({ mode: "dispatch", router: "claude" })
    await call("send_message", { sessionId: session.id, message: "hi", access: "full" }, s, {})
    expect(s.calls.every(c => c.access === "read-only")).toBe(true)
  })

  it("council skips agents without a read-only mode and names them in the result", async () => {
    const s = setup([["claude", true], ["codex", true], ["agy", false]])
    const session = s.mgr.create({ mode: "council", router: "claude" })
    const out = await call("send_message", { sessionId: session.id, message: "hi" }, s, {})
    expect(s.calls.some(c => c.agent === "agy")).toBe(false)
    expect(out).toContain("skipped: agy")
    expect(out).toContain("CONSILIUM_MCP_WRITE_AGENTS")
  })

  it("council starts an unsupported agent when it is opted in, with full access", async () => {
    const s = setup([["claude", true], ["codex", true], ["agy", false]])
    const session = s.mgr.create({ mode: "council", router: "claude" })
    const out = await call("send_message", { sessionId: session.id, message: "hi" }, s, { CONSILIUM_MCP_WRITE_AGENTS: "agy" })
    expect(s.calls.find(c => c.agent === "agy")!.access).toBe("full")
    expect(out).not.toContain("skipped")
  })

  it("fails when the router agent has no read-only mode and is not opted in", async () => {
    const s = setup([["agy", false], ["codex", true]])
    const session = s.mgr.create({ mode: "dispatch", router: "agy" })
    await expect(call("send_message", { sessionId: session.id, message: "hi" }, s, {})).rejects.toThrow("agent agy has no read-only mode")
  })

  it("does not offer or start an agent without a read-only mode in dispatch, and fails when none is left", async () => {
    const s = setup([["claude", true], ["codex", false]])
    const session = s.mgr.create({ mode: "dispatch", router: "claude" })
    await expect(call("send_message", { sessionId: session.id, message: "hi" }, s, {})).rejects.toThrow("No agent available for dispatch")
    expect(s.calls.some(c => c.agent === "codex")).toBe(false)
  })

  it("run_workflow passes read-only by default and full for an opted-in agent, in agent and council steps", async () => {
    const run = async (env: Record<string, string | undefined>) => {
      mockedWorkflow = { name: "wf", trust: "autonomous", steps: [
        { agent: "codex", task: "{input}", output: "a" },
        { mode: "council", task: "{a}", output: "b" },
      ] }
      const s = setup([["claude", true], ["codex", true], ["gemini", true]])
      const out = JSON.parse(await call("run_workflow", { workflow: "wf", input: "x" }, s, env))
      return { s, out }
    }
    const d = await run({})
    expect(d.s.calls.length).toBeGreaterThan(2)
    expect(d.s.calls.every(c => c.access === "read-only")).toBe(true)
    expect(d.out.access).toContain("codex=read-only")
    const o = await run({ CONSILIUM_MCP_WRITE_AGENTS: "codex" })
    expect(o.s.calls.filter(c => c.agent === "codex").every(c => c.access === "full")).toBe(true)
    expect(o.s.calls.filter(c => c.agent !== "codex").every(c => c.access === "read-only")).toBe(true)
    expect(o.out.access).toContain("codex=full")
  })

  it("run_workflow leaves unsupported agents out of council steps and fails for a step naming one", async () => {
    mockedWorkflow = { name: "wf", trust: "autonomous", steps: [{ mode: "council", task: "{input}", output: "b" }] }
    const s = setup([["claude", true], ["codex", true], ["agy", false]])
    const out = JSON.parse(await call("run_workflow", { workflow: "wf", input: "x" }, s, {}))
    expect(s.calls.some(c => c.agent === "agy")).toBe(false)
    expect(out.skipped).toEqual(["agy"])
    mockedWorkflow = { name: "wf", trust: "autonomous", steps: [{ agent: "agy", task: "{input}" }] }
    await expect(call("run_workflow", { workflow: "wf", input: "x" }, s, {})).rejects.toThrow("agent agy has no read-only mode")
  })

  it("dispatch does not offer an unsupported agent to the router", async () => {
    const prompts: string[] = []
    const s = setup([["claude", true], ["codex", true], ["agy", false]])
    const claude = s.registry.get("claude")!
    const q = claude.query.bind(claude)
    claude.query = async (p, c, o) => { prompts.push(p); return q(p, c, o) }
    const session = s.mgr.create({ mode: "dispatch", router: "claude" })
    const out = await call("send_message", { sessionId: session.id, message: "hi" }, s, {})
    expect(prompts.join("\n")).not.toContain("agy")
    expect(out).toContain("skipped: agy")
  })

  it("pipeline fails with a clear message when skipping leaves no agent or reviewer", async () => {
    const s = setup([["claude", true], ["agy", false]])
    const session = s.mgr.create({ mode: "pipeline", router: "claude" })
    await expect(call("send_message", { sessionId: session.id, message: "hi" }, s, {})).rejects.toThrow("Pipeline has no agent left to run or review: agy")
    expect(s.calls).toHaveLength(0)
  })

  it("run_workflow refuses a checkpoint workflow by default", async () => {
    mockedWorkflow = { name: "wf", trust: "checkpoint", steps: [{ agent: "codex", task: "{input}" }] }
    const s = setup([["claude", true], ["codex", true]])
    await expect(call("run_workflow", { workflow: "wf", input: "x" }, s, {})).rejects.toThrow("must be run in the Consilium TUI")
    expect(s.calls).toHaveLength(0)
  })

  it("run_workflow runs a checkpoint workflow when CONSILIUM_MCP_ALLOW_CHECKPOINT_WORKFLOWS=1", async () => {
    mockedWorkflow = { name: "wf", trust: "checkpoint", steps: [{ agent: "codex", task: "{input}" }] }
    const s = setup([["claude", true], ["codex", true]])
    const out = JSON.parse(await call("run_workflow", { workflow: "wf", input: "x" }, s, { CONSILIUM_MCP_ALLOW_CHECKPOINT_WORKFLOWS: "1" }))
    expect(out.access).toContain("codex=read-only")
  })
})

describe("McpAccessAdapter wrapper", () => {
  it("forces read-only on query and queryStream even when the caller passes full", async () => {
    const seen: Array<string | undefined> = []
    const inner: AgentAdapter = {
      name: "codex", supportsReadOnly: true,
      async query(_p, _c, o) { seen.push(o?.access); return { agent: "codex", content: "", durationMs: 0 } },
      async *queryStream(_p, _c, o) { seen.push(o?.access); yield "t" },
      async isAvailable() { return true }, async getModels() { return [] },
    }
    const reg = new AdapterRegistry(); reg.register(inner)
    const w = wrapRegistryForMcp(reg, {}).get("codex")!
    await w.query("p", [], { access: "full" })
    for await (const _ of w.queryStream!("p", [], { access: "full" })) { /* drain */ }
    expect(seen).toEqual(["read-only", "read-only"])
  })
})

describe("unknownWriteAgents", () => {
  it("lists names that match no registered agent, exact and case-sensitive", () => {
    expect(unknownWriteAgents(["codex", "cursor-agent"], { CONSILIUM_MCP_WRITE_AGENTS: "codex, Codex,cursor,*,," })).toEqual(["Codex", "cursor"])
    expect(unknownWriteAgents(["codex"], {})).toEqual([])
  })
})
