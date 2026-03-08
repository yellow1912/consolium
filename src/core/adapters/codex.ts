import type { AgentAdapter, AgentResponse, Message } from "./types"

export class CodexAdapter implements AgentAdapter {
  readonly name = "codex"
  private model: string

  constructor(model = "gpt-4o") { this.model = model }

  async isAvailable(): Promise<boolean> {
    try { await import("@openai/codex-sdk"); return true }
    catch { return false }
  }

  private async _query(prompt: string): Promise<string> {
    const { Codex } = await import("@openai/codex-sdk")
    const codex = new Codex()
    const result = await codex.query({ prompt, model: this.model })
    return result.output ?? ""
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
