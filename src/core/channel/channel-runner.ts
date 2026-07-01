import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import type { ChannelConfig } from "./types.js"
import { TelegramBot, type TelegramUpdate } from "./telegram-bot.js"

// ---------------------------------------------------------------------------
// Agent registry reader (reads ~/.consilium/agent-registry.json)
// ---------------------------------------------------------------------------

interface AgentEntry {
  pid: number
  name: string
  type: string
  sessionFilePath?: string
}

const REGISTRY_PATH = join(homedir(), ".consilium", "agent-registry.json")

function loadRegistry(): AgentEntry[] {
  if (!existsSync(REGISTRY_PATH)) return []
  try {
    return JSON.parse(readFileSync(REGISTRY_PATH, "utf8")) as AgentEntry[]
  } catch {
    return []
  }
}

function findAgent(agentId: string): AgentEntry | null {
  const entries = loadRegistry()
  return entries.find(e => e.name === agentId || String(e.pid) === agentId) ?? null
}

// ---------------------------------------------------------------------------
// Inline TTY writer: send a message to an agent's tmux pane
// ---------------------------------------------------------------------------

/**
 * Walk the process tree from pid upward to see if ancestorPid is an ancestor.
 * Uses `ps -o ppid= -p <pid>` on each step (macOS / Linux compatible).
 */
function isDescendantOf(pid: number, ancestorPid: number): boolean {
  let current = pid
  for (let depth = 0; depth < 20; depth++) {
    if (current === ancestorPid) return true
    if (current <= 1) return false
    const result = Bun.spawnSync(["ps", "-o", "ppid=", "-p", String(current)], {
      stdout: "pipe",
      stderr: "pipe",
    })
    if (result.exitCode !== 0) return false
    const ppid = parseInt(new TextDecoder().decode(result.stdout).trim(), 10)
    if (isNaN(ppid) || ppid <= 0 || ppid === current) return false
    current = ppid
  }
  return false
}

/**
 * Find the tmux pane ID whose shell process is an ancestor of the given PID.
 * Returns the pane target string (e.g. "%3") or null if not found.
 */
