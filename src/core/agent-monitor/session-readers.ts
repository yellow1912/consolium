/**
 * session-readers.ts
 *
 * Per-agent-type session data readers for non-Claude agents.
 * Each reader is graceful: returns null on any error or missing files.
 *
 * Paths ported from ai-devkit adapters:
 *   Codex    → ~/.codex/sessions/YYYY/MM/DD/*.jsonl
 *   Gemini   → ~/.gemini/tmp/<shortId>/chats/session-*.json
 *   OpenCode → ~/.local/share/opencode/opencode.db (bun:sqlite)
 */

import { join } from "node:path"
import { homedir } from "node:os"
import { existsSync, readdirSync, statSync } from "node:fs"

export interface AgentSessionData {
  title: string | null
  lastActiveAt: string | null
  /** "running" = active within 5 min; "idle" = older; "unknown" = no timestamp */
  status: "running" | "idle" | "unknown"
}

const IDLE_THRESHOLD_MS = 5 * 60 * 1000

function deriveStatus(lastActiveAt: string | null): AgentSessionData["status"] {
  if (!lastActiveAt) return "unknown"
  const age = Date.now() - new Date(lastActiveAt).getTime()
  return age > IDLE_THRESHOLD_MS ? "idle" : "running"
}

function parseIso(value: unknown): string | null {
  if (!value || typeof value !== "string") return null
  try {
    const d = new Date(value)
    return isNaN(d.getTime()) ? null : d.toISOString()
  } catch {
    return null
  }
}

// ── Codex ──────────────────────────────────────────────────────────────────────
//
// Session files live at ~/.codex/sessions/YYYY/MM/DD/<uuid>.jsonl
// Each file is JSONL where the first line is a `session_meta` entry:
//   { type: "session_meta", payload: { id, cwd, timestamp }, timestamp }
// Subsequent lines are events:
//   { type: "...", payload: { type, message }, timestamp }
// The first event with payload.message (string) is the user's opening prompt.

interface CodexEntry {
  type?: string
  payload?: {
    id?: string
    cwd?: string
    timestamp?: string
    message?: string
    type?: string
  }
  timestamp?: string
}

/**
 * Find and parse the most recent Codex session matching the given cwd.
 * If cwd is omitted, returns the most recently modified session.
 */
export async function readCodexSession(cwd?: string): Promise<AgentSessionData | null> {
  try {
    const sessionsDir = join(homedir(), ".codex", "sessions")
    if (!existsSync(sessionsDir)) return null

    // Collect all .jsonl files sorted by mtime descending
    const files = collectDateDirFiles(sessionsDir, ".jsonl")

    for (const filePath of files) {
      try {
        const text = await Bun.file(filePath).text()
        const lines = text.trim().split("\n")
        if (!lines[0]) continue

        let meta: CodexEntry
        try {
          meta = JSON.parse(lines[0]) as CodexEntry
        } catch {
          continue
        }

        if (meta.type !== "session_meta" || !meta.payload?.id) continue

        // CWD filter
        if (cwd && meta.payload.cwd && meta.payload.cwd !== cwd) continue

        let title: string | null = null
        let lastActiveAt: string | null = parseIso(meta.payload.timestamp)

        for (let i = 1; i < lines.length; i++) {
          const raw = lines[i].trim()
          if (!raw) continue
          let entry: CodexEntry
          try {
            entry = JSON.parse(raw) as CodexEntry
          } catch {
            continue
          }

          if (entry.timestamp) {
            const ts = parseIso(entry.timestamp)
            if (ts) lastActiveAt = ts
          }

          if (
            !title &&
            entry.type !== "session_meta" &&
            typeof entry.payload?.message === "string" &&
            entry.payload.message.trim()
          ) {
            title = entry.payload.message.trim().slice(0, 60)
          }
        }

        return { title, lastActiveAt, status: deriveStatus(lastActiveAt) }
      } catch {
        continue
      }
    }

    return null
  } catch {
    return null
  }
}

/** Recursively collect files with the given extension from YYYY/MM/DD subdirs, mtime desc. */
function collectDateDirFiles(root: string, ext: string): string[] {
  const collected: { path: string; mtime: number }[] = []

  const tryReadDir = (p: string) => {
    try { return readdirSync(p) } catch { return [] }
  }
  const tryIsDir = (p: string) => {
    try { return statSync(p).isDirectory() } catch { return false }
  }
  const tryMtime = (p: string) => {
    try { return statSync(p).mtimeMs } catch { return 0 }
  }

  for (const y of tryReadDir(root)) {
    const yp = join(root, y)
    if (!tryIsDir(yp)) continue
    for (const m of tryReadDir(yp)) {
      const mp = join(yp, m)
      if (!tryIsDir(mp)) continue
      for (const d of tryReadDir(mp)) {
        const dp = join(mp, d)
        if (!tryIsDir(dp)) continue
        for (const f of tryReadDir(dp)) {
          if (!f.endsWith(ext)) continue
          const fp = join(dp, f)
          collected.push({ path: fp, mtime: tryMtime(fp) })
        }
      }
    }
  }

  collected.sort((a, b) => b.mtime - a.mtime)
  return collected.map(c => c.path)
}

// ── Gemini ─────────────────────────────────────────────────────────────────────
//
// Session files live at ~/.gemini/tmp/<shortId>/chats/session-*.json
// Each file is JSON:
//   { sessionId, startTime, lastUpdated, messages[], directories[] }
// directories[0] is the project path / CWD.
// messages have { type, timestamp, content, displayContent }
// First message with type === "user" gives the opening prompt.

interface GeminiMessage {
  type?: string
  timestamp?: string
  content?: unknown
  displayContent?: unknown
}

