import { Database } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { eq } from "drizzle-orm"
import { randomUUID } from "node:crypto"
import { sessions, messages, tasks, reviews, participants } from "./schema"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"

type Mode = "council" | "dispatch" | "pipeline"
type Status = "active" | "closed"
type TaskStatus = "pending" | "running" | "done" | "failed"
type Verdict = "approved" | "changes_requested"

export class DbStore {
  private sqlite: Database
  private db: ReturnType<typeof drizzle>

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true })
    this.sqlite = new Database(dbPath)
    this.sqlite.exec("PRAGMA journal_mode=WAL;")
    this.db = drizzle(this.sqlite, { schema: { sessions, messages, tasks, reviews, participants } })
    this.migrate()
  }

  private migrate() {
    this.sqlite.exec(
      "CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, name TEXT, mode TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', router TEXT NOT NULL, created_at TEXT NOT NULL);"
    )
    this.sqlite.exec(
      "CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, agent TEXT, content TEXT NOT NULL, created_at TEXT NOT NULL);"
    )
    this.sqlite.exec(
      "CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, content TEXT NOT NULL, assigned_to TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL);"
    )
    this.sqlite.exec(
      "CREATE TABLE IF NOT EXISTS reviews (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, reviewer TEXT NOT NULL, content TEXT NOT NULL, verdict TEXT NOT NULL, created_at TEXT NOT NULL);"
    )
    this.sqlite.exec(
      "CREATE TABLE IF NOT EXISTS participants (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, agent TEXT NOT NULL, joined_at TEXT NOT NULL, last_seen TEXT NOT NULL);"
    )
  }

  close() {
    // Checkpoint WAL so -wal and -shm files are cleaned up on close
    this.sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE);")
    this.sqlite.close()
  }

  createSession(input: { mode: Mode; router: string; name?: string }) {
    const row = {
      id: randomUUID(),
      name: input.name ?? null,
      mode: input.mode,
      status: "active" as Status,
      router: input.router,
      createdAt: nowIso(),
    }
    this.db.insert(sessions).values(row).run()
    return row
  }

  getSession(id: string) {
    return this.db.select().from(sessions).where(eq(sessions.id, id)).get() ?? null
  }

  listSessions(status?: Status) {
    if (status) return this.db.select().from(sessions).where(eq(sessions.status, status)).all()
    return this.db.select().from(sessions).all()
  }

  closeSession(id: string) {
    this.db.update(sessions).set({ status: "closed" }).where(eq(sessions.id, id)).run()
  }

  createMessage(input: {
    sessionId: string
    role: "user" | "agent" | "system"
    agent: string | null
    content: string
  }) {
    const row = {
      id: randomUUID(),
      sessionId: input.sessionId,
      role: input.role,
      agent: input.agent,
      content: input.content,
      createdAt: nowIso(),
    }
    this.db.insert(messages).values(row).run()
    return row
  }

  getMessages(sessionId: string) {
    return this.db.select().from(messages).where(eq(messages.sessionId, sessionId)).all()
  }

  createTask(input: { sessionId: string; content: string; assignedTo?: string }) {
    const row = {
      id: randomUUID(),
      sessionId: input.sessionId,
      content: input.content,
      assignedTo: input.assignedTo ?? null,
      status: "pending" as TaskStatus,
      createdAt: nowIso(),
    }
    this.db.insert(tasks).values(row).run()
    return row
  }

  updateTaskStatus(id: string, status: TaskStatus) {
    this.db.update(tasks).set({ status }).where(eq(tasks.id, id)).run()
  }

  createReview(input: { taskId: string; reviewer: string; content: string; verdict: Verdict }) {
    const row = {
      id: randomUUID(),
      taskId: input.taskId,
      reviewer: input.reviewer,
      content: input.content,
      verdict: input.verdict,
      createdAt: nowIso(),
    }
    this.db.insert(reviews).values(row).run()
    return row
  }

  getReviews(taskId: string) {
    return this.db.select().from(reviews).where(eq(reviews.taskId, taskId)).all()
  }

  upsertParticipant(sessionId: string, agent: string) {
    const existing = this.db
      .select()
      .from(participants)
      .where(eq(participants.sessionId, sessionId))
      .all()
      .find((p) => p.agent === agent)
    const now = nowIso()
    if (existing) {
      this.db.update(participants).set({ lastSeen: now }).where(eq(participants.id, existing.id)).run()
    } else {
      this.db
        .insert(participants)
        .values({ id: randomUUID(), sessionId, agent, joinedAt: now, lastSeen: now })
        .run()
    }
  }
}

function nowIso() {
  return new Date().toISOString()
}
