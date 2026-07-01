import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { join } from "node:path"
import { tmpdir, homedir } from "node:os"
import { mkdirSync, rmSync, utimesSync } from "node:fs"
import { parseClaudeSession, listSessionFiles } from "./claude-session-parser"

const TMP = join(tmpdir(), `consilium-session-test-${Date.now()}`)

beforeAll(() => {
  mkdirSync(TMP, { recursive: true })
})

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true })
})

describe("parseClaudeSession", () => {
  it("parses format 1 (type field) and returns correct title, messageCount, lastActiveAt, status", async () => {
    const path = join(TMP, "session-format1.jsonl")
    const ts = new Date(Date.now() - 10 * 60 * 1000).toISOString() // 10 min ago → idle
    await Bun.write(
      path,
      [
        JSON.stringify({ type: "user", timestamp: ts, message: { content: "Hello format one" } }),
        JSON.stringify({ type: "assistant", timestamp: ts, message: { content: "Response here" } }),
      ].join("\n"),
    )

    const result = await parseClaudeSession(path)

    expect(result.sessionId).toBe("session-format1")
    expect(result.title).toBe("Hello format one")
    expect(result.lastMessage).toBe("Response here")
    expect(result.messageCount).toBe(2)
    expect(result.lastActiveAt).toBe(ts)
    expect(result.status).toBe("idle")
  })

  it("parses format 2 (role field) and returns correct title and lastMessage", async () => {
    const path = join(TMP, "session-format2.jsonl")
    const ts = new Date(Date.now() - 30 * 60 * 1000).toISOString() // 30 min ago → idle
    await Bun.write(
      path,
      [
        JSON.stringify({ role: "user", timestamp: ts, content: "What is bun?" }),
        JSON.stringify({ role: "assistant", timestamp: ts, content: "Bun is a JavaScript runtime." }),
      ].join("\n"),
    )

    const result = await parseClaudeSession(path)

    expect(result.title).toBe("What is bun?")
    expect(result.lastMessage).toBe("Bun is a JavaScript runtime.")
    expect(result.messageCount).toBe(2)
    expect(result.status).toBe("idle")
  })

  it("extracts title from content array of text blocks", async () => {
    const path = join(TMP, "session-blocks.jsonl")
    const ts = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    await Bun.write(
      path,
      JSON.stringify({
        type: "user",
        timestamp: ts,
        message: {
          content: [{ type: "text", text: "Hello from text block" }],
        },
      }),
    )

    const result = await parseClaudeSession(path)

    expect(result.title).toBe("Hello from text block")
    expect(result.messageCount).toBe(1)
  })

  it("skips noise messages and sets title to first non-noise user message", async () => {
    const path = join(TMP, "session-noise.jsonl")
    const ts = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    await Bun.write(
      path,
      [
        JSON.stringify({ type: "user", timestamp: ts, message: { content: "[Request interrupted by user]" } }),
        JSON.stringify({ type: "user", timestamp: ts, message: { content: "Tool loaded." } }),
        JSON.stringify({
          type: "user",
          timestamp: ts,
          message: { content: "This session is being continued from a previous conversation" },
        }),
        JSON.stringify({ type: "user", timestamp: ts, message: { content: "Real user message" } }),
      ].join("\n"),
    )

    const result = await parseClaudeSession(path)

    expect(result.title).toBe("Real user message")
    expect(result.messageCount).toBe(1)
  })

  it("returns null title and zero messageCount for an empty file", async () => {
    const path = join(TMP, "session-empty.jsonl")
    await Bun.write(path, "")

    const result = await parseClaudeSession(path)

    expect(result.title).toBeNull()
    expect(result.lastMessage).toBeNull()
    expect(result.lastActiveAt).toBeNull()
    expect(result.messageCount).toBe(0)
    expect(result.status).toBe("unknown")
  })

  it("returns unknown status for a nonexistent file", async () => {
    const result = await parseClaudeSession(join(TMP, "does-not-exist.jsonl"))

    expect(result.title).toBeNull()
    expect(result.messageCount).toBe(0)
    expect(result.status).toBe("unknown")
    expect(result.sessionId).toBe("does-not-exist")
  })

  it("derives sessionId from filename by stripping .jsonl extension", async () => {
    const path = join(TMP, "my-unique-session-42.jsonl")
    await Bun.write(path, "")

    const result = await parseClaudeSession(path)

    expect(result.sessionId).toBe("my-unique-session-42")
  })

  it("truncates long title to 60 characters", async () => {
    const path = join(TMP, "session-long-title.jsonl")
    const ts = new Date(Date.now() - 30 * 60 * 1000).toISOString()
    const longText = "A".repeat(120)
    await Bun.write(
      path,
      JSON.stringify({ type: "user", timestamp: ts, message: { content: longText } }),
    )

    const result = await parseClaudeSession(path)

    expect(result.title).toBe("A".repeat(60))
    expect(result.title!.length).toBe(60)
  })

  it("truncates long lastMessage to 80 characters", async () => {
    const path = join(TMP, "session-long-msg.jsonl")
    const ts = new Date(Date.now() - 30 * 60 * 1000).toISOString()
    const longText = "B".repeat(200)
    await Bun.write(
      path,
      [
        JSON.stringify({ type: "user", timestamp: ts, message: { content: "short prompt" } }),
        JSON.stringify({ type: "assistant", timestamp: ts, message: { content: longText } }),
      ].join("\n"),
    )

    const result = await parseClaudeSession(path)

    expect(result.lastMessage).toBe("B".repeat(80))
    expect(result.lastMessage!.length).toBe(80)
  })

  it("reports status as active when lastActiveAt is less than 5 minutes ago", async () => {
    const path = join(TMP, "session-active.jsonl")
    const ts = new Date(Date.now() - 2 * 60 * 1000).toISOString() // 2 min ago
    await Bun.write(
      path,
      JSON.stringify({ type: "user", timestamp: ts, message: { content: "Recent message" } }),
    )

    const result = await parseClaudeSession(path)

    expect(result.status).toBe("active")
  })

  it("reports status as unknown when lastActiveAt is older than 2 hours", async () => {
    const path = join(TMP, "session-old.jsonl")
    const ts = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString() // 3 hours ago
    await Bun.write(
      path,
      JSON.stringify({ type: "user", timestamp: ts, message: { content: "Old message" } }),
    )

    const result = await parseClaudeSession(path)

    expect(result.status).toBe("unknown")
  })
})

