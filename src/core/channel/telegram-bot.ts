const TELEGRAM_API_BASE = "https://api.telegram.org"
const MAX_MESSAGE_LENGTH = 4096

export interface TelegramUpdate {
  update_id: number
  message?: {
    message_id: number
    chat: { id: number }
    text?: string
  }
}

export interface TelegramMe {
  id: number
  username: string
}

/**
 * Thin Telegram Bot API wrapper using fetch() (no telegraf dependency).
 * Uses long-polling for incoming updates.
 */
export class TelegramBot {
  constructor(private token: string) {}

  private get base(): string {
    return `${TELEGRAM_API_BASE}/bot${this.token}`
  }

  async getUpdates(offset?: number, timeout?: number): Promise<TelegramUpdate[]> {
    const params = new URLSearchParams()
    if (offset !== undefined) params.set("offset", String(offset))
    if (timeout !== undefined) params.set("timeout", String(timeout))
    params.set("allowed_updates", JSON.stringify(["message"]))

    const resp = await fetch(`${this.base}/getUpdates?${params}`, {
      // Signal-free: long-poll naturally resolves when timeout elapses
      signal: AbortSignal.timeout((timeout ?? 30) * 1000 + 10_000),
    })
    if (!resp.ok) {
      throw new Error(`getUpdates HTTP ${resp.status}: ${resp.statusText}`)
    }
    const data = (await resp.json()) as { ok: boolean; result: TelegramUpdate[] }
    if (!data.ok) throw new Error("getUpdates returned ok=false")
    return data.result
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    const chunks = splitMessage(text)
    for (const chunk of chunks) {
      const resp = await fetch(`${this.base}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: chunk }),
      })
      if (!resp.ok) {
        // Best-effort delivery — log but don't throw
        console.error(`[channel] sendMessage failed: HTTP ${resp.status}`)
      }
    }
  }

  async getMe(): Promise<TelegramMe> {
    const resp = await fetch(`${this.base}/getMe`)
    if (!resp.ok) {
      throw new Error(`getMe HTTP ${resp.status}: ${resp.statusText}`)
    }
    const data = (await resp.json()) as { ok: boolean; result: TelegramMe }
    if (!data.ok) throw new Error("getMe returned ok=false")
    return data.result
  }
}

/**
 * Split a long message into chunks of at most maxLen characters,
 * preferring to break at newlines.
 */
function splitMessage(text: string, maxLen = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= maxLen) return [text]
  const chunks: string[] = []
  let remaining = text
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining)
      break
    }
    const slice = remaining.slice(0, maxLen)
    const lastNl = slice.lastIndexOf("\n")
    const cutAt = lastNl > 0 ? lastNl + 1 : maxLen
    chunks.push(remaining.slice(0, cutAt))
    remaining = remaining.slice(cutAt)
  }
  return chunks
}
