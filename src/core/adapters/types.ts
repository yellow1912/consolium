export type Message = {
  role: "user" | "agent" | "system"
  agent: string | null
  content: string
}

export type AgentResponse = {
  agent: string
  content: string
  durationMs: number
  sessionId?: string
}

export type ModelInfo = {
  id: string
  name: string
  capabilities: ("coding" | "reasoning" | "general" | "fast")[]
  isDefault?: boolean
}

export type QueryOptions = {
  model?: string
  agentSessionId?: string
  systemPrompt?: string
}

export interface AgentAdapter {
  readonly name: string
  query(prompt: string, context: Message[], options?: QueryOptions): Promise<AgentResponse>
  stream?(prompt: string, context: Message[], options?: QueryOptions): AsyncIterable<string>
  isAvailable(): Promise<boolean>
  getModels(): Promise<ModelInfo[]>
}
