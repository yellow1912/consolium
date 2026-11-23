import { AdapterRegistry } from "../core/adapters/registry"
import {
  ReadOnlyUnsupportedError,
  type Access,
  type AgentAdapter,
  type AgentResponse,
  type Message,
  type ModelInfo,
  type QueryOptions,
} from "../core/adapters/types"

/**
 * Access an agent gets over MCP. Read-only unless the person who registered the
 * server listed the agent in CONSILIUM_MCP_WRITE_AGENTS (comma-separated, or "*").
 * Only the server's environment decides; no tool argument can change it.
 */
export function mcpAccessFor(agentName: string, env: Record<string, string | undefined> = process.env): Access {
  const names = (env.CONSILIUM_MCP_WRITE_AGENTS ?? "").split(",").map(n => n.trim()).filter(Boolean)
  return names.includes("*") || names.includes(agentName) ? "full" : "read-only"
}

export type AccessRecorder = (agent: string, access: Access) => void

/** Forces the MCP access mode onto every call, ignoring any access the caller passes. */
class McpAccessAdapter implements AgentAdapter {
  readonly name: string
  readonly supportsReadOnly: boolean
  queryStream?: AgentAdapter["queryStream"]
  stream?: AgentAdapter["stream"]

  constructor(
    private inner: AgentAdapter,
    private access: Access,
    private record?: AccessRecorder,
  ) {
    this.name = inner.name
    this.supportsReadOnly = inner.supportsReadOnly === true
    if (inner.queryStream) {
      this.queryStream = (prompt, context, options) => this.streamGuarded(prompt, context, options)
    }
    if (inner.stream) {
      this.stream = (prompt, context, options) => {
        this.check()
        return inner.stream!(prompt, context, { ...options, access })
      }
    }
  }

  get lastSessionId() { return this.inner.lastSessionId }

  private check(): void {
    if (this.access === "read-only" && !this.supportsReadOnly) throw new ReadOnlyUnsupportedError(this.name)
    this.record?.(this.name, this.access)
  }

  async query(prompt: string, context: Message[], options?: QueryOptions): Promise<AgentResponse> {
    this.check()
    return this.inner.query(prompt, context, { ...options, access: this.access })
  }

  private async *streamGuarded(prompt: string, context: Message[], options?: QueryOptions) {
    this.check()
    yield* this.inner.queryStream!(prompt, context, { ...options, access: this.access })
  }

  isAvailable(): Promise<boolean> { return this.inner.isAvailable() }
  getModels(): Promise<ModelInfo[]> { return this.inner.getModels() }
}

export function wrapRegistryForMcp(
  registry: AdapterRegistry,
  env: Record<string, string | undefined> = process.env,
  record?: AccessRecorder,
): AdapterRegistry {
  const wrapped = new AdapterRegistry()
  for (const a of registry.all()) wrapped.register(new McpAccessAdapter(a, mcpAccessFor(a.name, env), record))
  return wrapped
}

/** Splits adapters into those that may be started under MCP access and those that may not (no read-only mode, not opted in). */
export function splitUsable(
  adapters: AgentAdapter[],
  env: Record<string, string | undefined> = process.env,
): { usable: AgentAdapter[]; skipped: string[] } {
  const usable = adapters.filter(a => mcpAccessFor(a.name, env) === "full" || a.supportsReadOnly === true)
  return { usable, skipped: adapters.filter(a => !usable.includes(a)).map(a => a.name) }
}

export function registryOf(adapters: AgentAdapter[]): AdapterRegistry {
  const r = new AdapterRegistry()
  for (const a of adapters) r.register(a)
  return r
}

/** Names in CONSILIUM_MCP_WRITE_AGENTS that match no registered agent. Exact, case-sensitive; "*" is not a name. */
export function unknownWriteAgents(known: string[], env: Record<string, string | undefined> = process.env): string[] {
  return (env.CONSILIUM_MCP_WRITE_AGENTS ?? "")
    .split(",").map(n => n.trim()).filter(n => n && n !== "*" && !known.includes(n))
}

export function accessSummary(used: Map<string, string>): string {
  const list = [...used].map(([agent, access]) => `${agent}=${access}`).join(", ")
  return `\n\n[access: ${list || "no agent started"}]`
}

export function readOnlySkipNote(skipped: string[]): string {
  if (skipped.length === 0) return ""
  return `\n\n[skipped: ${skipped.join(", ")} have no read-only mode and were not started. Set CONSILIUM_MCP_WRITE_AGENTS to include them to allow full access.]`
}
