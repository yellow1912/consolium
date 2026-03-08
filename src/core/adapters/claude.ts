import { randomUUID } from "node:crypto"
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

  private async _query(prompt: string, options?: QueryOptions): Promise<{ content: string; sessionId: string }> {
    const sessionId = options?.agentSessionId ?? randomUUID()

    const runWith = async (opts?: QueryOptions): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
      const args = ["--print"]
      const model = opts?.model ?? this.model
      if (model) args.push("--model", model)

      if (opts?.agentSessionId) {
        args.push("--resume", opts.agentSessionId)
      } else {
        args.push("--session-id", sessionId)
        const sysPrompt = opts?.systemPrompt ?? this.role
        if (sysPrompt) args.push("--system-prompt", sysPrompt)
      }

      args.push(prompt)
      const env = { ...process.env }
      delete env.CLAUDECODE
      const proc = Bun.spawn(["claude", ...args], { stdout: "pipe", stderr: "pipe", env })
      const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      return { exitCode, stdout, stderr }
    }

    let { exitCode, stdout, stderr } = await runWith(options)
    if (exitCode !== 0 && options?.model && stderr.toLowerCase().includes("model")) {
      console.warn(`[claude] model '${options.model}' rejected, retrying with default`)
      ;({ exitCode, stdout, stderr } = await runWith({ ...options, model: undefined }))
    }
    if (exitCode !== 0) throw new Error(`claude exited with code ${exitCode}: ${stderr}`)
    return { content: stdout.trim(), sessionId }
  }

  async query(prompt: string, context: Message[], options?: QueryOptions): Promise<AgentResponse> {
    // When resuming a session, CouncilRunner has already built the delta — pass as-is.
    // Otherwise flatten context for backward compatibility.
    const effectivePrompt = options?.agentSessionId || context.length === 0
      ? prompt
      : context.map(m => `[${m.agent ?? m.role}]: ${m.content}`).join("\n") + `\n\n[user]: ${prompt}`
    const start = Date.now()
    const { content, sessionId } = await this._query(effectivePrompt, options)
    return { agent: this.name, content, durationMs: Date.now() - start, sessionId }
  }
}