interface GeminiSessionFile {
  sessionId?: string
  startTime?: string
  lastUpdated?: string
  messages?: GeminiMessage[]
  directories?: string[]
}

/**
 * Find and parse the most recent Gemini CLI session matching the given cwd.
 */
export async function readGeminiSession(cwd?: string): Promise<AgentSessionData | null> {
  try {
    const tmpDir = join(homedir(), ".gemini", "tmp")
    if (!existsSync(tmpDir)) return null

    const candidates: { path: string; mtime: number }[] = []

    for (const shortId of safeReaddir(tmpDir)) {
      const chatsDir = join(tmpDir, shortId, "chats")
      if (!existsSync(chatsDir)) continue
      for (const file of safeReaddir(chatsDir)) {
        if (!file.startsWith("session-") || !file.endsWith(".json")) continue
        const fp = join(chatsDir, file)
        try {
          candidates.push({ path: fp, mtime: statSync(fp).mtimeMs })
        } catch {
          // skip unreadable
        }
      }
    }

    candidates.sort((a, b) => b.mtime - a.mtime)

    for (const { path: filePath } of candidates) {
      try {
        const text = await Bun.file(filePath).text()
        let parsed: GeminiSessionFile
        try {
          parsed = JSON.parse(text) as GeminiSessionFile
        } catch {
          continue
        }

        if (!parsed.sessionId) continue

        // CWD filter via directories[0]
        if (cwd && Array.isArray(parsed.directories) && parsed.directories.length > 0) {
          if (parsed.directories[0] !== cwd) continue
        }

        const messages = Array.isArray(parsed.messages) ? parsed.messages : []

        // First user message text
        let title: string | null = null
        for (const msg of messages) {
          if (msg.type !== "user") continue
          const text = resolveGeminiContent(msg.displayContent ?? msg.content)
          if (text.trim()) {
            title = text.trim().slice(0, 60)
            break
          }
        }

        // lastActiveAt: lastUpdated or last message timestamp
        const lastEntry = messages.length > 0 ? messages[messages.length - 1] : undefined
        const lastActiveAt =
          parseIso(parsed.lastUpdated) ??
          parseIso(lastEntry?.timestamp) ??
          null

        return { title, lastActiveAt, status: deriveStatus(lastActiveAt) }
      } catch {
        continue
      }
    }

    return null
  } catch {
    return null
  }
}

function resolveGeminiContent(content: unknown): string {
  if (!content) return ""
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .filter((p): p is Record<string, unknown> => typeof p === "object" && p !== null)
      .map(p => (typeof p["text"] === "string" ? p["text"] : ""))
      .join("")
  }
  return ""
}

function safeReaddir(dir: string): string[] {
  try { return readdirSync(dir) } catch { return [] }
}

// ── OpenCode ───────────────────────────────────────────────────────────────────
//
// OpenCode stores sessions in a SQLite DB: ~/.local/share/opencode/opencode.db
// (or $XDG_DATA_HOME/opencode/opencode.db)
//
// Relevant schema (from OpenCodeAdapter):
//   session(id TEXT, directory TEXT, time_created INTEGER)
//   message(id TEXT, session_id TEXT, data JSON, time_updated INTEGER)
//   part(id TEXT, message_id TEXT, session_id TEXT, data JSON, time_created INTEGER)
//
// data JSON for message: { "role": "user"|"assistant", "time": { "completed": ... } }
// data JSON for part:    { "type": "text"|"reasoning"|"tool", "text": "..." }

/**
 * Find and parse the most recent OpenCode session matching the given cwd.
 * Uses bun:sqlite (readonly) — no better-sqlite3.
 */
export async function readOpenCodeSession(cwd?: string): Promise<AgentSessionData | null> {
  try {
    const xdg = process.env["XDG_DATA_HOME"]
    const base = xdg ?? join(homedir(), ".local", "share")
    const dbPath = join(base, "opencode", "opencode.db")

    if (!existsSync(dbPath)) return null

    const { Database } = await import("bun:sqlite")
    const db = new Database(dbPath, { readonly: true })

    try {
      // Find most recent session for this directory (or globally)
      const sessionRow = cwd
        ? (db
            .query(
              "SELECT id, time_created FROM session WHERE directory = ? ORDER BY time_created DESC LIMIT 1"
            )
            .get(cwd) as { id: string; time_created: number } | null)
        : (db
            .query(
              "SELECT id, time_created FROM session ORDER BY time_created DESC LIMIT 1"
            )
            .get() as { id: string; time_created: number } | null)

      if (!sessionRow) return null
      const sessionId = sessionRow.id

      // First user message text
      const firstMsg = db
        .query(`
          SELECT json_extract(p.data, '$.text') AS text
          FROM part p
          JOIN message m ON p.message_id = m.id
          WHERE p.session_id = ?
            AND json_extract(m.data, '$.role') = 'user'
            AND json_extract(p.data, '$.type') = 'text'
            AND json_extract(p.data, '$.text') IS NOT NULL
          ORDER BY p.time_created ASC
          LIMIT 1
        `)
        .get(sessionId) as { text: string } | null

      // Max time_updated across all messages (heartbeat)
      const heartbeat = db
        .query("SELECT MAX(time_updated) AS maxUpdated FROM message WHERE session_id = ?")
        .get(sessionId) as { maxUpdated: number | null } | null

      const lastActiveMs = heartbeat?.maxUpdated ?? sessionRow.time_created
      const lastActiveAt = new Date(lastActiveMs).toISOString()

      return {
        title: firstMsg?.text?.trim().slice(0, 60) ?? null,
        lastActiveAt,
        status: deriveStatus(lastActiveAt),
      }
    } finally {
      db.close()
    }
  } catch {
    return null
  }
}
