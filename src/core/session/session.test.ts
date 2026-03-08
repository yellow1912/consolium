import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { SessionManager } from "./index"
import { unlinkSync, existsSync } from "node:fs"
import { randomUUID } from "node:crypto"

function makeTestMgr() {
  const path = `/tmp/consilium-session-test-${randomUUID()}.db`
  return { path, mgr: new SessionManager(path) }
}

function cleanup(path: string) {
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = path + suffix
    if (existsSync(f)) unlinkSync(f)
  }
}

describe("SessionManager", () => {
  let mgr: SessionManager
  let dbPath: string

  beforeEach(() => {
    const t = makeTestMgr()
    mgr = t.mgr
    dbPath = t.path
  })
  afterEach(() => { mgr.close(); cleanup(dbPath) })

  it("creates a session with default router", () => {
    const s = mgr.create({ mode: "council" })
    expect(s.mode).toBe("council")
    expect(s.router).toBe("claude")
    expect(s.status).toBe("active")
  })

  it("creates a session with custom router", () => {
    const s = mgr.create({ mode: "dispatch", router: "gemini" })
    expect(s.router).toBe("gemini")
  })

  it("gets session by id", () => {
    const s = mgr.create({ mode: "dispatch" })
    expect(mgr.get(s.id)?.id).toBe(s.id)
  })

  it("returns null for unknown id", () => {
    expect(mgr.get("nonexistent")).toBeNull()
  })

  it("closes a session", () => {
    const s = mgr.create({ mode: "pipeline" })
    mgr.closeSession(s.id)
    expect(mgr.get(s.id)?.status).toBe("closed")
  })

  it("lists only active sessions", () => {
    mgr.create({ mode: "council" })
    const s2 = mgr.create({ mode: "dispatch" })
    mgr.closeSession(s2.id)
    expect(mgr.listActive()).toHaveLength(1)
  })

  it("lists all sessions", () => {
    mgr.create({ mode: "council" })
    const s2 = mgr.create({ mode: "dispatch" })
    mgr.closeSession(s2.id)
    expect(mgr.listAll()).toHaveLength(2)
  })

  it("adds and retrieves messages", () => {
    const s = mgr.create({ mode: "dispatch" })
    mgr.addMessage(s.id, "user", null, "hello")
    mgr.addMessage(s.id, "agent", "claude", "hi there")
    const msgs = mgr.getMessages(s.id)
    expect(msgs).toHaveLength(2)
    expect(msgs[0].content).toBe("hello")
    expect(msgs[1].agent).toBe("claude")
  })

  it("creates tasks and reviews", () => {
    const s = mgr.create({ mode: "pipeline" })
    const task = mgr.createTask(s.id, "write code", "codex")
    expect(task.assignedTo).toBe("codex")
    const review = mgr.createReview(task.id, "claude", "looks good", "approved")
    expect(review.verdict).toBe("approved")
  })
})

describe("agent sessions", () => {
  it("stores and retrieves agent session id", () => {
    const mgr = new SessionManager("/tmp/test-session-mgr-7a.db")
    const s = mgr.create({ mode: "dispatch", router: "claude" })
    mgr.setAgentSession(s.id, "claude", "uuid-abc")
    expect(mgr.getAgentSession(s.id, "claude")).toBe("uuid-abc")
    mgr.close()
    try { require("node:fs").rmSync("/tmp/test-session-mgr-7a.db") } catch {}
  })
  it("returns null for missing agent session", () => {
    const mgr = new SessionManager("/tmp/test-session-mgr-7b.db")
    const s = mgr.create({ mode: "dispatch", router: "claude" })
    expect(mgr.getAgentSession(s.id, "gemini")).toBeNull()
    mgr.close()
    try { require("node:fs").rmSync("/tmp/test-session-mgr-7b.db") } catch {}
  })
  it("supports debate mode", () => {
    const mgr = new SessionManager("/tmp/test-session-mgr-7c.db")
    const s = mgr.create({ mode: "debate", router: "claude" })
    expect(s.mode).toBe("debate")
    mgr.close()
    try { require("node:fs").rmSync("/tmp/test-session-mgr-7c.db") } catch {}
  })
})
