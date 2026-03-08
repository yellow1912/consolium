# Consilium Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build Consilium — a TypeScript/Bun AI agent orchestration CLI + MCP server that maximizes value from paid AI subscriptions via council, dispatch, and pipeline modes.

**Architecture:** Bun runtime with SQLite (via Drizzle ORM) for state, a pluggable adapter interface for agents (Claude SDK, Codex SDK, Gemini subprocess), a configurable router agent, and three execution modes sharing the same DB schema. Exposes both an interactive CLI and an MCP server.

**Tech Stack:** Bun, TypeScript, Drizzle ORM + bun:sqlite, `@modelcontextprotocol/sdk`, `@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`, `zod`

**Reference repos:**
- `/Users/vunguyen/Projects/nilead/brainstorming/orch/` — Python prototype (adapters, router, chat loop, session)
- `/tmp/agents-council/src/` — MCP server structure, summon pattern, state management

---

## Task 1: Project Scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/index.ts`

**Step 1: Init Bun project**

```bash
cd /Users/vunguyen/Projects/nilead/consilium
bun init -y
```

**Step 2: Install dependencies**

```bash
bun add drizzle-orm @modelcontextprotocol/sdk @anthropic-ai/claude-agent-sdk @openai/codex-sdk zod
bun add -d drizzle-kit @types/bun typescript
```

**Step 3: Replace `package.json` with:**

```json
{
  "name": "consilium",
  "version": "0.1.0",
  "type": "module",
  "bin": { "consilium": "./src/index.ts" },
  "scripts": {
    "start": "bun src/index.ts",
    "test": "bun test"
  },
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "latest",
    "@modelcontextprotocol/sdk": "latest",
    "@openai/codex-sdk": "latest",
    "drizzle-orm": "latest",
    "zod": "latest"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "drizzle-kit": "latest",
    "typescript": "latest"
  }
}
```

