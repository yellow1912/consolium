import type { AgentAdapter, AgentResponse, Message } from "./types"

export class ClaudeAdapter implements AgentAdapter {
  readonly name = "claude"
  private model: string

  constructor(model = "claude-sonnet-4-6") {
    this.model = model
  }

  async isAvailable(): Promise<boolean> {
    try { await import("@anthropic-ai/claude-agent-sdk"); return true }
    catch { return false }
  }

  private async _query(prompt: string): Promise<string> {
    const { query } = await import("@anthropic-ai/claude-agent-sdk")
    const chunks: string[] = []
    for await (const event of query({ prompt, model: this.model, tools: [] })) {
      if (event.type === "assistant" && event.message?.content) {
        for (const block of event.message.content) {
          if (block.type === "text") chunks.push(block.text)
        }
      }
    }
    return chunks.join("")
  }

  async query(prompt: string, context: Message[]): Promise<AgentResponse> {
    const fullPrompt = context.length > 0
      ? context.map(m => `[${m.agent ?? m.role}]: ${m.content}`).join("\n") + `\n\n[user]: ${prompt}`
      : prompt
    const start = Date.now()
    const content = await this._query(fullPrompt)
    return { agent: this.name, content, durationMs: Date.now() - start }
  }
}
