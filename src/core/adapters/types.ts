export type Message = {
  role: "user" | "agent" | "system"
  agent: string | null
  content: string
}

export type AgentResponse = {
  agent: string
  content: string
  durationMs: number
}

export interface AgentAdapter {
  readonly name: string
  query(prompt: string, context: Message[]): Promise<AgentResponse>
  stream?(prompt: string, context: Message[]): AsyncIterable<string>
  isAvailable(): Promise<boolean>
}
