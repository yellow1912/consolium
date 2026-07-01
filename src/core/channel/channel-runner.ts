import type { ChannelConfig } from "./types.js"
import { TelegramBot, type TelegramUpdate } from "./telegram-bot.js"
import { AgentRegistry } from "../agent-monitor/registry.js"
import { TtyWriter } from "../agent-monitor/tty-writer.js"
import { WaitWatcher } from "../agent-monitor/wait-watcher.js"

/**
 * Run the Telegram ↔ agent bridge until signal is aborted.
 *
 * Incoming Telegram messages from config.chatId are forwarded to the agent
 * via the agent's terminal; the agent's JSONL reply is relayed back to Telegram.
 */
export async function runChannelBridge(config: ChannelConfig, signal: AbortSignal): Promise<void> {
  const bot = new TelegramBot(config.botToken)
  const tty = new TtyWriter()
  const watcher = new WaitWatcher()
  let offset = 0

  console.log(`[channel] bridge started for agent "${config.agentId}" on chat ${config.chatId}`)

  while (!signal.aborted) {
    // poll Telegram
    let updates: TelegramUpdate[]
    try {
      updates = await bot.getUpdates(offset, 30)
    } catch {
      if (signal.aborted) break
      await new Promise(r => setTimeout(r, 5000))
      continue
    }

    for (const update of updates) {
      offset = update.update_id + 1
      const text = update.message?.text
      const chatId = String(update.message?.chat.id ?? "")
      if (!text || chatId !== config.chatId) continue

      // Find agent in registry
      const registry = new AgentRegistry()
      const entries = registry.load()
      const entry = entries.find(e => e.name === config.agentId || String(e.pid) === config.agentId)
      if (!entry) {
        await bot.sendMessage(config.chatId, `Agent "${config.agentId}" not found in registry.`)
        continue
      }

      // Send to agent terminal
      const location = tty.detectTerminal(entry.pid)
      if (!location) {
        await bot.sendMessage(config.chatId, `No supported terminal for agent "${config.agentId}".`)
        continue
      }

      console.log(`[channel] → agent: ${text.slice(0, 80)}`)
      tty.send(location, text)

      // Wait for reply
      if (!entry.sessionFilePath) {
        await bot.sendMessage(config.chatId, "(message sent, but no session file to watch for reply)")
        continue
      }

      const result = await watcher.wait(entry.sessionFilePath, { timeoutMs: 120_000 })
      if (result.success && result.message) {
        console.log(`[channel] ← agent: ${result.message.slice(0, 80)}`)
        await bot.sendMessage(config.chatId, result.message)
      } else if (result.timedOut) {
        await bot.sendMessage(config.chatId, "Agent did not respond within 120s.")
      } else {
        await bot.sendMessage(config.chatId, "(no session file found for agent)")
      }
    }
  }

  console.log("[channel] bridge stopped")
}

// Re-export update type so callers don't need to import telegram-bot separately
export type { TelegramUpdate }
