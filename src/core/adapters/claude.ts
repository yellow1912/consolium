import { randomUUID } from "node:crypto"
import type { AgentResponse, Message, ModelInfo, QueryOptions } from "./types"
import { SubprocessAdapter } from "./base"

type ClaudeAdapterOptions = {
  name?: string
  model?: string | null
  role?: string
}

export class ClaudeAdapter extends SubprocessAdapter {
  readonly name: string
  readonly bin = "claude"
  private model: string | null
  private role: string
  private _sessionId = ""
  private _isResume = false

  constructor({ name = "claude", model = null, role = "" }: ClaudeAdapterOptions = {}) {
    super()
    this.name = name
    this.model = model
    this.role = role
  }

  async getModels(): Promise<ModelInfo[]> {
    return [
      { id: "claude-opus-4-6", name: "Claude Opus 4.6", capabilities: ["reasoning"] },
      { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", capabilities: ["coding", "reasoning"], isDefault: true },
      { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", capabilities: ["fast", "general"] },
    ]
  }

  buildArgs(prompt: string, options?: QueryOptions): string[] {
    const args = ["--print"]
    const model = options?.model ?? this.model
    if (model) args.push("--model", model)
    if (this._isResume) {
      args.push("--resume", this._sessionId)
    } else {
      args.push("--session-id", this._sessionId)
      const sysPrompt = options?.systemPrompt ?? this.role
      if (sysPrompt) args.push("--system-prompt", sysPrompt)
    }
    args.push(prompt)
    return args
  }

  protected override async spawnAndRead(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const env = { ...process.env }
    delete env.CLAUDECODE
    const proc = Bun.spawn([this.bin, ...args], { stdout: "pipe", stderr: "pipe", env })
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    return { exitCode, stdout, stderr }
  }

  override async *queryStream(prompt: string, context: Message[], options?: QueryOptions): AsyncGenerator<string, void, unknown> {
    this._isResume = !!options?.agentSessionId
    this._sessionId = options?.agentSessionId ?? randomUUID()
    const effectivePrompt = this._isResume || context.length === 0
      ? prompt
      : this.buildContextPrompt(prompt, context)
    const args = this.buildArgs(effectivePrompt, options)
    const env = { ...process.env }
    delete env.CLAUDECODE
    const proc = Bun.spawn([this.bin, ...args], { stdout: "pipe", stderr: "pipe", env })
    const reader = proc.stdout.getReader()
    const decoder = new TextDecoder()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        yield decoder.decode(value, { stream: true })
      }
      const remaining = decoder.decode()
      if (remaining) yield remaining
    } finally {
      reader.releaseLock()
    }
    const exitCode = await proc.exited
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text()
      throw new Error(`claude exited with code ${exitCode}: ${stderr}`)
    }
  }

  override async query(prompt: string, context: Message[], options?: QueryOptions): Promise<AgentResponse> {
    this._isResume = !!options?.agentSessionId
    this._sessionId = options?.agentSessionId ?? randomUUID()
    const sessionId = this._sessionId
    const effectivePrompt = this._isResume || context.length === 0
      ? prompt
      : this.buildContextPrompt(prompt, context)
    const start = Date.now()
    let { exitCode, stdout, stderr } = await this.spawnAndRead(this.buildArgs(effectivePrompt, options))
    if (exitCode !== 0 && options?.model && stderr.toLowerCase().includes("model")) {
      console.warn(`[claude] model '${options.model}' rejected, retrying with default`)
      ;({ exitCode, stdout, stderr } = await this.spawnAndRead(this.buildArgs(effectivePrompt, { ...options, model: undefined })))
    }
    if (exitCode !== 0) throw new Error(`claude exited with code ${exitCode}: ${stderr}`)
    return { agent: this.name, content: stdout.trim(), durationMs: Date.now() - start, sessionId }
  }
}
