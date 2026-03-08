import { describe, it, expect } from "bun:test"
import { ClaudeAdapter } from "./claude"

describe("ClaudeAdapter", () => {
  it("has correct name", () => {
    expect(new ClaudeAdapter().name).toBe("claude")
  })

  it("query returns AgentResponse shape", async () => {
    const adapter = new ClaudeAdapter()
    // Override the protected spawnAndRead method for testing without real API calls
    ;(adapter as any).spawnAndRead = async () => ({ exitCode: 0, stdout: "mocked response", stderr: "" })
    const result = await adapter.query("hello", [])
    expect(result.agent).toBe("claude")
    expect(result.content).toBe("mocked response")
    expect(typeof result.durationMs).toBe("number")
  })

  it("query builds context prompt correctly", async () => {
    const adapter = new ClaudeAdapter()
    let capturedArgs: string[] = []
    ;(adapter as any).spawnAndRead = async (args: string[]) => { capturedArgs = args; return { exitCode: 0, stdout: "ok", stderr: "" } }
    const context = [{ role: "user" as const, agent: null, content: "prior message" }]
    await adapter.query("new prompt", context)
    const prompt = capturedArgs[capturedArgs.length - 1]
    expect(prompt).toContain("prior message")
    expect(prompt).toContain("new prompt")
  })
})

describe("ClaudeAdapter session flags", () => {
  it("uses --resume when agentSessionId is provided", async () => {
    const capturedArgs: string[][] = []
    const origSpawn = Bun.spawn.bind(Bun)
    // @ts-ignore
    Bun.spawn = (args: string[], opts: unknown) => {
      capturedArgs.push(args as string[])
      return origSpawn(["echo", "hi"], opts as any)
    }
    const adapter = new ClaudeAdapter()
    try { await adapter.query("hello", [], { agentSessionId: "my-session-id" }) } catch {}
    // @ts-ignore
    Bun.spawn = origSpawn
    const call = capturedArgs.find(a => a[0] === "claude")
    expect(call).toBeDefined()
    expect(call).toContain("--resume")
    expect(call).toContain("my-session-id")
    expect(call).not.toContain("--session-id")
  })

  it("uses --session-id when no agentSessionId", async () => {
    const capturedArgs: string[][] = []
    const origSpawn = Bun.spawn.bind(Bun)
    // @ts-ignore
    Bun.spawn = (args: string[], opts: unknown) => {
      capturedArgs.push(args as string[])
      return origSpawn(["echo", "hi"], opts as any)
    }
    const adapter = new ClaudeAdapter()
    try { await adapter.query("hello", []) } catch {}
    // @ts-ignore
    Bun.spawn = origSpawn
    const call = capturedArgs.find(a => a[0] === "claude")
    expect(call).toBeDefined()
    expect(call).toContain("--session-id")
    expect(call).not.toContain("--resume")
  })
})
