export type Message = {
  role: "user" | "agent" | "system"
  agent: string | null
  content: string
}

export type AgentResponseMetadata = {
  promptChars?: number
  responseChars?: number
  estimatedPromptTokens?: number
  estimatedResponseTokens?: number
  selectedModel?: string
  routedAgent?: string
  fallbackReason?: string
  exitCode?: number
}

export type AgentResponse = {
  agent: string
  content: string
  durationMs: number
  sessionId?: string
  metadata?: AgentResponseMetadata
}

export type ModelInfo = {
  id: string
  name: string
  capabilities: ("coding" | "reasoning" | "general" | "fast")[]
  isDefault?: boolean
}

export type Access = "read-only" | "full"

export type QueryOptions = {
  model?: string
  /** Undefined means "full": the interactive TUI is run by a person who chose that. */
  access?: Access
  agentSessionId?: string
  systemPrompt?: string
  signal?: AbortSignal
}

export interface AgentAdapter {
  readonly name: string
  /** True when the agent has a verified read-only invocation. Missing means unsupported. */
  readonly supportsReadOnly?: boolean
  query(prompt: string, context: Message[], options?: QueryOptions): Promise<AgentResponse>
  queryStream?(prompt: string, context: Message[], options?: QueryOptions): AsyncGenerator<string, void, unknown>
  stream?(prompt: string, context: Message[], options?: QueryOptions): AsyncIterable<string>
  isAvailable(): Promise<boolean>
  getModels(): Promise<ModelInfo[]>
  readonly lastSessionId?: string
}

export class ReadOnlyUnsupportedError extends Error {
  constructor(agent: string) {
    super(`agent ${agent} has no read-only mode; it is not started over MCP unless listed in CONSILIUM_MCP_WRITE_AGENTS`)
    this.name = "ReadOnlyUnsupportedError"
  }
}
