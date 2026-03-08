import { sqliteTable, text } from "drizzle-orm/sqlite-core"

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  name: text("name"),
  mode: text("mode", { enum: ["council", "dispatch", "pipeline"] }).notNull(),
  status: text("status", { enum: ["active", "closed"] }).notNull().default("active"),
  router: text("router").notNull(),
  createdAt: text("created_at").notNull(),
})

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  role: text("role", { enum: ["user", "agent", "system"] }).notNull(),
  agent: text("agent"),
  content: text("content").notNull(),
  createdAt: text("created_at").notNull(),
})

export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  content: text("content").notNull(),
  assignedTo: text("assigned_to"),
  status: text("status", { enum: ["pending", "running", "done", "failed"] }).notNull().default("pending"),
  createdAt: text("created_at").notNull(),
})

export const reviews = sqliteTable("reviews", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull(),
  reviewer: text("reviewer").notNull(),
  content: text("content").notNull(),
  verdict: text("verdict", { enum: ["approved", "changes_requested"] }).notNull(),
  createdAt: text("created_at").notNull(),
})

export const participants = sqliteTable("participants", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  agent: text("agent").notNull(),
  joinedAt: text("joined_at").notNull(),
  lastSeen: text("last_seen").notNull(),
})