**Step 4: Create `tsconfig.json`:**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "types": ["bun-types"]
  },
  "include": ["src/**/*"]
}
```

**Step 5: Create `src/index.ts` stub:**

```typescript
#!/usr/bin/env bun
console.log("consilium v0.1.0")
```

**Step 6: Verify it runs**

```bash
bun src/index.ts
```
Expected: `consilium v0.1.0`

**Step 7: Init git and commit**

```bash
git init
echo "node_modules/\ndist/\n.drizzle/" > .gitignore
git add .
git commit -m "feat: init consilium project with Bun + TypeScript"
```

---

## Task 2: Database Schema + DbStore

**Files:**
- Create: `src/core/db/schema.ts`
- Create: `src/core/db/index.ts`
- Create: `src/core/db/schema.test.ts`

**Step 1: Write the failing test**

```typescript
// src/core/db/schema.test.ts
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
```

**Step 2: Run to verify it fails**

```bash
bun test src/core/db/schema.test.ts
```
Expected: FAIL — `DbStore` not found

**Step 3: Create `src/core/db/schema.ts`:**

```typescript
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
```

**Step 4: Create `src/core/db/index.ts`:**

```typescript
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
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, name TEXT, mode TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active', router TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL,
        agent TEXT, content TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, content TEXT NOT NULL,
        assigned_to TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reviews (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, reviewer TEXT NOT NULL,
        content TEXT NOT NULL, verdict TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS participants (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, agent TEXT NOT NULL,
        joined_at TEXT NOT NULL, last_seen TEXT NOT NULL
      );
    `)
  }

  close() { this.sqlite.close() }

  createSession(input: { mode: Mode; router: string; name?: string }) {
    const row = { id: randomUUID(), name: input.name ?? null, mode: input.mode, status: "active" as Status, router: input.router, createdAt: nowIso() }
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

  createMessage(input: { sessionId: string; role: "user" | "agent" | "system"; agent: string | null; content: string }) {
    const row = { id: randomUUID(), sessionId: input.sessionId, role: input.role, agent: input.agent, content: input.content, createdAt: nowIso() }
    this.db.insert(messages).values(row).run()
    return row
  }

  getMessages(sessionId: string) {
    return this.db.select().from(messages).where(eq(messages.sessionId, sessionId)).all()
  }

  createTask(input: { sessionId: string; content: string; assignedTo?: string }) {
    const row = { id: randomUUID(), sessionId: input.sessionId, content: input.content, assignedTo: input.assignedTo ?? null, status: "pending" as TaskStatus, createdAt: nowIso() }
    this.db.insert(tasks).values(row).run()
    return row
  }

  updateTaskStatus(id: string, status: TaskStatus) {
    this.db.update(tasks).set({ status }).where(eq(tasks.id, id)).run()
  }

  createReview(input: { taskId: string; reviewer: string; content: string; verdict: Verdict }) {
    const row = { id: randomUUID(), taskId: input.taskId, reviewer: input.reviewer, content: input.content, verdict: input.verdict, createdAt: nowIso() }
    this.db.insert(reviews).values(row).run()
    return row
  }

  getReviews(taskId: string) {
    return this.db.select().from(reviews).where(eq(reviews.taskId, taskId)).all()
  }

  upsertParticipant(sessionId: string, agent: string) {
    const existing = this.db.select().from(participants).where(eq(participants.sessionId, sessionId)).all().find(p => p.agent === agent)
    const now = nowIso()
    if (existing) {
      this.db.update(participants).set({ lastSeen: now }).where(eq(participants.id, existing.id)).run()
    } else {
      this.db.insert(participants).values({ id: randomUUID(), sessionId, agent, joinedAt: now, lastSeen: now }).run()
    }
  }
}

function nowIso() { return new Date().toISOString() }
```

**Step 5: Run tests**

```bash
bun test src/core/db/schema.test.ts
```
Expected: 4 tests PASS

**Step 6: Commit**

```bash
git add src/core/db/
git commit -m "feat: SQLite schema and DbStore with WAL mode"
```

---

## Task 3: Adapter Interface + Base Types

**Files:**
- Create: `src/core/adapters/types.ts`
- Create: `src/core/adapters/base.ts`
- Create: `src/core/adapters/types.test.ts`

**Step 1: Create `src/core/adapters/types.ts`:**

```typescript
export type Message = {
  role: "user" | "agent" | "system"
  agent: string | null
  content: string
}

export type AgentResponse = {
  agent: string
  content: string
  durationMs: number
}

export interface AgentAdapter {
  readonly name: string
  query(prompt: string, context: Message[]): Promise<AgentResponse>
  stream?(prompt: string, context: Message[]): AsyncIterable<string>
  isAvailable(): Promise<boolean>
}
```

**Step 2: Create `src/core/adapters/base.ts`** (subprocess base — uses `Bun.spawnSync`, not `child_process.exec`):

```typescript
import type { AgentAdapter, AgentResponse, Message } from "./types"

export abstract class SubprocessAdapter implements AgentAdapter {
  abstract readonly name: string
  abstract readonly bin: string
  abstract buildArgs(prompt: string): string[]

  async isAvailable(): Promise<boolean> {
    const proc = Bun.spawnSync(["which", this.bin])
    return proc.exitCode === 0
  }

  async query(prompt: string, context: Message[]): Promise<AgentResponse> {
    const fullPrompt = this.buildContextPrompt(prompt, context)
    const start = Date.now()
    const proc = Bun.spawnSync([this.bin, ...this.buildArgs(fullPrompt)], {
      stdout: "pipe",
      stderr: "pipe",
    })
    if (proc.exitCode !== 0) {
      throw new Error(`${this.name} exited with code ${proc.exitCode}: ${new TextDecoder().decode(proc.stderr)}`)
    }
    return {
      agent: this.name,
      content: new TextDecoder().decode(proc.stdout).trim(),
      durationMs: Date.now() - start,
    }
  }

  protected buildContextPrompt(prompt: string, context: Message[]): string {
    if (context.length === 0) return prompt
    const history = context.map(m => `[${m.agent ?? m.role}]: ${m.content}`).join("\n")
    return `${history}\n\n[user]: ${prompt}`
  }
}
```

**Step 3: Write the failing test**

```typescript
// src/core/adapters/types.test.ts
import { describe, it, expect } from "bun:test"
import type { AgentAdapter, Message } from "./types"

describe("AgentAdapter interface", () => {
  it("mock adapter satisfies interface", async () => {
    const adapter: AgentAdapter = {
      name: "mock",
      isAvailable: async () => true,
      query: async (prompt) => ({ agent: "mock", content: `echo: ${prompt}`, durationMs: 1 }),
    }
    const result = await adapter.query("hello", [])
    expect(result.agent).toBe("mock")
    expect(result.content).toBe("echo: hello")
  })

  it("adapter receives context messages", async () => {
    const received: Message[] = []
    const adapter: AgentAdapter = {
      name: "mock",
      isAvailable: async () => true,
      query: async (_prompt, context) => {
        received.push(...context)
        return { agent: "mock", content: "ok", durationMs: 1 }
      },
    }
    await adapter.query("new prompt", [{ role: "user", agent: null, content: "prior message" }])
    expect(received).toHaveLength(1)
    expect(received[0].content).toBe("prior message")
  })
})
```

**Step 4: Run tests**

```bash
bun test src/core/adapters/types.test.ts
```
Expected: 2 tests PASS

**Step 5: Commit**

```bash
git add src/core/adapters/
git commit -m "feat: AgentAdapter interface and SubprocessAdapter base (Bun.spawnSync)"
```

---

## Task 4: Claude Adapter (SDK-based)

**Files:**
- Create: `src/core/adapters/claude.ts`
- Create: `src/core/adapters/claude.test.ts`

**Step 1: Write the failing test**

```typescript
// src/core/adapters/claude.test.ts
import { describe, it, expect } from "bun:test"
import { ClaudeAdapter } from "./claude"

describe("ClaudeAdapter", () => {
  it("has correct name", () => {
    expect(new ClaudeAdapter().name).toBe("claude")
  })

  it("query returns AgentResponse shape", async () => {
    const adapter = new ClaudeAdapter()
    adapter["_query"] = async () => "mocked response"
    const result = await adapter.query("hello", [])
    expect(result.agent).toBe("claude")
    expect(result.content).toBe("mocked response")
    expect(typeof result.durationMs).toBe("number")
  })
})
```

**Step 2: Run to verify it fails**

```bash
bun test src/core/adapters/claude.test.ts
```
Expected: FAIL

**Step 3: Create `src/core/adapters/claude.ts`:**

```typescript
import type { AgentAdapter, AgentResponse, Message } from "./types"

export class ClaudeAdapter implements AgentAdapter {
  readonly name = "claude"
  private model: string

  constructor(model = "claude-sonnet-4-6") {
    this.model = model
  }

  async isAvailable(): Promise<boolean> {
    try { await import("@anthropic-ai/claude-agent-sdk"); return true }
    catch { return false }
  }

  protected async _query(prompt: string): Promise<string> {
    const { query } = await import("@anthropic-ai/claude-agent-sdk")
    const chunks: string[] = []
    for await (const event of query({ prompt, model: this.model, tools: [] })) {
      if (event.type === "assistant" && event.message?.content) {
        for (const block of event.message.content) {
          if (block.type === "text") chunks.push(block.text)
        }
      }
    }
    return chunks.join("")
  }

  async query(prompt: string, context: Message[]): Promise<AgentResponse> {
    const fullPrompt = context.length > 0
      ? context.map(m => `[${m.agent ?? m.role}]: ${m.content}`).join("\n") + `\n\n[user]: ${prompt}`
      : prompt
    const start = Date.now()
    const content = await this._query(fullPrompt)
    return { agent: this.name, content, durationMs: Date.now() - start }
  }
}
```

**Step 4: Run tests**

```bash
bun test src/core/adapters/claude.test.ts
```
Expected: 2 tests PASS

**Step 5: Commit**

```bash
git add src/core/adapters/claude.ts src/core/adapters/claude.test.ts
git commit -m "feat: ClaudeAdapter using claude-agent-sdk"
```

---

## Task 5: Codex + Gemini Adapters

**Files:**
- Create: `src/core/adapters/codex.ts`
- Create: `src/core/adapters/gemini.ts`
- Create: `src/core/adapters/adapters.test.ts`

**Step 1: Create `src/core/adapters/codex.ts`:**

```typescript
import type { AgentAdapter, AgentResponse, Message } from "./types"

export class CodexAdapter implements AgentAdapter {
  readonly name = "codex"
  private model: string

  constructor(model = "gpt-4o") { this.model = model }

  async isAvailable(): Promise<boolean> {
    try { await import("@openai/codex-sdk"); return true }
    catch { return false }
  }

  protected async _query(prompt: string): Promise<string> {
    const { Codex } = await import("@openai/codex-sdk")
    const codex = new Codex()
    const result = await codex.query({ prompt, model: this.model })
    return result.output ?? ""
  }

  async query(prompt: string, context: Message[]): Promise<AgentResponse> {
    const fullPrompt = context.length > 0
      ? context.map(m => `[${m.agent ?? m.role}]: ${m.content}`).join("\n") + `\n\n[user]: ${prompt}`
      : prompt
    const start = Date.now()
    const content = await this._query(fullPrompt)
    return { agent: this.name, content, durationMs: Date.now() - start }
  }
}
```

**Step 2: Create `src/core/adapters/gemini.ts`** (subprocess — uses `Bun.spawnSync` via `SubprocessAdapter`):

```typescript
import { SubprocessAdapter } from "./base"

export class GeminiAdapter extends SubprocessAdapter {
  readonly name = "gemini"
  readonly bin = "gemini"
  private model: string

  constructor(model = "gemini-2.0-flash") { super(); this.model = model }

  buildArgs(prompt: string): string[] {
    return ["-m", this.model, prompt]
  }
}
```

**Step 3: Write tests**

```typescript
// src/core/adapters/adapters.test.ts
import { describe, it, expect } from "bun:test"
import { CodexAdapter } from "./codex"
import { GeminiAdapter } from "./gemini"

describe("CodexAdapter", () => {
  it("has correct name", () => { expect(new CodexAdapter().name).toBe("codex") })

  it("query returns correct shape", async () => {
    const adapter = new CodexAdapter()
    adapter["_query"] = async () => "codex response"
    const result = await adapter.query("test", [])
    expect(result.agent).toBe("codex")
    expect(result.content).toBe("codex response")
  })
})

describe("GeminiAdapter", () => {
  it("has correct name", () => { expect(new GeminiAdapter().name).toBe("gemini") })

  it("builds args correctly", () => {
    const args = new GeminiAdapter().buildArgs("my prompt")
    expect(args).toContain("my prompt")
    expect(args).toContain("-m")
  })
})
```

**Step 4: Run tests**

```bash
bun test src/core/adapters/adapters.test.ts
```
Expected: 4 tests PASS

**Step 5: Commit**

```bash
git add src/core/adapters/codex.ts src/core/adapters/gemini.ts src/core/adapters/adapters.test.ts
git commit -m "feat: CodexAdapter (SDK) and GeminiAdapter (Bun.spawnSync subprocess)"
```

---

## Task 6: Adapter Registry

**Files:**
- Create: `src/core/adapters/registry.ts`
- Create: `src/core/adapters/registry.test.ts`

**Step 1: Write failing test**

```typescript
// src/core/adapters/registry.test.ts
import { describe, it, expect } from "bun:test"
import { AdapterRegistry } from "./registry"

const mock = (name: string) => ({
  name,
  isAvailable: async () => true,
  query: async () => ({ agent: name, content: "", durationMs: 0 }),
})

describe("AdapterRegistry", () => {
  it("registers and retrieves adapters", () => {
    const r = new AdapterRegistry()
    const m = mock("mock")
    r.register(m)
    expect(r.get("mock")).toBe(m)
  })

  it("returns null for unknown adapter", () => {
    expect(new AdapterRegistry().get("unknown")).toBeNull()
  })

  it("lists all adapters", () => {
    const r = new AdapterRegistry()
    r.register(mock("a")); r.register(mock("b"))
    expect(r.all().map(x => x.name)).toEqual(["a", "b"])
  })

  it("excludes specified adapters", () => {
    const r = new AdapterRegistry()
    r.register(mock("a")); r.register(mock("b"))
    expect(r.except("a").map(x => x.name)).toEqual(["b"])
  })
})
```

**Step 2: Run to verify it fails**

```bash
bun test src/core/adapters/registry.test.ts
```

**Step 3: Create `src/core/adapters/registry.ts`:**

```typescript
import type { AgentAdapter } from "./types"

export class AdapterRegistry {
  private adapters = new Map<string, AgentAdapter>()

  register(adapter: AgentAdapter) { this.adapters.set(adapter.name, adapter) }
  get(name: string): AgentAdapter | null { return this.adapters.get(name) ?? null }
  all(): AgentAdapter[] { return [...this.adapters.values()] }
  except(...names: string[]): AgentAdapter[] { return this.all().filter(a => !names.includes(a.name)) }
}

export function buildDefaultRegistry(): AdapterRegistry {
  const registry = new AdapterRegistry()
  const { ClaudeAdapter } = require("./claude")
  const { CodexAdapter } = require("./codex")
  const { GeminiAdapter } = require("./gemini")
  registry.register(new ClaudeAdapter())
  registry.register(new CodexAdapter())
  registry.register(new GeminiAdapter())
  return registry
}
```

**Step 4: Run tests**

```bash
bun test src/core/adapters/registry.test.ts
```
Expected: 4 tests PASS

**Step 5: Commit**

```bash
git add src/core/adapters/registry.ts src/core/adapters/registry.test.ts
git commit -m "feat: AdapterRegistry with exclude support"
```

---

## Task 7: Session Manager

**Files:**
- Create: `src/core/session/index.ts`
- Create: `src/core/session/session.test.ts`

**Step 1: Write failing test**

```typescript
// src/core/session/session.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { SessionManager } from "./index"
import { unlinkSync, existsSync } from "node:fs"

const TEST_DB = "/tmp/consilium-session-test.db"

describe("SessionManager", () => {
  let mgr: SessionManager

  beforeEach(() => { mgr = new SessionManager(TEST_DB) })
  afterEach(() => { mgr.close(); if (existsSync(TEST_DB)) unlinkSync(TEST_DB) })

  it("creates a session with defaults", () => {
    const s = mgr.create({ mode: "council" })
    expect(s.mode).toBe("council")
    expect(s.router).toBe("claude")
    expect(s.status).toBe("active")
  })

  it("gets session by id", () => {
    const s = mgr.create({ mode: "dispatch" })
    expect(mgr.get(s.id)?.id).toBe(s.id)
  })

  it("closes a session", () => {
    const s = mgr.create({ mode: "pipeline" })
    mgr.close_session(s.id)
    expect(mgr.get(s.id)?.status).toBe("closed")
  })

  it("lists active sessions only", () => {
    mgr.create({ mode: "council" })
    const s2 = mgr.create({ mode: "dispatch" })
    mgr.close_session(s2.id)
    expect(mgr.listActive()).toHaveLength(1)
  })
})
```

**Step 2: Run to verify it fails**

```bash
bun test src/core/session/session.test.ts
```

**Step 3: Create `src/core/session/index.ts`:**

```typescript
import { DbStore } from "../db/index"
import type { Message } from "../adapters/types"

export class SessionManager {
  private db: DbStore

  constructor(dbPath = `${process.env.HOME}/.consilium/consilium.db`) {
    this.db = new DbStore(dbPath)
  }

  close() { this.db.close() }

  create(input: { mode: "council" | "dispatch" | "pipeline"; router?: string; name?: string }) {
    return this.db.createSession({ mode: input.mode, router: input.router ?? "claude", name: input.name })
  }

  get(id: string) { return this.db.getSession(id) }
  close_session(id: string) { this.db.closeSession(id) }
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

  createReview(taskId: string, reviewer: string, content: string, verdict: "approved" | "changes_requested") {
    return this.db.createReview({ taskId, reviewer, content, verdict })
  }
}
```

**Step 4: Run tests**

```bash
bun test src/core/session/session.test.ts
```
Expected: 4 tests PASS

**Step 5: Commit**

```bash
git add src/core/session/
git commit -m "feat: SessionManager wrapping DbStore"
```

---

## Task 8: Council Execution Modes

**Files:**
- Create: `src/core/council/index.ts`
- Create: `src/core/council/council.test.ts`

**Step 1: Write failing tests**

```typescript
// src/core/council/council.test.ts
import { describe, it, expect } from "bun:test"
import { CouncilRunner } from "./index"
import type { AgentAdapter } from "../adapters/types"

const mock = (name: string, response: string): AgentAdapter => ({
  name,
  isAvailable: async () => true,
  query: async () => ({ agent: name, content: response, durationMs: 1 }),
})

describe("council mode", () => {
  it("queries all non-router agents and synthesizes", async () => {
    const runner = new CouncilRunner({
      router: mock("claude", "synthesis"),
      adapters: [mock("codex", "codex answer"), mock("gemini", "gemini answer")],
    })
    const result = await runner.council("what is 2+2?", [])
    expect(result.responses).toHaveLength(2)
    expect(result.synthesis).toBe("synthesis")
  })
})

describe("dispatch mode", () => {
  it("router assigns task to one agent", async () => {
    const runner = new CouncilRunner({
      router: mock("claude", JSON.stringify({ assignTo: "codex" })),
      adapters: [mock("codex", "codex did the work"), mock("gemini", "")],
    })
    const result = await runner.dispatch("write a function", [])
    expect(result.agent).toBe("codex")
    expect(result.content).toBe("codex did the work")
  })
})

describe("pipeline mode", () => {
  it("executes task then reviews", async () => {
    const runner = new CouncilRunner({
      router: mock("claude", JSON.stringify({ assignTo: "codex" })),
      adapters: [
        mock("codex", "here is my code"),
        mock("gemini", JSON.stringify({ verdict: "approved", content: "looks good" })),
      ],
    })
    const result = await runner.pipeline("write a function", [])
    expect(result.taskContent).toBe("here is my code")
    expect(result.approved).toBe(true)
  })
})
```

**Step 2: Run to verify it fails**

```bash
bun test src/core/council/council.test.ts
```

**Step 3: Create `src/core/council/index.ts`:**

```typescript
import type { AgentAdapter, AgentResponse, Message } from "../adapters/types"

type CouncilResult = { responses: AgentResponse[]; synthesis: string }
type PipelineResult = { taskContent: string; reviews: { reviewer: string; verdict: string; content: string }[]; approved: boolean }

export class CouncilRunner {
  private router: AgentAdapter
  private adapters: AgentAdapter[]

  constructor(input: { router: AgentAdapter; adapters: AgentAdapter[] }) {
    this.router = input.router
    this.adapters = input.adapters
  }

  async council(prompt: string, context: Message[]): Promise<CouncilResult> {
    const respondents = this.adapters.filter(a => a.name !== this.router.name)
    const responses = await Promise.all(respondents.map(a => a.query(prompt, context)))
    const synthesisPrompt = `You asked: "${prompt}"\n\nAgent responses:\n${responses.map(r => `[${r.agent}]: ${r.content}`).join("\n\n")}\n\nSynthesize the best answer.`
    const synthesis = await this.router.query(synthesisPrompt, [])
    return { responses, synthesis: synthesis.content }
  }

  async dispatch(prompt: string, context: Message[]): Promise<AgentResponse> {
    const names = this.adapters.map(a => a.name).join(", ")
    const routerResp = await this.router.query(
      `Task: "${prompt}"\nAvailable agents: ${names}\nRespond with JSON: { "assignTo": "<agent name>" }`,
      context
    )
    let assignTo: string
    try { assignTo = JSON.parse(routerResp.content).assignTo }
    catch { assignTo = this.adapters[0]?.name ?? this.router.name }
    const agent = this.adapters.find(a => a.name === assignTo) ?? this.adapters[0]
    if (!agent) throw new Error("No agent available for dispatch")
    return agent.query(prompt, context)
  }

  async pipeline(prompt: string, context: Message[], maxRounds = 2): Promise<PipelineResult> {
    const names = this.adapters.map(a => a.name).join(", ")
    const routerResp = await this.router.query(
      `Task: "${prompt}"\nAvailable agents: ${names}\nRespond with JSON: { "assignTo": "<agent name>" }`,
      context
    )
    let assignTo: string
    try { assignTo = JSON.parse(routerResp.content).assignTo }
    catch { assignTo = this.adapters[0]?.name ?? this.router.name }

    const executor = this.adapters.find(a => a.name === assignTo) ?? this.adapters[0]
    if (!executor) throw new Error("No executor agent available")

    const taskResp = await executor.query(prompt, context)
    const reviewers = this.adapters.filter(a => a.name !== executor.name && a.name !== this.router.name)
    const reviewPrompt = `Task: "${prompt}"\nResult:\n${taskResp.content}\nReview with JSON: { "verdict": "approved" | "changes_requested", "content": "<feedback>" }`

    const reviewResps = await Promise.all(reviewers.map(async a => {
      const r = await a.query(reviewPrompt, [])
      try {
        const p = JSON.parse(r.content)
        return { reviewer: a.name, verdict: p.verdict ?? "approved", content: p.content ?? r.content }
      } catch {
        return { reviewer: a.name, verdict: "approved", content: r.content }
      }
    }))

    return { taskContent: taskResp.content, reviews: reviewResps, approved: reviewResps.every(r => r.verdict === "approved") }
  }
}
```

**Step 4: Run tests**

```bash
bun test src/core/council/council.test.ts
```
Expected: 3 tests PASS

**Step 5: Commit**

```bash
git add src/core/council/
git commit -m "feat: CouncilRunner — council, dispatch, and pipeline modes"
```

---

## Task 9: CLI Chat Loop + Slash Commands

**Files:**
- Create: `src/cli/slash.ts`
- Create: `src/cli/slash.test.ts`
- Create: `src/cli/index.ts`

**Step 1: Write failing slash test**

```typescript
// src/cli/slash.test.ts
import { describe, it, expect } from "bun:test"
import { parseSlash } from "./slash"

describe("parseSlash", () => {
  it("parses /mode command", () => {
    expect(parseSlash("/mode council")).toEqual({ command: "mode", args: ["council"] })
  })
  it("parses /router command", () => {
    expect(parseSlash("/router gemini")).toEqual({ command: "router", args: ["gemini"] })
  })
  it("returns null for non-slash input", () => {
    expect(parseSlash("hello world")).toBeNull()
  })
  it("parses commands with no args", () => {
    expect(parseSlash("/help")).toEqual({ command: "help", args: [] })
  })
})
```

**Step 2: Run to verify it fails**

```bash
bun test src/cli/slash.test.ts
```

**Step 3: Create `src/cli/slash.ts`:**

```typescript
export type SlashCommand = { command: string; args: string[] }

export function parseSlash(input: string): SlashCommand | null {
  const trimmed = input.trim()
  if (!trimmed.startsWith("/")) return null
  const [cmd, ...args] = trimmed.slice(1).split(/\s+/)
  return { command: cmd, args }
}
```

**Step 4: Create `src/cli/index.ts`:**

```typescript
import * as readline from "node:readline"
import { SessionManager } from "../core/session/index"
import { CouncilRunner } from "../core/council/index"
import { buildDefaultRegistry } from "../core/adapters/registry"
import { parseSlash } from "./slash"
import type { Message } from "../core/adapters/types"

type Mode = "council" | "dispatch" | "pipeline"

export async function startCLI(options: { mode?: Mode; router?: string; resumeId?: string }) {
  const sessionMgr = new SessionManager()
  const registry = buildDefaultRegistry()

  let mode: Mode = options.mode ?? "dispatch"
  let routerName = options.router ?? "claude"

  let session = options.resumeId
    ? (sessionMgr.get(options.resumeId) ?? sessionMgr.create({ mode, router: routerName }))
    : sessionMgr.create({ mode, router: routerName })

  const context: Message[] = sessionMgr.getMessages(session.id)
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })

  console.log(`\nconsilium — session ${session.id} [mode: ${mode}] [router: ${routerName}]`)
  console.log("Type a message or /help for commands.\n")

  const prompt = () => rl.question("you> ", async (input) => {
    const trimmed = input.trim()
    if (!trimmed) return prompt()

    const slash = parseSlash(trimmed)
    if (slash) {
      handleSlash(slash, { mode, routerName, registry, sessionMgr,
        setMode: (m: Mode) => { mode = m }, setRouter: (r: string) => { routerName = r }, context })
      return prompt()
    }

    sessionMgr.addMessage(session.id, "user", null, trimmed)
    context.push({ role: "user", agent: null, content: trimmed })

    const router = registry.get(routerName)
    if (!router) { console.error(`Router '${routerName}' not found`); return prompt() }

    const runner = new CouncilRunner({ router, adapters: registry.except(routerName) })

    try {
      if (mode === "council") {
        const r = await runner.council(trimmed, context)
        r.responses.forEach(resp => console.log(`\n[${resp.agent}]: ${resp.content}`))
        console.log(`\n[synthesis]: ${r.synthesis}`)
        sessionMgr.addMessage(session.id, "agent", "synthesis", r.synthesis)
        context.push({ role: "agent", agent: "synthesis", content: r.synthesis })
      } else if (mode === "dispatch") {
        const r = await runner.dispatch(trimmed, context)
        console.log(`\n[${r.agent}]: ${r.content}`)
        sessionMgr.addMessage(session.id, "agent", r.agent, r.content)
        context.push({ role: "agent", agent: r.agent, content: r.content })
      } else {
        const r = await runner.pipeline(trimmed, context)
        console.log(`\n[executor]: ${r.taskContent}`)
        r.reviews.forEach(rev => console.log(`\n[${rev.reviewer} review]: ${rev.content} (${rev.verdict})`))
        sessionMgr.addMessage(session.id, "agent", "pipeline", r.taskContent)
        context.push({ role: "agent", agent: "pipeline", content: r.taskContent })
      }
    } catch (err) {
      console.error(`Error: ${err}`)
    }

    prompt()
  })

  prompt()
}

function handleSlash(slash: { command: string; args: string[] }, ctx: any) {
  switch (slash.command) {
    case "mode":
      if (["council", "dispatch", "pipeline"].includes(slash.args[0])) {
        ctx.setMode(slash.args[0]); console.log(`Mode → ${slash.args[0]}`)
      } else console.log("Usage: /mode council|dispatch|pipeline")
      break
    case "router":
      if (slash.args[0]) { ctx.setRouter(slash.args[0]); console.log(`Router → ${slash.args[0]}`) }
      break
    case "agents":
      console.log("Agents:", ctx.registry.all().map((a: any) => a.name).join(", "))
      break
    case "sessions":
      ctx.sessionMgr.listAll().forEach((s: any) => console.log(`  ${s.id} [${s.mode}] ${s.status}`))
      break
    case "history":
      ctx.context.forEach((m: Message) => console.log(`  [${m.agent ?? m.role}]: ${m.content}`))
      break
    case "help":
      console.log([
        "/mode council|dispatch|pipeline  — switch mode",
        "/router <name>                   — switch router",
        "/agents                          — list agents",
        "/sessions                        — list sessions",
        "/history                         — show history",
        "/help                            — show this",
      ].join("\n"))
      break
    default:
      console.log(`Unknown command: /${slash.command}`)
  }
}
```

**Step 5: Run slash tests**

```bash
bun test src/cli/slash.test.ts
```
Expected: 4 tests PASS

**Step 6: Commit**

```bash
git add src/cli/
git commit -m "feat: CLI chat loop with all three modes and slash commands"
```

---

## Task 10: MCP Server

**Files:**
- Create: `src/mcp/server.ts`
- Create: `src/mcp/server.test.ts`

**Step 1: Write failing test**

```typescript
// src/mcp/server.test.ts
import { describe, it, expect } from "bun:test"
import { buildMcpTools } from "./server"

describe("MCP tools", () => {
  it("exposes required tool names", () => {
    const names = buildMcpTools().map(t => t.name)
    expect(names).toContain("start_session")
    expect(names).toContain("send_message")
    expect(names).toContain("get_result")
    expect(names).toContain("list_sessions")
    expect(names).toContain("close_session")
  })
})
```

**Step 2: Run to verify it fails**

```bash
bun test src/mcp/server.test.ts
```

**Step 3: Create `src/mcp/server.ts`:**

```typescript
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { SessionManager } from "../core/session/index"
import { CouncilRunner } from "../core/council/index"
import { buildDefaultRegistry } from "../core/adapters/registry"

export function buildMcpTools() {
  return [
    { name: "start_session", description: "Start a new consilium session", inputSchema: { type: "object", properties: { mode: { type: "string", enum: ["council", "dispatch", "pipeline"] }, router: { type: "string" } } } },
    { name: "send_message", description: "Send a message to a session", inputSchema: { type: "object", properties: { sessionId: { type: "string" }, message: { type: "string" } }, required: ["sessionId", "message"] } },
    { name: "get_result", description: "Get messages from a session", inputSchema: { type: "object", properties: { sessionId: { type: "string" } }, required: ["sessionId"] } },
    { name: "list_sessions", description: "List all sessions", inputSchema: { type: "object", properties: {} } },
    { name: "close_session", description: "Close a session", inputSchema: { type: "object", properties: { sessionId: { type: "string" } }, required: ["sessionId"] } },
  ]
}

export async function startMcpServer() {
  const sessionMgr = new SessionManager()
  const registry = buildDefaultRegistry()
  const server = new Server({ name: "consilium", version: "0.1.0" }, { capabilities: { tools: {} } })

  server.setRequestHandler({ method: "tools/list" } as any, async () => ({ tools: buildMcpTools() }))
  server.setRequestHandler({ method: "tools/call" } as any, async (req: any) => {
    const { name, arguments: args } = req.params
    try {
      if (name === "start_session") {
        const s = sessionMgr.create({ mode: args.mode ?? "dispatch", router: args.router })
        return { content: [{ type: "text", text: JSON.stringify({ sessionId: s.id, mode: s.mode }) }] }
      }
      if (name === "send_message") {
        const session = sessionMgr.get(args.sessionId)
        if (!session) throw new Error(`Session ${args.sessionId} not found`)
        const context = sessionMgr.getMessages(args.sessionId)
        sessionMgr.addMessage(args.sessionId, "user", null, args.message)
        const router = registry.get(session.router)
        if (!router) throw new Error(`Router ${session.router} not found`)
        const runner = new CouncilRunner({ router, adapters: registry.except(session.router) })
        let result: string
        if (session.mode === "council") { result = (await runner.council(args.message, context)).synthesis }
        else if (session.mode === "dispatch") { result = (await runner.dispatch(args.message, context)).content }
        else { result = (await runner.pipeline(args.message, context)).taskContent }
        sessionMgr.addMessage(args.sessionId, "agent", "consilium", result)
        return { content: [{ type: "text", text: result }] }
      }
      if (name === "get_result") {
        return { content: [{ type: "text", text: JSON.stringify(sessionMgr.getMessages(args.sessionId)) }] }
      }
      if (name === "list_sessions") {
        return { content: [{ type: "text", text: JSON.stringify(sessionMgr.listAll()) }] }
      }
      if (name === "close_session") {
        sessionMgr.close_session(args.sessionId)
        return { content: [{ type: "text", text: "closed" }] }
      }
      throw new Error(`Unknown tool: ${name}`)
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err}` }], isError: true }
    }
  })

  await server.connect(new StdioServerTransport())
  console.error("Consilium MCP server running on stdio")
}
```

**Step 4: Run tests**

```bash
bun test src/mcp/server.test.ts
```
Expected: 1 test PASS

**Step 5: Commit**

```bash
git add src/mcp/
git commit -m "feat: MCP server with 5 tools (start, send, get, list, close)"
```

---

## Task 11: Wire Entry Point

**Files:**
- Modify: `src/index.ts`

**Step 1: Replace `src/index.ts`:**

```typescript
#!/usr/bin/env bun
import { parseArgs } from "node:util"

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    mode: { type: "string" },
    router: { type: "string" },
    resume: { type: "string" },
    mcp: { type: "boolean", default: false },
    version: { type: "boolean", short: "v", default: false },
  },
  allowPositionals: true,
})

