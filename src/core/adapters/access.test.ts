import { describe, it, expect } from "bun:test"
import { AGENT_DEFS, type AgentDef } from "./defs"
import { DeclarativeAdapter } from "./declarative"
import { CodexAdapter } from "./codex"
import { GeminiAdapter } from "./gemini"
import { AgyAdapter } from "./agy"
import { ClaudeAdapter } from "./claude"
import { SubprocessAdapter } from "./base"
import { ReadOnlyUnsupportedError, type QueryOptions, type ModelInfo } from "./types"

// "--trust" is deliberately not listed: it only marks the workspace trusted so headless cursor-agent
// does not exit with "Workspace Trust Required". It approves no tools; --mode plan keeps it read-only.
const BYPASS = [
  "approval_policy=never", "--yolo", "--dangerously-skip-permissions", "--allow-all-tools",
  "--force", "--yes-always", "dangerous", "--accept-hooks",
]
const READ_ONLY_DECISION: Record<string, boolean> = {
  codex: true, gemini: true, "cursor-agent": true,
  agy: false, copilot: false, qwen: false, opencode: false, aider: false,
  devin: false, hermes: false, kimi: false, kiro: false, vibe: false, pi: false,
}

function noBypass(args: string[]) {
  const joined = args.join(" ")
  for (const t of BYPASS) expect(joined).not.toContain(t)
}

describe("read-only access for agent definitions", () => {
  it("every AGENT_DEFS entry has an explicit read-only decision in this test", () => {
    expect(AGENT_DEFS.map(d => d.name).sort()).toEqual(Object.keys(READ_ONLY_DECISION).sort())
  })

  for (const def of AGENT_DEFS) {
    it(`${def.name} either builds read-only args without bypass tokens or is marked unsupported`, () => {
      expect(def.readOnlySupported === true).toBe(READ_ONLY_DECISION[def.name])
      if (def.readOnlySupported) noBypass(def.buildArgs("p", { model: "m", access: "read-only" }))
    })

    it(`${def.name} builds identical args for access full and for no access`, () => {
      expect(def.buildArgs("p", { model: "m", access: "full" })).toEqual(def.buildArgs("p", { model: "m" }))
    })

    it(`${def.name} declarative adapter refuses read-only when unsupported`, async () => {
      const adapter = new DeclarativeAdapter(def)
      expect(adapter.supportsReadOnly).toBe(def.readOnlySupported === true)
      if (!def.readOnlySupported) {
        await expect(adapter.query("p", [], { access: "read-only" })).rejects.toThrow(
          `agent ${def.name} has no read-only mode; it is not started over MCP unless listed in CONSILIUM_MCP_WRITE_AGENTS`,
        )
        await expect(adapter.queryStream("p", [], { access: "read-only" }).next()).rejects.toBeInstanceOf(ReadOnlyUnsupportedError)
      }
    })
  }

  it("codex read-only uses --sandbox read-only", () => {
    expect(AGENT_DEFS.find(d => d.name === "codex")!.buildArgs("p", { access: "read-only" })).toEqual(["exec", "--sandbox", "read-only", "p"])
  })
  it("gemini read-only uses --approval-mode plan", () => {
    expect(AGENT_DEFS.find(d => d.name === "gemini")!.buildArgs("p", { access: "read-only" })).toEqual(["-p", "p", "--approval-mode", "plan"])
  })
  it("cursor-agent read-only uses --mode plan", () => {
    expect(AGENT_DEFS.find(d => d.name === "cursor-agent")!.buildArgs("p", { access: "read-only" })).toEqual(["--print", "--trust", "--mode", "plan", "p"])
  })
})

