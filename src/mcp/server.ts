import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import type { Database } from "bun:sqlite"
import { SessionManager } from "../core/session/index"
import { CouncilRunner } from "../core/council/index"
import { buildAutoRegistrySync, type AdapterRegistry } from "../core/adapters/registry"
import { mcpAccessFor, wrapRegistryForMcp, accessSummary, readOnlySkipNote, splitUsable, registryOf, unknownWriteAgents } from "./access"
import { loadAllWorkflows, loadWorkflow } from "../workflows/loader"
import { WorkflowRunner } from "../workflows/runner"
import { ReadOnlyUnsupportedError } from "../core/adapters/types"
import { MemoryStore, type KnowledgeScope, type SearchOptions } from "../core/memory/index"

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
          mode: { type: "string", enum: ["council", "dispatch", "pipeline", "debate"], description: "Execution mode" },
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
    {
      name: "list_agents",
      description: "List all available Consilium agents and their availability status",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "list_workflows",
      description: "List all available Consilium workflows (built-in and user-defined)",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "run_workflow",
      description: "Run a named Consilium workflow with the given input",
      inputSchema: {
        type: "object",
        properties: {
          workflow: { type: "string", description: "Workflow name (from list_workflows)" },
          input: { type: "string", description: "Input text passed to the workflow" },
          router: { type: "string", description: "Router agent name (default: claude)" },
        },
        required: ["workflow", "input"],
      },
    },
    {
      name: "memory_storeKnowledge",
      description: "Store a knowledge entry in Consilium's local memory",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short title (≤100 chars)" },
          content: { type: "string", description: "Knowledge content (≤5000 chars)" },
          tags: { type: "array", items: { type: "string" }, description: "Searchable tags" },
          scope: { type: "string", description: "Scope: 'global', 'project:<name>', or 'repo:<name>'" },
        },
        required: ["title", "content"],
      },
    },
    {
      name: "memory_updateKnowledge",
      description: "Update an existing knowledge entry by ID",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          content: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          scope: { type: "string" },
        },
        required: ["id"],
      },
    },
    {
      name: "memory_searchKnowledge",
      description: "Full-text search Consilium's local memory with BM25 ranking",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          scope: { type: "string" },
          contextTags: { type: "array", items: { type: "string" } },
          limit: { type: "number", default: 10 },
        },
        required: ["query"],
      },
    },
    {
      name: "memory_listKnowledge",
      description: "List knowledge entries with optional filtering and sorting",
      inputSchema: {
        type: "object",
        properties: {
          scope: { type: "string", description: "Filter by scope: 'global', 'project:<name>', or 'repo:<name>'" },
          tags: { type: "array", items: { type: "string" }, description: "Filter entries that contain all given tags" },
          query: { type: "string", description: "Full-text search query" },
          sort: { type: "string", enum: ["title", "created", "updated", "scope"], description: "Sort order (default: updated)" },
          limit: { type: "number", description: "Max results (default 20, max 200)" },
          offset: { type: "number", description: "Pagination offset" },
        },
      },
    },
    {
      name: "memory_getKnowledgeSummary",
      description: "Get a summary of Consilium's local memory: total count, per-scope counts, top tags, and recency buckets",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
  ]
}