if (values.version) {
  console.log("consilium v0.1.0")
  process.exit(0)
}

if (values.mcp) {
  const { startMcpServer } = await import("./mcp/server")
  await startMcpServer()
} else {
  const { startCLI } = await import("./cli/index")
  await startCLI({ mode: values.mode as any, router: values.router, resumeId: values.resume })
}
```

**Step 2: Run all tests**

```bash
bun test
```
Expected: all tests PASS

**Step 3: Smoke test CLI entry**

```bash
bun src/index.ts --version
```
Expected: `consilium v0.1.0`

**Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire CLI and MCP entry points"
```

---

## Task 12: README

**Files:**
- Create: `README.md`

**Step 1: Create `README.md`:**

```markdown
# Consilium

AI agent orchestration — maximize the value of paid AI subscriptions by letting agents collaborate.

## Modes

| Mode | Description |
|---|---|
| **council** | All agents answer the same prompt, router synthesizes the best response |
| **dispatch** | Router assigns each task to the most capable agent |
| **pipeline** | One agent executes, others peer-review, router approves |

## Usage

\`\`\`bash
consilium                          # dispatch mode, claude router
consilium --mode council           # force council mode
consilium --mode pipeline          # force pipeline mode
consilium --router gemini          # use gemini as router
consilium --resume <session-id>    # resume previous session
consilium --mcp                    # run as MCP server
\`\`\`

## Slash Commands

| Command | Description |
|---|---|
| `/mode council\|dispatch\|pipeline` | Switch mode mid-session |
| `/router <name>` | Switch router mid-session |
| `/agents` | List active agents |
| `/sessions` | List all sessions |
| `/history` | Show session history |
| `/help` | Show all commands |

## MCP Integration

Add to Claude Code (or any MCP host):
\`\`\`json
{ "consilium": { "command": "bun", "args": ["/path/to/consilium/src/index.ts", "--mcp"] } }
\`\`\`

## References

- [orch](../brainstorming/orch/) — Python prototype this is based on
- [agents-council](https://github.com/MrLesk/agents-council) — MCP + summon patterns
```

**Step 2: Commit**

```bash
git add README.md
git commit -m "docs: README with usage, modes, and MCP integration"
```

---

## Summary

| Task | Builds |
|---|---|
| 1 | Bun project scaffold |
| 2 | SQLite schema + DbStore (WAL mode) |
| 3 | AgentAdapter interface + SubprocessAdapter (Bun.spawnSync) |
| 4 | ClaudeAdapter (claude-agent-sdk) |
| 5 | CodexAdapter (codex-sdk) + GeminiAdapter (subprocess) |
| 6 | AdapterRegistry |
| 7 | SessionManager |
| 8 | CouncilRunner — all three modes |
| 9 | CLI chat loop + slash commands |
| 10 | MCP server — 5 tools |
| 11 | Entry point wiring |
| 12 | README |
