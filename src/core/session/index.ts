import { DbStore } from "../db/index"
import type { Message } from "../adapters/types"

export class SessionManager {
  private db: DbStore

  constructor(dbPath = `${process.env.HOME}/.consilium/consilium.db`) {
    this.db = new DbStore(dbPath)
  }

  close() { this.db.close() }

  create(input: { mode: "council" | "dispatch" | "pipeline" | "debate"; router?: string; name?: string }) {
    return this.db.createSession({ mode: input.mode, router: input.router ?? "claude", name: input.name })
  }

  get(id: string) { return this.db.getSession(id) }

  closeSession(id: string) { this.db.closeSession(id) }

  listActive() { return this.db.listSessions("active") }

  listAll() { return this.db.listSessions() }

  addMessage(sessionId: string, role: "user" | "agent" | "system", agent: string | null, content: string) {
    return this.db.createMessage({ sessionId, role, agent, content })
  }

  getMessages(sessionId: string): Message[] {
    return this.db.getMessages(sessionId).map(m => ({
      role: m.role as "user" | "agent" | "system",
      agent: m.agent,
      content: m.content,
    }))
  }

  createTask(sessionId: string, content: string, assignedTo?: string) {
    return this.db.createTask({ sessionId, content, assignedTo })
  }

  updateTaskStatus(taskId: string, status: "pending" | "running" | "done" | "failed") {
    return this.db.updateTaskStatus(taskId, status)
  }

  getTasks(sessionId: string) {
    return this.db.getTasks(sessionId)
  }

  createReview(taskId: string, reviewer: string, content: string, verdict: "approved" | "changes_requested") {
    return this.db.createReview({ taskId, reviewer, content, verdict })
  }

  upsertParticipant(sessionId: string, agent: string) {
    return this.db.upsertParticipant(sessionId, agent)
  }

  getAgentSession(masterSessionId: string, agentName: string): string | null {
    return this.db.getAgentSession(masterSessionId, agentName)
  }

  setAgentSession(masterSessionId: string, agentName: string, agentSessionId: string): void {
    this.db.setAgentSession(masterSessionId, agentName, agentSessionId)
  }
}
