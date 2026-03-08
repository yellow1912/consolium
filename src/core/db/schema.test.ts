import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { DbStore } from "./index"
import { unlinkSync, existsSync } from "node:fs"

const TEST_DB = "/tmp/consilium-test.db"

describe("DbStore", () => {
  let db: DbStore

  beforeEach(() => { db = new DbStore(TEST_DB) })
  afterEach(() => { db.close(); if (existsSync(TEST_DB)) unlinkSync(TEST_DB) })

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
})
