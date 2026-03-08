import type { AgentAdapter, AgentResponse, Message, ModelInfo, QueryOptions } from "./types"

type ClaudeAdapterOptions = {
  name?: string
  model?: string | null
  role?: string
}

export class ClaudeAdapter implements AgentAdapter {
  readonly name: string
  private model: string | null
  private role: string

  constructor({ name = "claude", model = null, role = "" }: ClaudeAdapterOptions = {}) {
    this.name = name
    this.model = model
    this.role = role
  }

  async isAvailable(): Promise<boolean> {
    const proc = Bun.spawnSync(["which", "claude"])
    return proc.exitCode === 0
  }

  async getModels(): Promise<ModelInfo[]> {
    return [
      { id: "claude-opus-4-6", name: "Claude Opus 4.6", capabilities: ["reasoning"] },
      { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", capabilities: ["coding", "reasoning"], isDefault: true },
      { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", capabilities: ["fast", "general"] },
    ]
  }

  private async _query(prompt: string, options?: QueryOptions): Promise<string> {
    const args = ["--print"]
    const model = options?.model ?? this.model
    if (model) args.push("--model", model)
    if (this.role) args.push("--system-prompt", this.role)
    args.push(prompt)
    const env = { ...process.env }
    delete env.CLAUDECODE
    const proc = Bun.spawn(["claude", ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env,
    })
    const [, stdout] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    return stdout.trim()
  }

  async query(prompt: string, context: Message[], options?: QueryOptions): Promise<AgentResponse> {
    const contextStr = context.length > 0
      ? context.map(m => `[${m.agent ?? m.role}]: ${m.content}`).join("\n") + `\n\n[user]: ${prompt}`
      : prompt
    const start = Date.now()
    const content = await this._query(contextStr, options)
    return { agent: this.name, content, durationMs: Date.now() - start }
  }
}
