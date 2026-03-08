import { describe, it, expect } from "bun:test"
import { buildMcpTools } from "./server"

describe("MCP tools", () => {
  it("exposes all required tool names", () => {
    const names = buildMcpTools().map(t => t.name)
    expect(names).toContain("start_session")
    expect(names).toContain("send_message")
    expect(names).toContain("get_result")
    expect(names).toContain("list_sessions")
    expect(names).toContain("close_session")
  })

  it("all tools have description and inputSchema", () => {
    for (const tool of buildMcpTools()) {
      expect(typeof tool.description).toBe("string")
      expect(tool.description.length).toBeGreaterThan(0)
      expect(tool.inputSchema).toBeDefined()
      expect(tool.inputSchema.type).toBe("object")
    }
  })

  it("send_message requires sessionId and message", () => {
    const tool = buildMcpTools().find(t => t.name === "send_message")!
    expect(tool.inputSchema.required).toContain("sessionId")
    expect(tool.inputSchema.required).toContain("message")
  })
})
