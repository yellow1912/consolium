import { Database } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { eq } from "drizzle-orm"
import type { InferSelectModel } from "drizzle-orm"
import { randomUUID } from "node:crypto"
import { sessions, messages, tasks, reviews, participants, agentSessions } from "./schema"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"

type Session = InferSelectModel<typeof sessions>
type Mode = Session["mode"]
type Status = Session["status"]
type Task = InferSelectModel<typeof tasks>
type TaskStatus = Task["status"]
type Review = InferSelectModel<typeof reviews>
type Verdict = Review["verdict"]

export class DbStore {
  private sqlite: Database
  private db: ReturnType<typeof drizzle>

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true })
    this.sqlite = new Database(dbPath)
    this.sqlite.exec("PRAGMA journal_mode=WAL;")
    this.db = drizzle(this.sqlite, { schema: { sessions, messages, tasks, reviews, participants, agentSessions } })
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
    this.sqlite.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_participants_session_agent ON participants(session_id, agent);"
    )
    this.sqlite.exec(
      "CREATE TABLE IF NOT EXISTS agent_sessions (id TEXT PRIMARY KEY, master_session_id TEXT NOT NULL, agent_name TEXT NOT NULL, agent_session_id TEXT NOT NULL, created_at TEXT NOT NULL);"
    )
    this.sqlite.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_sessions ON agent_sessions(master_session_id, agent_name);"
    )
  }

  getAgentSession(masterSessionId: string, agentName: string): string | null {
    const row = this.db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.masterSessionId, masterSessionId))
      .all()
      .find(r => r.agentName === agentName)
    return row?.agentSessionId ?? null
  }

  setAgentSession(masterSessionId: string, agentName: string, agentSessionId: string): void {
    this.db
      .insert(agentSessions)
      .values({ id: randomUUID(), masterSessionId, agentName, agentSessionId, createdAt: nowIso() })
      .onConflictDoUpdate({
        target: [agentSessions.masterSessionId, agentSessions.agentName],
        set: { agentSessionId },
      })
      .run()
  }

  close() {
    try { this.sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE);") } catch {}
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
    // Try exact match first
    const exact = this.db.select().from(sessions).where(eq(sessions.id, id)).get()
    if (exact) return exact
    // Fall back to prefix match
    const all = this.db.select().from(sessions).all()
    const matches = all.filter(s => s.id.startsWith(id))
    if (matches.length === 1) return matches[0]
    if (matches.length > 1) throw new Error(`Ambiguous session ID prefix '${id}' — matches ${matches.length} sessions. Use a longer prefix.`)
    return null
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
    const now = nowIso()
    this.db.insert(participants)
      .values({ id: randomUUID(), sessionId, agent, joinedAt: now, lastSeen: now })
      .onConflictDoUpdate({ target: [participants.sessionId, participants.agent], set: { lastSeen: now } })
      .run()
  }

  getTask(id: string) {
    return this.db.select().from(tasks).where(eq(tasks.id, id)).get() ?? null
  }

  getTasks(sessionId: string) {
    return this.db.select().from(tasks).where(eq(tasks.sessionId, sessionId)).all()
  }

  getParticipants(sessionId: string) {
    return this.db.select().from(participants).where(eq(participants.sessionId, sessionId)).all()
  }
}

function nowIso() {
  return new Date().toISOString()
}
