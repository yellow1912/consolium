import { homedir } from "node:os"
import { join } from "node:path"
import { readdirSync, statSync } from "node:fs"

export interface ParsedSession {
  sessionId: string       // from filename
  title: string | null    // first user message (truncated to 60 chars)
  lastMessage: string | null  // last assistant message (truncated to 80 chars)
  lastActiveAt: string | null // ISO timestamp of last event
  messageCount: number
  status: "active" | "idle" | "unknown"
}

type ContentBlock = {
  type?: string
  text?: string
  content?: string
}

type SessionLine = {
  type?: string
  role?: string
  timestamp?: string
  message?: {
    content?: string | ContentBlock[]
  }
  content?: string | ContentBlock[]
}

/** Extract the first meaningful text string from a content field. */
function extractText(content: string | ContentBlock[] | undefined): string | null {
  if (!content) return null
  if (typeof content === "string") return content.trim() || null
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        return block.text.trim()
      }
    }
  }
  return null
}

/** Filter out internal harness noise from user messages. */
function isNoiseMessage(text: string): boolean {
  return (
    text.startsWith("[Request interrupted") ||
    text === "Tool loaded." ||
    text.startsWith("This session is being continued")
  )
}

/**
 * Parse a Claude Code JSONL session file into a summary.
 *
 * Handles both Claude Code JSONL formats:
 *   - {type: "user"|"assistant", message: {role, content}}
 *   - {role: "user"|"assistant", content}
 *
 * Returns a ParsedSession with status derived from lastActiveAt age.
 */
export async function parseClaudeSession(jsonlPath: string): Promise<ParsedSession> {
  const sessionId = jsonlPath.split("/").pop()?.replace(/\.jsonl$/, "") ?? ""

  let raw: string
  try {
    raw = await Bun.file(jsonlPath).text()
  } catch {
    return {
      sessionId,
      title: null,
      lastMessage: null,
      lastActiveAt: null,
      messageCount: 0,
      status: "unknown",
    }
  }

  const lines = raw.split("\n")
  let title: string | null = null
  let lastMessage: string | null = null
  let lastActiveAt: string | null = null
  let messageCount = 0

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    let entry: SessionLine
    try {
      entry = JSON.parse(trimmed) as SessionLine
    } catch {
      continue
    }

    // Track latest timestamp across all lines
    if (entry.timestamp) {
      const ts = new Date(entry.timestamp)
      if (!isNaN(ts.getTime())) {
        lastActiveAt = ts.toISOString()
      }
    }

    const isUser = entry.type === "user" || entry.role === "user"
    const isAssistant = entry.type === "assistant" || entry.role === "assistant"

    if (!isUser && !isAssistant) continue

    // Content lives in message.content (format 1) or directly in content (format 2)
    const content = entry.message?.content ?? entry.content
    const text = extractText(content)

    if (isUser) {
      if (text && !isNoiseMessage(text)) {
        messageCount++
        if (!title) {
          title = text.slice(0, 60)
        }
      }
    } else {
      // assistant
      if (text) {
        messageCount++
        lastMessage = text.slice(0, 80)
      }
    }
  }

  let status: "active" | "idle" | "unknown" = "unknown"
  if (lastActiveAt) {
    const ageMs = Date.now() - new Date(lastActiveAt).getTime()
    if (ageMs < 5 * 60 * 1000) {
      status = "active"
    } else if (ageMs < 2 * 60 * 60 * 1000) {
      status = "idle"
    }
  }

  return { sessionId, title, lastMessage, lastActiveAt, messageCount, status }
}

/**
 * List JSONL session files for a given working directory.
 *
 * Looks in ~/.claude/projects/<encodeURIComponent(cwd)>/*.jsonl
 * and returns absolute paths sorted by mtime descending (newest first).
 */
export function listSessionFiles(cwd: string): string[] {
  if (!cwd) return []
  try {
    const projectsDir = join(homedir(), ".claude", "projects")
    const encodedCwd = encodeURIComponent(cwd)
    const sessionDir = join(projectsDir, encodedCwd)

    let files: string[]
    try {
      files = readdirSync(sessionDir).filter(f => f.endsWith(".jsonl"))
    } catch {
      return []
    }

    if (files.length === 0) return []

    const withStats = files.map(f => {
      const fullPath = join(sessionDir, f)
      try {
        return { path: fullPath, mtime: statSync(fullPath).mtime.getTime() }
      } catch {
        return { path: fullPath, mtime: 0 }
      }
    })
    withStats.sort((a, b) => b.mtime - a.mtime)
    return withStats.map(w => w.path)
  } catch {
    return []
  }
}
