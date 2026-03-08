import type { AgentAdapter, AgentResponse, Message, ModelInfo, QueryOptions } from "./types"

export abstract class SubprocessAdapter implements AgentAdapter {
  abstract readonly name: string
  abstract readonly bin: string
  abstract buildArgs(prompt: string, options?: QueryOptions): string[]

  async isAvailable(): Promise<boolean> {
    const proc = Bun.spawnSync(["which", this.bin])
    return proc.exitCode === 0
  }

  protected async spawnAndRead(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn([this.bin, ...args], { stdout: "pipe", stderr: "pipe" })
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    return { exitCode, stdout, stderr }
  }

  async query(prompt: string, context: Message[], options?: QueryOptions): Promise<AgentResponse> {
    const fullPrompt = this.buildContextPrompt(prompt, context)
    const start = Date.now()
    let { exitCode, stdout, stderr } = await this.spawnAndRead(this.buildArgs(fullPrompt, options))

    // Heuristic: each CLI uses different wording ("unknown model", "invalid model id", etc.)
    // The broad "model" substring catches all of them. False positives (e.g. rate-limit messages
    // that mention "model") are acceptable — retrying with the default is safe.
    if (exitCode !== 0 && options?.model && stderr.toLowerCase().includes("model")) {
      // model not found — retry without model override
      console.warn(`[${this.name}] model '${options.model}' rejected, retrying with default`)
      ;({ exitCode, stdout, stderr } = await this.spawnAndRead(this.buildArgs(fullPrompt))) // Retry without model option — let the CLI use its own default
    }

    if (exitCode !== 0) {
      throw new Error(`${this.name} exited with code ${exitCode}: ${stderr}`)
    }
    return {
      agent: this.name,
      content: stdout.trim(),
      durationMs: Date.now() - start,
    }
  }

  abstract getModels(): Promise<ModelInfo[]>

  protected buildContextPrompt(prompt: string, context: Message[]): string {
    if (context.length === 0) return prompt
    const history = context.map(m => `[${m.agent ?? m.role}]: ${m.content}`).join("\n")
    return `${history}\n\n[user]: ${prompt}`
  }
}
