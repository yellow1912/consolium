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
    mgr.close_session(s.id)
    expect(mgr.get(s.id)?.status).toBe("closed")
  })

  it("lists only active sessions", () => {
    mgr.create({ mode: "council" })
    const s2 = mgr.create({ mode: "dispatch" })
    mgr.close_session(s2.id)
    expect(mgr.listActive()).toHaveLength(1)
  })

  it("lists all sessions", () => {
    mgr.create({ mode: "council" })
    const s2 = mgr.create({ mode: "dispatch" })
    mgr.close_session(s2.id)
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
