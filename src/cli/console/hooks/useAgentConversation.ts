import { useState, useEffect } from "react"
import { readFileSync } from "node:fs"

const POLL_INTERVAL_MS = 3000
const MAX_MESSAGES = 20   // tail last N messages

export interface ConversationMessage {
  role: "user" | "assistant" | "system"
  content: string
}

export function useAgentConversation(sessionFilePath: string | undefined) {
  const [messages, setMessages] = useState<ConversationMessage[]>([])

  useEffect(() => {
    if (!sessionFilePath) { setMessages([]); return }

    const readTail = () => {
      try {
        const text = readFileSync(sessionFilePath, "utf8")
        const lines = text.trim().split("\n").filter(Boolean)
        const parsed: ConversationMessage[] = []
        for (const line of lines) {
          try {
            const obj = JSON.parse(line)
            // Handle Claude JSONL format: { type: "assistant"|"user", message: { content: [...] } }
            // OR simpler format: { role: "assistant"|"user", content: "..." }
            if (obj.type === "user" || obj.role === "user") {
              const content = obj.message?.content?.[0]?.text ?? obj.content ?? ""
              if (content) parsed.push({ role: "user", content: String(content) })
            } else if (obj.type === "assistant" || obj.role === "assistant") {
              const content = obj.message?.content?.[0]?.text ?? obj.content ?? ""
              if (content) parsed.push({ role: "assistant", content: String(content) })
            }
          } catch { /* skip malformed lines */ }
        }
        const tail = parsed.slice(-MAX_MESSAGES)
        setMessages(prev => JSON.stringify(prev) !== JSON.stringify(tail) ? tail : prev)
      } catch { /* file unreadable */ }
    }

    readTail()
    const id = setInterval(readTail, POLL_INTERVAL_MS)
    return () => clearInterval(id)
  }, [sessionFilePath])

  return messages
}
