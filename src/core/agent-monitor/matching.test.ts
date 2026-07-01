import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { homedir } from "node:os"
import { join } from "node:path"
import { mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs"
import { matchAgentsToSessions } from "./matching"

function encodeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-")
}

function sessionDir(fakeCwd: string): string {
  return join(homedir(), ".claude", "projects", encodeCwd(fakeCwd))
}

/** Write an empty .jsonl file and set its mtime to the given timestamp (ms). */
function writeSessionFile(dir: string, name: string, mtimeMs: number): string {
  const filePath = join(dir, `${name}.jsonl`)
  writeFileSync(filePath, "")
  utimesSync(filePath, new Date(mtimeMs), new Date(mtimeMs))
  return filePath
}

describe("matchAgentsToSessions", () => {
  let fakeCwd: string
  let dir: string

  beforeEach(() => {
    // Each test gets a unique fake cwd so directories never collide across tests.
    fakeCwd = `/tmp/consilium-match-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    dir = sessionDir(fakeCwd)
    mkdirSync(dir, { recursive: true })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  // ── Phase 1: high-confidence ─────────────────────────────────────────────────

  it("returns a high-confidence match when agent startedAt is within maxAgeMs of file mtime", async () => {
    const now = Date.now()
    writeSessionFile(dir, "session-abc", now)

    const results = await matchAgentsToSessions(
      [{ pid: 100, cwd: fakeCwd, startedAt: new Date(now + 200).toISOString(), agentType: "claude" }],
      5000,
    )

    expect(results).toHaveLength(1)
    expect(results[0].pid).toBe(100)
    expect(results[0].sessionId).toBe("session-abc")
    expect(results[0].confidence).toBe("high")
  })

  it("selects the file closest in mtime when multiple candidates are within maxAgeMs", async () => {
    const now = Date.now()

    // fileClose is 100 ms before agent startedAt; fileFar is 2 seconds before.
    // Both fall within a 5-second window, but fileClose wins (smaller delta).
    writeSessionFile(dir, "session-far", now - 2000)
    writeSessionFile(dir, "session-close", now - 100)

    const results = await matchAgentsToSessions(
      [{ pid: 200, cwd: fakeCwd, startedAt: new Date(now).toISOString(), agentType: "claude" }],
      5000,
    )

    expect(results).toHaveLength(1)
    expect(results[0].sessionId).toBe("session-close")
    expect(results[0].confidence).toBe("high")
  })

  it("does not match when the only file mtime is outside maxAgeMs", async () => {
    const now = Date.now()
    writeSessionFile(dir, "session-stale", now - 10_000) // 10 s ago

    // Use codex so phase 2 is also skipped — isolates the maxAgeMs guard in phase 1.
    const results = await matchAgentsToSessions(
      [{ pid: 300, cwd: fakeCwd, startedAt: new Date(now).toISOString(), agentType: "codex" as const }],
      5000, // 5 s window — file is outside
    )

    expect(results).toHaveLength(0)
  })

  // ── Greedy 1:1 assignment ─────────────────────────────────────────────────────

  it("assigns each agent its nearest file and never double-claims a pid or file", async () => {
    const now = Date.now()

    // Two files at distinct times; two agents each tuned to one of them.
    writeSessionFile(dir, "session-1", now - 500)
    writeSessionFile(dir, "session-2", now - 3000)

    const agents = [
      { pid: 301, cwd: fakeCwd, startedAt: new Date(now - 500).toISOString(), agentType: "claude" as const },
      { pid: 302, cwd: fakeCwd, startedAt: new Date(now - 3000).toISOString(), agentType: "claude" as const },
    ]

    const results = await matchAgentsToSessions(agents, 5000)

    expect(results).toHaveLength(2)
    expect(results.every(r => r.confidence === "high")).toBe(true)

    const pids = results.map(r => r.pid).sort((a, b) => a - b)
    expect(pids).toEqual([301, 302])

    const ids = results.map(r => r.sessionId).sort()
    expect(ids).toEqual(["session-1", "session-2"])

    // No file double-claimed.
    const filePaths = results.map(r => r.sessionFilePath)
    expect(new Set(filePaths).size).toBe(2)
  })

  it("second agent does not steal the file already claimed by the first", async () => {
    const now = Date.now()

    // Only one file; only one agent should get it.
    writeSessionFile(dir, "session-only", now)

    const agents = [
      { pid: 401, cwd: fakeCwd, startedAt: new Date(now + 100).toISOString(), agentType: "claude" as const },
      { pid: 402, cwd: fakeCwd, startedAt: new Date(now + 200).toISOString(), agentType: "claude" as const },
    ]

    const results = await matchAgentsToSessions(agents, 5000)

    // Only one result; the file went to the closer agent (pid 401, delta 100 ms < 200 ms).
    expect(results).toHaveLength(1)
    expect(results[0].pid).toBe(401)
    expect(results[0].confidence).toBe("high")
  })

  // ── Phase 2: low-confidence fallback ─────────────────────────────────────────

  it("phase 2 gives a low-confidence match to an unmatched claude agent", async () => {
    const now = Date.now()
    writeSessionFile(dir, "session-fallback", now)

    // No startedAt → phase 1 can't build a candidate; phase 2 picks the file.
    const results = await matchAgentsToSessions(
      [{ pid: 500, cwd: fakeCwd, agentType: "claude" as const }],
      5000,
    )

    expect(results).toHaveLength(1)
    expect(results[0].pid).toBe(500)
    expect(results[0].sessionId).toBe("session-fallback")
    expect(results[0].confidence).toBe("low")
  })

  it("phase 2 fires for an agent with no agentType set", async () => {
    const now = Date.now()
    writeSessionFile(dir, "session-notype", now)

    const results = await matchAgentsToSessions(
      [{ pid: 501, cwd: fakeCwd }], // agentType omitted
      5000,
    )

    expect(results).toHaveLength(1)
    expect(results[0].pid).toBe(501)
    expect(results[0].confidence).toBe("low")
  })

  it("phase 2 does NOT fire for codex agentType", async () => {
    const now = Date.now()
    writeSessionFile(dir, "session-codex", now)

    const results = await matchAgentsToSessions(
      [{ pid: 502, cwd: fakeCwd, agentType: "codex" as const }],
      5000,
    )

    expect(results).toHaveLength(0)
  })

  it("phase 2 does NOT fire for gemini agentType", async () => {
    const now = Date.now()
    writeSessionFile(dir, "session-gemini", now)

    const results = await matchAgentsToSessions(
      [{ pid: 503, cwd: fakeCwd, agentType: "gemini" as const }],
      5000,
    )

    expect(results).toHaveLength(0)
  })

  it("phase 2 claims the unclaimed file when a claude agent is processed after a codex agent", async () => {
    const now = Date.now()
    writeSessionFile(dir, "session-shared", now)

    // codex agent is listed first — should be skipped in phase 2
    // claude agent listed second — should claim the file
    const agents = [
      { pid: 601, cwd: fakeCwd, agentType: "codex" as const },
      { pid: 602, cwd: fakeCwd, agentType: "claude" as const },
    ]

    const results = await matchAgentsToSessions(agents, 5000)

    expect(results).toHaveLength(1)
    expect(results[0].pid).toBe(602)
    expect(results[0].confidence).toBe("low")
  })

  // ── Edge cases ────────────────────────────────────────────────────────────────

  it("returns no results when no session files exist for the cwd", async () => {
    // dir exists but is empty
    const results = await matchAgentsToSessions(
      [{ pid: 700, cwd: fakeCwd, startedAt: new Date().toISOString(), agentType: "claude" as const }],
      5000,
    )

    expect(results).toHaveLength(0)
  })

  it("ignores agents that have no cwd", async () => {
    const now = Date.now()
    writeSessionFile(dir, "session-nocwd", now)

    const results = await matchAgentsToSessions(
      [{ pid: 800, startedAt: new Date(now).toISOString(), agentType: "claude" as const }],
      5000,
    )

    expect(results).toHaveLength(0)
  })
})
