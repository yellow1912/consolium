import { existsSync, readFileSync } from "node:fs"

export interface WaitResult {
  success: boolean
  message?: string     // new assistant message content
  timedOut: boolean
}

export class WaitWatcher {
  async wait(sessionFilePath: string, opts?: { timeoutMs?: number; pollMs?: number }): Promise<WaitResult> {
    const timeoutMs = opts?.timeoutMs ?? 120_000
    const pollMs = opts?.pollMs ?? 2_000

    if (!existsSync(sessionFilePath)) {
      return { success: false, timedOut: false }
    }

    // 1. Snapshot: count current assistant messages in JSONL
    const snapshot = this.countAssistantMessages(sessionFilePath)

    // 2. Poll every pollMs until new assistant message found or timeout
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, pollMs))
      const current = this.countAssistantMessages(sessionFilePath)
      if (current > snapshot) {
        const msg = this.getLastAssistantMessage(sessionFilePath)
        return { success: true, message: msg, timedOut: false }
      }
    }

    return { success: false, timedOut: true }
  }

  countAssistantMessages(path: string): number {
    try {
      const content = readFileSync(path, "utf8")
      let count = 0
      for (const line of content.split("\n")) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const obj = JSON.parse(trimmed)
          if (this._isAssistantMessage(obj)) count++
        } catch {
          // skip malformed lines
        }
      }
      return count
    } catch {
      return 0
    }
  }

  getLastAssistantMessage(path: string): string | undefined {
    try {
      const content = readFileSync(path, "utf8")
      let last: string | undefined
      for (const line of content.split("\n")) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const obj = JSON.parse(trimmed)
          if (this._isAssistantMessage(obj)) {
            last = this._extractContent(obj)
          }
        } catch {
          // skip malformed lines
        }
      }
      return last
    } catch {
      return undefined
    }
  }

  private _isAssistantMessage(obj: unknown): boolean {
    if (typeof obj !== "object" || obj === null) return false
    const o = obj as Record<string, unknown>
    // Format 1: { type: "assistant", message: { content: [...] } }
    if (o.type === "assistant") return true
    // Format 2: { role: "assistant", content: "..." }
    if (o.role === "assistant") return true
    return false
  }

  private _extractContent(obj: Record<string, unknown>): string {
    // Format 1: { type: "assistant", message: { content: [...] } }
    if (obj.type === "assistant" && typeof obj.message === "object" && obj.message !== null) {
      const msg = obj.message as Record<string, unknown>
      if (Array.isArray(msg.content)) {
        return msg.content
          .filter(
            (c: unknown): c is Record<string, string> =>
              typeof c === "object" && c !== null && (c as Record<string, unknown>).type === "text",
          )
          .map(c => c.text)
          .join("")
      }
      if (typeof msg.content === "string") return msg.content
    }
    // Format 2: { role: "assistant", content: "..." }
    if (typeof obj.content === "string") return obj.content
    return ""
  }
}
