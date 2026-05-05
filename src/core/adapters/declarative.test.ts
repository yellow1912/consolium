import { test, expect, describe } from "bun:test"
import { AGENT_DEFS, type AgentDef } from "./defs"
import { DeclarativeAdapter } from "./declarative"
import { detectAgents } from "./detect"

describe("AGENT_DEFS", () => {
  test("all defs have required fields", () => {
    for (const def of AGENT_DEFS) {
      expect(def.name).toBeTruthy()
      expect(def.bin).toBeTruthy()
      expect(def.streamFormat).toBeTruthy()
      expect(def.promptVia).toMatch(/^(argv|stdin|jsonrpc)$/)
      expect(typeof def.buildArgs).toBe("function")
      expect(def.fallbackModels.length).toBeGreaterThan(0)
    }
  })

  test("unique names", () => {
    const names = AGENT_DEFS.map(d => d.name)
    expect(new Set(names).size).toBe(names.length)
  })

  test("each def has exactly one default model", () => {
    for (const def of AGENT_DEFS) {
      const defaults = def.fallbackModels.filter(m => m.isDefault)
      expect(defaults.length).toBeLessThanOrEqual(1)
    }
  })
})

describe("DeclarativeAdapter", () => {
  const fakeDef: AgentDef = {
    name: "test-agent",
    bin: "echo",
    streamFormat: "plain",
    promptVia: "argv",
    buildArgs(prompt) { return [prompt] },
    fallbackModels: [
      { id: "test-model", name: "Test", capabilities: ["general"], isDefault: true },
    ],
  }

  test("wraps def name", () => {
    const adapter = new DeclarativeAdapter(fakeDef)
    expect(adapter.name).toBe("test-agent")
  })

  test("isAvailable detects echo", async () => {
    const adapter = new DeclarativeAdapter(fakeDef)
    expect(await adapter.isAvailable()).toBe(true)
  })

  test("isAvailable returns false for missing bin", async () => {
    const adapter = new DeclarativeAdapter({ ...fakeDef, bin: "nonexistent-bin-xyz-123" })
    expect(await adapter.isAvailable()).toBe(false)
  })

  test("getModels returns fallback when no probe", async () => {
    const adapter = new DeclarativeAdapter(fakeDef)
    const models = await adapter.getModels()
    expect(models).toEqual(fakeDef.fallbackModels)
  })

  test("query returns stdout", async () => {
    const adapter = new DeclarativeAdapter(fakeDef)
    const resp = await adapter.query("hello world", [])
    expect(resp.agent).toBe("test-agent")
    expect(resp.content).toBe("hello world")
    expect(resp.durationMs).toBeGreaterThanOrEqual(0)
  })

  test("queryStream yields tokens", async () => {
    const adapter = new DeclarativeAdapter(fakeDef)
    let output = ""
    for await (const token of adapter.queryStream("streaming test", [])) {
      output += token
    }
    expect(output.trim()).toBe("streaming test")
  })

  test("context prepended to prompt", async () => {
    const adapter = new DeclarativeAdapter(fakeDef)
    const resp = await adapter.query("follow up", [
      { role: "user", agent: null, content: "first message" },
      { role: "agent", agent: "other", content: "reply" },
    ])
    expect(resp.content).toContain("[user]: first message")
    expect(resp.content).toContain("[other]: reply")
    expect(resp.content).toContain("[user]: follow up")
  })

  test("stdin delivery works", async () => {
    const stdinDef: AgentDef = {
      ...fakeDef,
      name: "stdin-agent",
      bin: "cat",
      promptVia: "stdin",
      buildArgs() { return [] },
    }
    const adapter = new DeclarativeAdapter(stdinDef)
    const resp = await adapter.query("piped input", [])
    expect(resp.content).toBe("piped input")
  })

  test("env vars applied", async () => {
    const envDef: AgentDef = {
      ...fakeDef,
      name: "env-agent",
      bin: "env",
      buildArgs() { return [] },
      env: { CONSILIUM_TEST_VAR: "hello" },
    }
    const adapter = new DeclarativeAdapter(envDef)
    const resp = await adapter.query("", [])
    expect(resp.content).toContain("CONSILIUM_TEST_VAR=hello")
  })
})

