import type { AgentAdapter, AgentResponse, Message } from "./types"

export abstract class SubprocessAdapter implements AgentAdapter {
  abstract readonly name: string
  abstract readonly bin: string
  abstract buildArgs(prompt: string): string[]

  async isAvailable(): Promise<boolean> {
    const proc = Bun.spawnSync(["which", this.bin])
    return proc.exitCode === 0
  }

  async query(prompt: string, context: Message[]): Promise<AgentResponse> {
    const fullPrompt = this.buildContextPrompt(prompt, context)
    const start = Date.now()
    const proc = Bun.spawn([this.bin, ...this.buildArgs(fullPrompt)], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    if (exitCode !== 0) {
      throw new Error(`${this.name} exited with code ${exitCode}: ${stderr}`)
    }
    return {
      agent: this.name,
      content: stdout.trim(),
      durationMs: Date.now() - start,
    }
  }

  protected buildContextPrompt(prompt: string, context: Message[]): string {
    if (context.length === 0) return prompt
    const history = context.map(m => `[${m.agent ?? m.role}]: ${m.content}`).join("\n")
    return `${history}\n\n[user]: ${prompt}`
  }
}
