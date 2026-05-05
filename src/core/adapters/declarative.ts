import type { AgentDef } from "./defs"
import type { AgentAdapter, AgentResponse, Message, ModelInfo, QueryOptions } from "./types"
import { createParser } from "./stream"

export class DeclarativeAdapter implements AgentAdapter {
  readonly name: string
  private def: AgentDef

  constructor(def: AgentDef) {
    this.def = def
    this.name = def.name
  }

  async isAvailable(): Promise<boolean> {
    return Bun.spawnSync(["which", this.def.bin]).exitCode === 0
  }

  async getModels(): Promise<ModelInfo[]> {
    if (this.def.modelProbe) {
      try {
        const proc = Bun.spawn([this.def.bin, ...this.def.modelProbe], {
          stdin: "ignore", stdout: "pipe", stderr: "pipe",
        })
        const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()])
        if (exitCode === 0 && stdout.trim()) {
          try {
            const parsed = JSON.parse(stdout)
            if (Array.isArray(parsed)) {
              return parsed.map((m: any) => ({
                id: m.id ?? m.name ?? String(m),
                name: m.name ?? m.id ?? String(m),
                capabilities: m.capabilities ?? (["general"] as const),
              }))
            }
          } catch {
            return stdout.trim().split("\n").filter(Boolean).map(line => ({
              id: line.trim(),
              name: line.trim(),
              capabilities: ["general"] as ModelInfo["capabilities"],
            }))
          }
        }
      } catch { /* probe failed — use fallback */ }
    }
    return this.def.fallbackModels
  }

  private buildEnv(): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = { ...process.env }
    if (this.def.deleteEnv) {
      for (const key of this.def.deleteEnv) delete env[key]
    }
    if (this.def.env) {
      Object.assign(env, this.def.env)
    }
    return env
  }

  private buildContextPrompt(prompt: string, context: Message[]): string {
    if (context.length === 0) return prompt
    const history = context.map(m => `[${m.agent ?? m.role}]: ${m.content}`).join("\n")
    return `${history}\n\n[user]: ${prompt}`
  }

  private buildJsonRpcRequest(prompt: string): string {
    const method = this.def.jsonrpcMethod ?? "tasks/send"
    const isAcp = method === "tasks/send"
    const params = isAcp
      ? { id: `task-${Date.now()}`, message: { role: "user", parts: [{ type: "text", text: prompt }] } }
      : { prompt }
    return JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) + "\n"
  }

  private spawn(prompt: string, args: string[]) {
    const env = this.buildEnv()
    const needsStdin = this.def.promptVia === "stdin" || this.def.promptVia === "jsonrpc"
    const proc = Bun.spawn([this.def.bin, ...args], {
      stdin: needsStdin ? "pipe" : "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env,
    })
    if (this.def.promptVia === "jsonrpc") {
      proc.stdin.write(this.buildJsonRpcRequest(prompt))
      proc.stdin.end()
    } else if (this.def.promptVia === "stdin") {
      proc.stdin.write(prompt)
      proc.stdin.end()
    }
    return proc
  }

  async query(prompt: string, context: Message[], options?: QueryOptions): Promise<AgentResponse> {
    const fullPrompt = this.buildContextPrompt(prompt, context)
    const start = Date.now()

    let args = this.def.buildArgs(fullPrompt, { model: options?.model })
    let proc = this.spawn(fullPrompt, args)

    const onAbort = () => proc.kill()
    options?.signal?.addEventListener("abort", onAbort, { once: true })

    try {
      let [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])

      if (exitCode !== 0 && options?.model && stderr.toLowerCase().includes("model")) {
        console.warn(`[${this.name}] model '${options.model}' rejected, retrying with default`)
        args = this.def.buildArgs(fullPrompt, {})
        proc = this.spawn(fullPrompt, args)
        ;[exitCode, stdout, stderr] = await Promise.all([
          proc.exited,
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ])
      }

      if (exitCode !== 0) {
        throw new Error(`${this.name} exited with code ${exitCode}: ${stderr}`)
      }
      return { agent: this.name, content: stdout.trim(), durationMs: Date.now() - start }
    } finally {
      options?.signal?.removeEventListener("abort", onAbort)
    }
  }

  async *queryStream(prompt: string, context: Message[], options?: QueryOptions): AsyncGenerator<string, void, unknown> {
    const fullPrompt = this.buildContextPrompt(prompt, context)
    const args = this.def.buildArgs(fullPrompt, { model: options?.model })
    const proc = this.spawn(fullPrompt, args)

    const onAbort = () => proc.kill()
    options?.signal?.addEventListener("abort", onAbort, { once: true })
    const reader = proc.stdout.getReader()
    const decoder = new TextDecoder()
    const parser = createParser(this.def.streamFormat, this.def.name)
    let streamError: Error | undefined

    try {
      while (true) {
        if (options?.signal?.aborted) break
        const { done, value } = await reader.read()
        if (done) break
        const raw = decoder.decode(value, { stream: true })
        for (const token of parser.feed(raw)) yield token
      }
      const remaining = decoder.decode()
      if (remaining) {
        for (const token of parser.feed(remaining)) yield token
      }
      if (!options?.signal?.aborted) {
        for (const token of parser.flush()) yield token
      }
    } catch (e) {
      streamError = e instanceof Error ? e : new Error(String(e))
    } finally {
      reader.releaseLock()
      options?.signal?.removeEventListener("abort", onAbort)
      try { proc.kill() } catch {}
      await proc.exited.catch(() => {})
    }

    if (streamError) throw streamError
    if (options?.signal?.aborted) return
    const exitCode = await proc.exited.catch(() => -1)
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text().catch(() => "")
      throw new Error(`${this.name} exited with code ${exitCode}: ${stderr}`)
    }
  }
}