function findTmuxPaneForPid(targetPid: number): string | null {
  const result = Bun.spawnSync(["tmux", "list-panes", "-a", "-F", "#{pane_id} #{pane_pid}"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  if (result.exitCode !== 0) return null

  const output = new TextDecoder().decode(result.stdout).trim()
  for (const line of output.split("\n")) {
    const parts = line.trim().split(" ")
    if (parts.length < 2) continue
    const paneId = parts[0]
    const panePid = parseInt(parts[1], 10)
    if (isNaN(panePid)) continue
    if (isDescendantOf(targetPid, panePid)) return paneId
  }
  return null
}

/**
 * Send a text message to the agent running in a tmux pane.
 * Returns true on success, false if tmux is not available or pane not found.
 */
function sendViaTmux(pid: number, message: string): boolean {
  const paneTarget = findTmuxPaneForPid(pid)
  if (!paneTarget) return false

  // 1. Load message into a named buffer via stdin
  const loadResult = Bun.spawnSync(
    ["tmux", "load-buffer", "-b", "consilium-channel", "-"],
    {
      stdin: new TextEncoder().encode(message),
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  if (loadResult.exitCode !== 0) return false

  // 2. Paste the buffer into the target pane (preserves multi-line)
  const pasteResult = Bun.spawnSync(
    ["tmux", "paste-buffer", "-t", paneTarget, "-p", "-d", "-b", "consilium-channel"],
    { stdout: "pipe", stderr: "pipe" },
  )
  if (pasteResult.exitCode !== 0) return false

  // 3. Send Enter to submit
  const enterResult = Bun.spawnSync(
    ["tmux", "send-keys", "-t", paneTarget, "Enter"],
    { stdout: "pipe", stderr: "pipe" },
  )
  return enterResult.exitCode === 0
}

// ---------------------------------------------------------------------------
// Inline JSONL poller: wait for a new assistant message in the session file
// ---------------------------------------------------------------------------

interface MessageSnapshot {
  count: number
  lastText: string
}

/**
 * Count assistant messages in a Claude JSONL session file and return the
 * text of the most recent one.
 *
 * Claude session lines have the shape:
 *   { "type": "message", "message": { "role": "assistant", "content": [...] } }
 */
function snapshotAssistantMessages(sessionFilePath: string): MessageSnapshot {
  if (!existsSync(sessionFilePath)) return { count: 0, lastText: "" }
  try {
    const raw = readFileSync(sessionFilePath, "utf8")
    let count = 0
    let lastText = ""
    for (const line of raw.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const obj = JSON.parse(trimmed) as {
          type?: string
          message?: {
            role?: string
            content?: Array<{ type: string; text?: string }> | string
          }
        }
        if (obj.type === "message" && obj.message?.role === "assistant") {
          count++
          const content = obj.message.content
          if (Array.isArray(content)) {
            lastText = content
              .filter(c => c.type === "text")
              .map(c => c.text ?? "")
              .join("")
          } else if (typeof content === "string") {
            lastText = content
          }
        }
      } catch {
        // skip malformed lines
      }
    }
    return { count, lastText }
  } catch {
    return { count: 0, lastText: "" }
  }
}

interface WaitResult {
  success: boolean
  message: string
  timedOut: boolean
}

async function waitForReply(
  sessionFilePath: string,
  snapshotCount: number,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<WaitResult> {
  const deadline = Date.now() + timeoutMs
  const pollMs = 2_000

  while (Date.now() < deadline && !signal.aborted) {
    await new Promise<void>(r => setTimeout(r, pollMs))
    if (signal.aborted) break
    const current = snapshotAssistantMessages(sessionFilePath)
    if (current.count > snapshotCount) {
      return { success: true, message: current.lastText, timedOut: false }
    }
  }

  if (signal.aborted) return { success: false, message: "", timedOut: false }
  return { success: false, message: "", timedOut: true }
}

// ---------------------------------------------------------------------------
// Bridge loop
// ---------------------------------------------------------------------------

/**
 * Run the Telegram ↔ agent bridge until signal is aborted.
 *
 * Incoming Telegram messages from config.chatId are forwarded to the agent
 * via tmux; the agent's JSONL reply is relayed back to Telegram.
 */
export async function runChannelBridge(
  config: ChannelConfig,
  signal: AbortSignal,
): Promise<void> {
  const bot = new TelegramBot(config.botToken)

  // Validate bot token and connectivity
  try {
    const me = await bot.getMe()
    console.log(`[channel] Connected as @${me.username}`)
  } catch (err) {
    console.error(`[channel] Failed to connect to Telegram: ${err instanceof Error ? err.message : String(err)}`)
    return
  }

  console.log(`[channel] Bridge started: Telegram chat ${config.chatId} → agent "${config.agentId}"`)
  console.log(`[channel] Press Ctrl+C to stop.\n`)

  let offset: number | undefined

  while (!signal.aborted) {
    // ── Long-poll Telegram for incoming updates ──────────────────────────────
    let updates: TelegramUpdate[]
    try {
      updates = await bot.getUpdates(offset, 30)
    } catch (err) {
      if (signal.aborted) break
      console.error(`[channel] getUpdates error: ${err instanceof Error ? err.message : String(err)}`)
      // Back off before retrying
      await new Promise<void>(r => setTimeout(r, 5_000))
      continue
    }

    for (const update of updates) {
      offset = update.update_id + 1

      if (signal.aborted) break

      const msg = update.message
      if (!msg?.text) continue

      const chatId = String(msg.chat.id)

      // Filter: only accept messages from the authorized chat
      if (chatId !== config.chatId) {
        await bot.sendMessage(chatId, "Unauthorized. This bot is bound to a specific chat.")
        continue
      }

      const userText = msg.text.trim()
      if (!userText) continue

      const preview = userText.length > 80 ? `${userText.slice(0, 80)}...` : userText
      console.log(`[channel] → agent: ${preview}`)

      // ── Resolve agent ──────────────────────────────────────────────────────
      const agent = findAgent(config.agentId)
      if (!agent) {
        console.error(`[channel] Agent "${config.agentId}" not found in registry.`)
        await bot.sendMessage(
          config.chatId,
          `Agent "${config.agentId}" not found. Is it running? Check \`consilium agents list\`.`,
        )
        continue
      }

      // ── Send to agent via tmux ─────────────────────────────────────────────
      const sent = sendViaTmux(agent.pid, userText)
      if (!sent) {
        console.error(`[channel] Failed to reach agent "${config.agentId}" (pid ${agent.pid}) — no tmux pane found.`)
        await bot.sendMessage(config.chatId, "Agent not reachable (no tmux pane found).")
        continue
      }

      // ── Wait for agent reply ───────────────────────────────────────────────
      if (!agent.sessionFilePath) {
        console.log(`[channel] Message sent (no session file tracked — reply relay skipped).`)
        await bot.sendMessage(config.chatId, "Message sent. (Reply relay unavailable — no session file tracked.)")
        continue
      }

      const snap = snapshotAssistantMessages(agent.sessionFilePath)
      const result = await waitForReply(agent.sessionFilePath, snap.count, 120_000, signal)

      if (result.timedOut) {
        console.log(`[channel] ← agent: (timed out)`)
        await bot.sendMessage(config.chatId, "Agent did not respond within 120s.")
      } else if (result.success) {
        const replyPreview = result.message.length > 80
          ? `${result.message.slice(0, 80)}...`
          : result.message
        console.log(`[channel] ← agent: ${replyPreview}`)
        await bot.sendMessage(config.chatId, result.message || "(empty reply)")
      }
      // If signal aborted during wait, outer loop will exit on next iteration
    }
  }

  console.log("[channel] Bridge stopped.")
}

// Re-export update type so callers don't need to import telegram-bot separately
export type { TelegramUpdate }
