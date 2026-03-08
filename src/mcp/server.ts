import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { SessionManager } from "../core/session/index"
import { CouncilRunner } from "../core/council/index"
import { buildDefaultRegistry } from "../core/adapters/registry"

type McpTool = {
  name: string
  description: string
  inputSchema: {
    type: "object"
    properties: Record<string, unknown>
    required?: string[]
  }
}

export function buildMcpTools(): McpTool[] {
  return [
    {
      name: "start_session",
      description: "Start a new Consilium session",
      inputSchema: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["council", "dispatch", "pipeline"], description: "Execution mode" },
          router: { type: "string", description: "Router agent name (default: claude)" },
        },
      },
    },
    {
      name: "send_message",
      description: "Send a message to a Consilium session and get a response",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Session ID from start_session" },
          message: { type: "string", description: "The message to send" },
        },
        required: ["sessionId", "message"],
      },
    },
    {
      name: "get_result",
      description: "Get all messages from a Consilium session",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Session ID" },
        },
        required: ["sessionId"],
      },
    },
    {
      name: "list_sessions",
      description: "List all Consilium sessions",
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["active", "closed"], description: "Filter by status" },
        },
      },
    },
    {
      name: "close_session",
      description: "Close a Consilium session",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Session ID to close" },
        },
        required: ["sessionId"],
      },
    },
  ]
}

export async function startMcpServer() {
  const sessionMgr = new SessionManager()
  const registry = buildDefaultRegistry()

  const server = new Server(
    { name: "consilium", version: "0.1.0" },
    { capabilities: { tools: {} } }
  )

  server.setRequestHandler({ method: "tools/list" } as any, async () => ({
    tools: buildMcpTools(),
  }))

  server.setRequestHandler({ method: "tools/call" } as any, async (req: any) => {
    const { name, arguments: args } = req.params
    try {
      const result = await handleTool(name, args ?? {}, sessionMgr, registry)
      return { content: [{ type: "text", text: result }] }
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err}` }], isError: true }
    }
  })

  await server.connect(new StdioServerTransport())
  console.error("Consilium MCP server running on stdio")
}

async function handleTool(
  name: string,
  args: Record<string, unknown>,
  sessionMgr: SessionManager,
  registry: ReturnType<typeof buildDefaultRegistry>,
): Promise<string> {
  if (name === "start_session") {
    const mode = (args.mode as "council" | "dispatch" | "pipeline") ?? "dispatch"
    const router = (args.router as string) ?? "claude"
    const session = sessionMgr.create({ mode, router })
    return JSON.stringify({ sessionId: session.id, mode: session.mode, router: session.router })
  }

  if (name === "send_message") {
    const sessionId = args.sessionId as string
    const message = args.message as string
    const session = sessionMgr.get(sessionId)
    if (!session) throw new Error(`Session '${sessionId}' not found`)

    const context = sessionMgr.getMessages(sessionId)
    sessionMgr.addMessage(sessionId, "user", null, message)

    const router = registry.get(session.router)
    if (!router) throw new Error(`Router '${session.router}' not found`)

    const runner = new CouncilRunner({ router, adapters: registry.except(session.router) })
    let resultText: string

    if (session.mode === "council") {
      const r = await runner.council(message, context)
      resultText = r.synthesis
    } else if (session.mode === "dispatch") {
      const r = await runner.dispatch(message, context)
      resultText = r.content
    } else {
      const r = await runner.pipeline(message, context)
      resultText = r.taskContent
    }

    sessionMgr.addMessage(sessionId, "agent", "consilium", resultText)
    return resultText
  }

  if (name === "get_result") {
    const sessionId = args.sessionId as string
    return JSON.stringify(sessionMgr.getMessages(sessionId))
  }

  if (name === "list_sessions") {
    const sessions = sessionMgr.listAll()
    return JSON.stringify(sessions)
  }

  if (name === "close_session") {
    const sessionId = args.sessionId as string
    sessionMgr.closeSession(sessionId)
    return JSON.stringify({ closed: true, sessionId })
  }

  throw new Error(`Unknown tool: ${name}`)
}