describe("read-only access for class adapters", () => {
  it("codex class adapter builds read-only args without bypass tokens", () => {
    const args = new CodexAdapter().buildArgs("p", { access: "read-only" })
    noBypass(args)
    expect(args).toContain("read-only")
  })
  it("gemini class adapter builds read-only args without bypass tokens", () => {
    const args = new GeminiAdapter().buildArgs("p", { access: "read-only" })
    noBypass(args)
    expect(args).toContain("plan")
  })
  it("claude class adapter builds plan-mode args without bypass tokens", () => {
    const args = new ClaudeAdapter().buildArgs("p", { access: "read-only" })
    noBypass(args)
    expect(args).toEqual(expect.arrayContaining(["--permission-mode", "plan"]))
  })
  it("claude full and default access add no permission-mode flag", () => {
    expect(new ClaudeAdapter().buildArgs("p", { access: "full" })).toEqual(new ClaudeAdapter().buildArgs("p"))
    expect(new ClaudeAdapter().buildArgs("p")).not.toContain("--permission-mode")
  })
  it("codex and gemini full access equal the default args", () => {
    expect(new CodexAdapter().buildArgs("p", { access: "full" })).toEqual(new CodexAdapter().buildArgs("p"))
    expect(new GeminiAdapter().buildArgs("p", { access: "full" })).toEqual(new GeminiAdapter().buildArgs("p"))
  })
  it("agy refuses to start in read-only mode", async () => {
    const agy = new AgyAdapter()
    expect(agy.supportsReadOnly).toBe(false)
    await expect(agy.query("p", [], { access: "read-only" })).rejects.toBeInstanceOf(ReadOnlyUnsupportedError)
  })
  it("claude query and stream are not blocked by read-only (claude supports it)", () => {
    expect(new ClaudeAdapter().supportsReadOnly).toBe(true)
  })
})

describe("model retry keeps the access mode", () => {
  it("SubprocessAdapter retries without the model but with the same access", async () => {
    const seen: Array<QueryOptions | undefined> = []
    class Fake extends SubprocessAdapter {
      readonly name = "fake"
      readonly bin = "fake"
      override readonly supportsReadOnly = true
      calls = 0
      buildArgs(_p: string, options?: QueryOptions) { seen.push(options); return [] }
      protected override async spawnAndRead() {
        this.calls++
        return this.calls === 1
          ? { exitCode: 1, stdout: "", stderr: "unknown model" }
          : { exitCode: 0, stdout: "ok", stderr: "" }
      }
      async getModels(): Promise<ModelInfo[]> { return [] }
    }
    await new Fake().query("p", [], { model: "bad", access: "read-only" })
    expect(seen).toHaveLength(2)
    expect(seen[0]?.access).toBe("read-only")
    expect(seen[1]?.access).toBe("read-only")
    expect(seen[1]?.model).toBeUndefined()
  })

  it("DeclarativeAdapter retries without the model but with the same access", async () => {
    const seen: Array<{ model?: string; access?: string } | undefined> = []
    const def: AgentDef = {
      name: "fake", bin: "sh", streamFormat: "plain", promptVia: "argv", readOnlySupported: true,
      buildArgs(_p, opts) {
        seen.push(opts)
        return opts?.model ? ["-c", "echo bad model >&2; exit 1"] : ["-c", "echo ok"]
      },
      fallbackModels: [{ id: "x", name: "x", capabilities: ["general"], isDefault: true }],
    }
    const r = await new DeclarativeAdapter(def).query("p", [], { model: "bad", access: "read-only" })
    expect(r.content).toBe("ok")
    expect(seen.map(s => s?.access)).toEqual(["read-only", "read-only"])
    expect(seen[1]?.model).toBeUndefined()
  })
})

describe("SubprocessAdapter default", () => {
  it("a subclass without the supportsReadOnly override is refused in read-only", async () => {
    class Plain extends SubprocessAdapter {
      readonly name = "plain"
      readonly bin = "plain"
      buildArgs() { return [] }
      async getModels(): Promise<ModelInfo[]> { return [] }
    }
    const a = new Plain()
    expect(a.supportsReadOnly).toBe(false)
    await expect(a.query("p", [], { access: "read-only" })).rejects.toBeInstanceOf(ReadOnlyUnsupportedError)
    await expect(a.queryStream("p", [], { access: "read-only" }).next()).rejects.toBeInstanceOf(ReadOnlyUnsupportedError)
  })
})