describe("listSessionFiles", () => {
  it("returns empty array when no matching claude projects directory exists", () => {
    const result = listSessionFiles("/absolutely/nonexistent/path/consilium-xyz-99999")
    expect(result).toEqual([])
  })

  it("returns files sorted by mtime descending when directory exists", async () => {
    // Derive the exact encoded cwd name the function uses
    const uniqueCwd = `/tmp/consilium-ls-test-${Date.now()}`
    const encodedCwd = uniqueCwd.replace(/[^a-zA-Z0-9]/g, "-")
    const sessionDir = join(homedir(), ".claude", "projects", encodedCwd)

    mkdirSync(sessionDir, { recursive: true })

    const olderPath = join(sessionDir, "older.jsonl")
    const newerPath = join(sessionDir, "newer.jsonl")

    try {
      // Write both files
      await Bun.write(olderPath, '{"type":"user","message":{"content":"old"}}\n')
      await Bun.write(newerPath, '{"type":"user","message":{"content":"new"}}\n')

      // Force older file to have a clearly earlier mtime
      const past = new Date(Date.now() - 60_000)
      utimesSync(olderPath, past, past)

      const files = listSessionFiles(uniqueCwd)

      expect(files.length).toBe(2)
      expect(files[0]).toContain("newer.jsonl")
      expect(files[1]).toContain("older.jsonl")
    } finally {
      rmSync(sessionDir, { recursive: true, force: true })
    }
  })
})