export async function startMcpServer() {
  const sessionMgr = new SessionManager()
  const registry = buildAutoRegistrySync()
  const unknown = unknownWriteAgents(registry.names())
  if (unknown.length > 0) {
    console.error(`[consilium mcp] CONSILIUM_MCP_WRITE_AGENTS names no registered agent: ${unknown.join(", ")} (registered: ${registry.names().join(", ")})`)
  }
  const store = sessionMgr.getStore()
  const rawDb = store.rawSqlite()
  const memStore = new MemoryStore(store)

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
      const result = await handleTool(name, args ?? {}, sessionMgr, registry, memStore, rawDb)
      return { content: [{ type: "text", text: result }] }
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err}` }], isError: true }
    }
  })

  await server.connect(new StdioServerTransport())
  console.error("Consilium MCP server running on stdio")
}

export async function handleTool(
  name: string,
  args: Record<string, unknown>,
  sessionMgr: SessionManager,
  registry: AdapterRegistry,
  memStore: MemoryStore,
  rawDb: Database,
  env: Record<string, string | undefined> = process.env,
): Promise<string> {
  if (name === "start_session") {
    const mode = (args.mode as "council" | "dispatch" | "pipeline" | "debate") ?? "dispatch"
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

    const used = new Map<string, string>()
    const guarded = wrapRegistryForMcp(registry, env, (agent, access) => used.set(agent, access))
    const router = guarded.get(session.router)
    if (!router) throw new Error(`Router '${session.router}' not found`)
    if (mcpAccessFor(router.name, env) === "read-only" && router.supportsReadOnly !== true) {
      throw new ReadOnlyUnsupportedError(router.name)
    }

    const { usable, skipped } = splitUsable(guarded.except(session.router), env)
    if (session.mode === "pipeline" && usable.length === 0 && skipped.length > 0) {
      throw new Error(
        `Pipeline has no agent left to run or review: ${skipped.join(", ")} ha${skipped.length === 1 ? "s" : "ve"} no read-only mode and ` +
        `${skipped.length === 1 ? "is" : "are"} not listed in CONSILIUM_MCP_WRITE_AGENTS.`,
      )
    }

    const runner = new CouncilRunner({ router, adapters: usable })
    let resultText: string

    if (session.mode === "council") {
      const r = await runner.council(message, context)
      resultText = r.synthesis
    } else if (session.mode === "dispatch") {
      const r = await runner.dispatch(message, context)
      resultText = r.content
    } else if (session.mode === "debate") {
      const r = await runner.debate(message, context)
      resultText = r.synthesis
    } else {
      const r = await runner.pipeline(message, context)
      if (r.reviews.length === 0) throw new Error("Pipeline finished with no reviews, so its result is not approved.")
      resultText = r.taskContent
    }

    resultText += readOnlySkipNote(skipped) + accessSummary(used)
    console.error(`[consilium mcp] send_message ${sessionId} ${accessSummary(used).trim()}`)
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

  if (name === "list_agents") {
    const agents = await Promise.all(
      registry.all().map(async a => ({
        name: a.name,
        available: await a.isAvailable().catch(() => false),
      }))
    )
    return JSON.stringify(agents)
  }

  if (name === "list_workflows") {
    const workflows = await loadAllWorkflows()
    const list = [...workflows.values()].map(w => ({
      name: w.name,
      description: w.description ?? "",
      trust: w.trust,
      steps: w.steps.length,
    }))
    return JSON.stringify(list)
  }

  if (name === "run_workflow") {
    const workflowName = args.workflow as string
    const input = args.input as string
    const routerName = (args.router as string) ?? "claude"

    const workflow = await loadWorkflow(workflowName)
    if (!workflow) throw new Error(`Workflow '${workflowName}' not found`)

    if (workflow.trust === "checkpoint" && env.CONSILIUM_MCP_ALLOW_CHECKPOINT_WORKFLOWS !== "1") {
      throw new Error(
        `Workflow '${workflowName}' has trust: checkpoint. It pauses for a person to approve between steps, so it must be run in the Consilium TUI. ` +
        `To allow it over MCP anyway, start the MCP server with CONSILIUM_MCP_ALLOW_CHECKPOINT_WORKFLOWS=1.`,
      )
    }

    const used = new Map<string, string>()
    const guarded = wrapRegistryForMcp(registry, env, (agent, access) => used.set(agent, access))
    if (workflow.steps.some(s => !s.agent)) {
      const router = guarded.get(routerName)
      if (!router) throw new Error(`Router '${routerName}' not found`)
      if (mcpAccessFor(router.name, env) === "read-only" && router.supportsReadOnly !== true) {
        throw new ReadOnlyUnsupportedError(router.name)
      }
    }
    const { usable, skipped } = splitUsable(guarded.all(), env)
    for (const step of workflow.steps) {
      if (step.agent && skipped.includes(step.agent)) throw new ReadOnlyUnsupportedError(step.agent)
    }
    const runner = new WorkflowRunner(registryOf(usable), routerName)
    const steps: Array<{ step: number; agent: string; output: string }> = []

    const context = await runner.run(workflow, input, {
      onStepComplete: (stepNum, outputKey, content) => {
        steps.push({ step: stepNum, agent: outputKey, output: content })
      },
    })

    const access = accessSummary(used).trim()
    console.error(`[consilium mcp] run_workflow ${workflowName} ${access}`)
    return JSON.stringify({ workflow: workflowName, input, steps, finalContext: context, access, skipped })
  }

  if (name === "memory_storeKnowledge") {
    const title = args.title as string
    const content = args.content as string
    const tags = (args.tags as string[] | undefined) ?? []
    const scope = (args.scope as KnowledgeScope | undefined) ?? "global"
    const record = memStore.storeKnowledge({ title, content, tags, scope })
    return JSON.stringify(record)
  }

  if (name === "memory_updateKnowledge") {
    const id = args.id as string
    const title = args.title as string | undefined
    const content = args.content as string | undefined
    const tags = args.tags as string[] | undefined
    const scope = args.scope as KnowledgeScope | undefined
    const record = memStore.updateKnowledge({ id, title, content, tags, scope })
    return JSON.stringify(record)
  }

  if (name === "memory_searchKnowledge") {
    const opts: SearchOptions = {
      query: args.query as string,
      tags: args.tags as string[] | undefined,
      scope: args.scope as KnowledgeScope | undefined,
      contextTags: args.contextTags as string[] | undefined,
      limit: typeof args.limit === "number" ? args.limit : 10,
    }
    const results = memStore.searchKnowledge(opts)
    return JSON.stringify(results)
  }

  if (name === "memory_listKnowledge") {
    const { listKnowledge } = await import("../core/memory/list.js")
    const result = listKnowledge(rawDb, {
      scope: args.scope as KnowledgeScope | undefined,
      tags: args.tags as string[] | undefined,
      query: args.query as string | undefined,
      sort: args.sort as "title" | "created" | "updated" | "scope" | undefined,
      limit: typeof args.limit === "number" ? args.limit : undefined,
      offset: typeof args.offset === "number" ? args.offset : undefined,
    })
    return JSON.stringify(result)
  }

  if (name === "memory_getKnowledgeSummary") {
    const { getKnowledgeSummary } = await import("../core/memory/summary.js")
    return JSON.stringify(getKnowledgeSummary(rawDb))
  }

  throw new Error(`Unknown tool: ${name}`)
}