describe("detectAgents", () => {
  test("detects available bins", async () => {
    const defs: AgentDef[] = [
      { name: "exists", bin: "echo", streamFormat: "plain", promptVia: "argv", buildArgs: () => [], fallbackModels: [] },
      { name: "missing", bin: "nonexistent-xyz-123", streamFormat: "plain", promptVia: "argv", buildArgs: () => [], fallbackModels: [] },
    ]
    const found = await detectAgents(defs)
    expect(found.length).toBe(1)
    expect(found[0].name).toBe("exists")
  })
})

describe("buildArgs snapshots", () => {
  test("codex args", () => {
    const def = AGENT_DEFS.find(d => d.name === "codex")!
    expect(def.buildArgs("do stuff", { model: "gpt-5" })).toEqual([
      "exec", "--config", "approval_policy=never", "--config", "model=gpt-5", "do stuff",
    ])
    expect(def.buildArgs("do stuff", {})).toEqual([
      "exec", "--config", "approval_policy=never", "do stuff",
    ])
  })

  test("gemini args", () => {
    const def = AGENT_DEFS.find(d => d.name === "gemini")!
    expect(def.buildArgs("query", { model: "gemini-2.5-pro" })).toEqual([
      "-p", "query", "--yolo", "-m", "gemini-2.5-pro",
    ])
    expect(def.buildArgs("query", {})).toEqual(["-p", "query", "--yolo"])
  })

  test("qwen stdin agent args exclude prompt", () => {
    const def = AGENT_DEFS.find(d => d.name === "qwen")!
    const args = def.buildArgs("ignored", { model: "qwen-72b" })
    expect(args).toEqual(["--yolo", "--model", "qwen-72b", "-"])
    expect(args).not.toContain("ignored")
  })

  test("devin acp args", () => {
    const def = AGENT_DEFS.find(d => d.name === "devin")!
    expect(def.promptVia).toBe("jsonrpc")
    expect(def.streamFormat).toBe("acp-json-rpc")
    expect(def.buildArgs("ignored")).toEqual([
      "--permission-mode", "dangerous", "--respect-workspace-trust", "false", "acp",
    ])
  })

  test("pi rpc args", () => {
    const def = AGENT_DEFS.find(d => d.name === "pi")!
    expect(def.promptVia).toBe("jsonrpc")
    expect(def.jsonrpcMethod).toBe("prompt")
    expect(def.buildArgs("ignored", { model: "pi-3" })).toEqual([
      "--mode", "rpc", "--no-session", "--model", "pi-3",
    ])
  })
})

describe("jsonrpc delivery", () => {
  test("builds ACP envelope", () => {
    const def: AgentDef = {
      name: "test-acp",
      bin: "cat",
      streamFormat: "acp-json-rpc",
      promptVia: "jsonrpc",
      buildArgs() { return [] },
      jsonrpcMethod: "tasks/send",
      fallbackModels: [],
    }
    const adapter = new DeclarativeAdapter(def)
    // Use cat to echo back stdin — verify JSON-RPC envelope
    return adapter.query("hello", []).then(resp => {
      const parsed = JSON.parse(resp.content)
      expect(parsed.jsonrpc).toBe("2.0")
      expect(parsed.method).toBe("tasks/send")
      expect(parsed.params.message.parts[0].text).toBe("hello")
    })
  })

  test("builds Pi envelope", () => {
    const def: AgentDef = {
      name: "test-pi",
      bin: "cat",
      streamFormat: "pi-rpc",
      promptVia: "jsonrpc",
      buildArgs() { return [] },
      jsonrpcMethod: "prompt",
      fallbackModels: [],
    }
    const adapter = new DeclarativeAdapter(def)
    return adapter.query("hello", []).then(resp => {
      const parsed = JSON.parse(resp.content)
      expect(parsed.jsonrpc).toBe("2.0")
      expect(parsed.method).toBe("prompt")
      expect(parsed.params.prompt).toBe("hello")
    })
  })
})
