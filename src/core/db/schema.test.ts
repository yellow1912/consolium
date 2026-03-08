import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { DbStore } from "./index"
import { unlinkSync, existsSync } from "node:fs"
import { randomUUID } from "node:crypto"

function makeTestDb() {
  const path = `/tmp/consilium-test-${randomUUID()}.db`
  return { path, db: new DbStore(path) }
}

function cleanup(path: string) {
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = path + suffix
    if (existsSync(f)) unlinkSync(f)
  }
}

describe("DbStore", () => {
  let db: DbStore
  let dbPath: string

  beforeEach(() => {
    const t = makeTestDb()
    db = t.db
    dbPath = t.path
  })
  afterEach(() => { db.close(); cleanup(dbPath) })

  it("creates a session", () => {
    const session = db.createSession({ mode: "council", router: "claude" })
    expect(session.id).toBeDefined()
    expect(session.mode).toBe("council")
    expect(session.status).toBe("active")
    expect(session.router).toBe("claude")
  })

  it("creates a message", () => {
    const session = db.createSession({ mode: "dispatch", router: "claude" })
    const msg = db.createMessage({ sessionId: session.id, role: "user", agent: null, content: "hello" })
    expect(msg.sessionId).toBe(session.id)
    expect(msg.content).toBe("hello")
  })

  it("creates a task and review", () => {
    const session = db.createSession({ mode: "pipeline", router: "claude" })
    const task = db.createTask({ sessionId: session.id, content: "write tests", assignedTo: "codex" })
    expect(task.status).toBe("pending")
    const review = db.createReview({ taskId: task.id, reviewer: "claude", content: "looks good", verdict: "approved" })
    expect(review.verdict).toBe("approved")
  })

  it("lists sessions", () => {
    db.createSession({ mode: "council", router: "claude" })
    db.createSession({ mode: "dispatch", router: "gemini" })
    expect(db.listSessions()).toHaveLength(2)
  })

  it("getSession returns null for unknown id", () => {
    expect(db.getSession("nonexistent")).toBeNull()
  })

  it("getSession returns session by id", () => {
    const s = db.createSession({ mode: "dispatch", router: "claude" })
    expect(db.getSession(s.id)?.id).toBe(s.id)
  })

  it("closeSession updates status", () => {
    const s = db.createSession({ mode: "council", router: "claude" })
    db.closeSession(s.id)
    expect(db.getSession(s.id)?.status).toBe("closed")
  })

  it("listSessions filters by status", () => {
    db.createSession({ mode: "council", router: "claude" })
    const s2 = db.createSession({ mode: "dispatch", router: "claude" })
    db.closeSession(s2.id)
    expect(db.listSessions("active")).toHaveLength(1)
    expect(db.listSessions("closed")).toHaveLength(1)
  })

  it("getMessages returns messages for session", () => {
    const s = db.createSession({ mode: "dispatch", router: "claude" })
    db.createMessage({ sessionId: s.id, role: "user", agent: null, content: "first" })
    db.createMessage({ sessionId: s.id, role: "agent", agent: "claude", content: "second" })
    const msgs = db.getMessages(s.id)
    expect(msgs).toHaveLength(2)
  })

  it("updateTaskStatus changes status", () => {
    const s = db.createSession({ mode: "pipeline", router: "claude" })
    const task = db.createTask({ sessionId: s.id, content: "do work" })
    expect(task.status).toBe("pending")
    db.updateTaskStatus(task.id, "done")
    expect(db.getTask(task.id)?.status).toBe("done")
  })

  it("getReviews returns reviews for task", () => {
    const s = db.createSession({ mode: "pipeline", router: "claude" })
    const task = db.createTask({ sessionId: s.id, content: "do work" })
    db.createReview({ taskId: task.id, reviewer: "gemini", content: "ok", verdict: "approved" })
    expect(db.getReviews(task.id)).toHaveLength(1)
  })

  it("upsertParticipant inserts then updates without duplicate", () => {
    const s = db.createSession({ mode: "council", router: "claude" })
    db.upsertParticipant(s.id, "codex")
    db.upsertParticipant(s.id, "codex")
    expect(db.getParticipants(s.id).filter(p => p.agent === "codex")).toHaveLength(1)
  })
})

describe("agent_sessions", () => {
  let db: DbStore
  beforeEach(() => { db = new DbStore("/tmp/test-agent-sessions.db") })
  afterEach(() => {
    db.close()
    try { require("node:fs").rmSync("/tmp/test-agent-sessions.db") } catch {}
  })

  it("stores and retrieves an agent session", () => {
    db.setAgentSession("master-1", "claude", "claude-uuid")
    expect(db.getAgentSession("master-1", "claude")).toBe("claude-uuid")
  })
  it("returns null for unknown agent session", () => {
    expect(db.getAgentSession("master-1", "gemini")).toBeNull()
  })
  it("upserts on second call", () => {
    db.setAgentSession("master-1", "claude", "old")
    db.setAgentSession("master-1", "claude", "new")
    expect(db.getAgentSession("master-1", "claude")).toBe("new")
  })
  it("isolates by master session id", () => {
    db.setAgentSession("master-1", "claude", "a")
    db.setAgentSession("master-2", "claude", "b")
    expect(db.getAgentSession("master-1", "claude")).toBe("a")
    expect(db.getAgentSession("master-2", "claude")).toBe("b")
  })
})
