# Per-Agent Session Management Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Each agent maintains its own native sub-session within a master consilium session, receiving only a compact delta (user message + peer responses) per turn instead of the full accumulated history.

**Architecture:** A new `agent_sessions` DB table stores per-agent session IDs mapped to master sessions. `CouncilRunner` builds compact delta messages per turn and passes `agentSessionId` in `QueryOptions`. `ClaudeAdapter` uses `--session-id`/`--resume` flags for native multi-turn memory. Gemini/Codex benefit from compact deltas even without native resume. Backward compatible — when no `masterSessionId` is provided, old full-context behavior is preserved.

**Tech Stack:** Bun, bun:sqlite, drizzle-orm, existing `AgentAdapter` interface, Claude CLI `--session-id`/`--resume` flags.

---

### Task 1: Add `agent_sessions` table to DB

**Files:**
- Modify: `src/core/db/schema.ts`
- Modify: `src/core/db/index.ts`
- Test: `src/core/db/schema.test.ts`

**Step 1: Read `src/core/db/schema.test.ts` first, then append these tests**

```ts
describe("agent_sessions", () => {
  let db: DbStore
  beforeEach(() => { db = new DbStore("/tmp/test-agent-sessions.db") })
  afterEach(() => { db.close(); try { require("node:fs").rmSync("/tmp/test-agent-sessions.db") } catch {} })

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
```

**Step 2: Run to verify it fails**
```sh
bun test src/core/db/schema.test.ts
```
Expected: FAIL.

**Step 3: Add to `src/core/db/schema.ts`**

```ts
export const agentSessions = sqliteTable("agent_sessions", {
  id: text("id").primaryKey(),
  masterSessionId: text("master_session_id").notNull(),
  agentName: text("agent_name").notNull(),
  agentSessionId: text("agent_session_id").notNull(),
  createdAt: text("created_at").notNull(),
})
```

Also fix the sessions mode enum to include "debate":
```ts
mode: text("mode", { enum: ["council", "dispatch", "pipeline", "debate"] }).notNull(),
```

**Step 4: Update `src/core/db/index.ts`**

Import `agentSessions`. Add to `drizzle()` schema object. Add to `migrate()`:

```ts
this.sqlite.exec(
  "CREATE TABLE IF NOT EXISTS agent_sessions (id TEXT PRIMARY KEY, master_session_id TEXT NOT NULL, agent_name TEXT NOT NULL, agent_session_id TEXT NOT NULL, created_at TEXT NOT NULL);"
)
this.sqlite.exec(
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_sessions ON agent_sessions(master_session_id, agent_name);"
)
```

Add methods to `DbStore`:

```ts
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
```

**Step 5: Run tests**
```sh
bun test src/core/db/schema.test.ts
```
Expected: all pass.

**Step 6: Commit**
```sh
git add src/core/db/schema.ts src/core/db/index.ts src/core/db/schema.test.ts
git commit -m "feat: add agent_sessions table with get/set CRUD"
```

---

### Task 2: Add `getAgentSession`/`setAgentSession` to `SessionManager`

**Files:**
- Modify: `src/core/session/index.ts`
- Test: `src/core/session/session.test.ts`

**Step 1: Read `src/core/session/session.test.ts`, then append**

```ts
describe("agent sessions", () => {
  it("stores and retrieves agent session id", () => {
    const mgr = new SessionManager("/tmp/test-session-mgr.db")
    const s = mgr.create({ mode: "dispatch", router: "claude" })
    mgr.setAgentSession(s.id, "claude", "uuid-abc")
    expect(mgr.getAgentSession(s.id, "claude")).toBe("uuid-abc")
    mgr.close()
    try { require("node:fs").rmSync("/tmp/test-session-mgr.db") } catch {}
  })
  it("returns null for missing agent session", () => {
    const mgr = new SessionManager("/tmp/test-session-mgr2.db")
    const s = mgr.create({ mode: "dispatch", router: "claude" })
    expect(mgr.getAgentSession(s.id, "gemini")).toBeNull()
    mgr.close()
    try { require("node:fs").rmSync("/tmp/test-session-mgr2.db") } catch {}
  })
})
```

**Step 2: Run to verify fail**
```sh
bun test src/core/session/session.test.ts
```

**Step 3: Add methods to `src/core/session/index.ts`**

Also update `create` to accept "debate" mode:
```ts
create(input: { mode: "council" | "dispatch" | "pipeline" | "debate"; router?: string; name?: string }) {
  return this.db.createSession({ mode: input.mode, router: input.router ?? "claude", name: input.name })
}

getAgentSession(masterSessionId: string, agentName: string): string | null {
  return this.db.getAgentSession(masterSessionId, agentName)
}

setAgentSession(masterSessionId: string, agentName: string, agentSessionId: string): void {
  this.db.setAgentSession(masterSessionId, agentName, agentSessionId)
}
```

**Step 4: Run tests**
```sh
bun test src/core/session/session.test.ts
```

**Step 5: Commit**
```sh
git add src/core/session/index.ts src/core/session/session.test.ts
git commit -m "feat: add getAgentSession/setAgentSession to SessionManager"
```

---

### Task 3: Update `types.ts`

**Files:**
- Modify: `src/core/adapters/types.ts`
- Test: `src/core/adapters/types.test.ts`

**Step 1: Read `src/core/adapters/types.test.ts`, then append**

```ts
describe("extended types", () => {
  it("QueryOptions accepts agentSessionId and systemPrompt", () => {
    const opts: import("./types").QueryOptions = {
      model: "claude-sonnet-4-6",
      agentSessionId: "some-uuid",
      systemPrompt: "You are an assistant.",
    }
    expect(opts.agentSessionId).toBe("some-uuid")
  })
  it("AgentResponse accepts optional sessionId", () => {
    const resp: import("./types").AgentResponse = {
      agent: "claude", content: "hi", durationMs: 10, sessionId: "s-uuid",
    }
    expect(resp.sessionId).toBe("s-uuid")
  })
})
```

**Step 2: Run to verify fail**
```sh
bun test src/core/adapters/types.test.ts
```

**Step 3: Update `src/core/adapters/types.ts`**

```ts
export type QueryOptions = {
  model?: string
  agentSessionId?: string
  systemPrompt?: string
}

export type AgentResponse = {
  agent: string
  content: string
  durationMs: number
  sessionId?: string
}
```

**Step 4: Run full suite** (catches any type errors across all files)
```sh
bun test
```
Expected: all pass.

**Step 5: Commit**
```sh
git add src/core/adapters/types.ts src/core/adapters/types.test.ts
git commit -m "feat: add agentSessionId/systemPrompt to QueryOptions, sessionId to AgentResponse"
```

---

### Task 4: Update `ClaudeAdapter` to use `--session-id`/`--resume`

**Files:**
- Modify: `src/core/adapters/claude.ts`
- Test: `src/core/adapters/claude.test.ts`

**Step 1: Read `src/core/adapters/claude.test.ts`, then append**

```ts
describe("ClaudeAdapter session flags", () => {
  it("uses --resume when agentSessionId is provided", async () => {
    const capturedArgs: string[][] = []
    const origSpawn = Bun.spawn.bind(Bun)
    // @ts-ignore
    Bun.spawn = (args: string[], opts: unknown) => {
      capturedArgs.push(args as string[])
      return origSpawn(["echo", "{}"], opts as any)
    }
    const adapter = new ClaudeAdapter()
    try { await adapter.query("hello", [], { agentSessionId: "my-session-id" }) } catch {}
    // @ts-ignore
    Bun.spawn = origSpawn
    const call = capturedArgs.find(a => a[0] === "claude")
    expect(call).toBeDefined()
    expect(call).toContain("--resume")
    expect(call).toContain("my-session-id")
    expect(call).not.toContain("--session-id")
  })

  it("uses --session-id when no agentSessionId", async () => {
    const capturedArgs: string[][] = []
    const origSpawn = Bun.spawn.bind(Bun)
    // @ts-ignore
    Bun.spawn = (args: string[], opts: unknown) => {
      capturedArgs.push(args as string[])
      return origSpawn(["echo", "hi"], opts as any)
    }
    const adapter = new ClaudeAdapter()
    try { await adapter.query("hello", []) } catch {}
    // @ts-ignore
    Bun.spawn = origSpawn
    const call = capturedArgs.find(a => a[0] === "claude")
    expect(call).toBeDefined()
    expect(call).toContain("--session-id")
    expect(call).not.toContain("--resume")
  })
})
```

**Step 2: Run to verify fail**
```sh
bun test src/core/adapters/claude.test.ts
```

**Step 3: Rewrite `_query` and `query` in `src/core/adapters/claude.ts`**

Add `import { randomUUID } from "node:crypto"` at the top.

```ts
private async _query(prompt: string, options?: QueryOptions): Promise<{ content: string; sessionId: string }> {
  const sessionId = options?.agentSessionId ?? randomUUID()

  const runWith = async (opts?: QueryOptions): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
    const args = ["--print"]
    const model = opts?.model ?? this.model
    if (model) args.push("--model", model)

    if (opts?.agentSessionId) {
      args.push("--resume", opts.agentSessionId)
    } else {
      args.push("--session-id", sessionId)
      const sysPrompt = opts?.systemPrompt ?? this.role
      if (sysPrompt) args.push("--system-prompt", sysPrompt)
    }

    args.push(prompt)
    const env = { ...process.env }
    delete env.CLAUDECODE
    const proc = Bun.spawn(["claude", ...args], { stdout: "pipe", stderr: "pipe", env })
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    return { exitCode, stdout, stderr }
  }

  let { exitCode, stdout, stderr } = await runWith(options)
  if (exitCode !== 0 && options?.model && stderr.toLowerCase().includes("model")) {
    console.warn(`[claude] model '${options.model}' rejected, retrying with default`)
    ;({ exitCode, stdout, stderr } = await runWith({ ...options, model: undefined }))
  }
  if (exitCode !== 0) throw new Error(`claude exited with code ${exitCode}: ${stderr}`)
  return { content: stdout.trim(), sessionId }
}

async query(prompt: string, context: Message[], options?: QueryOptions): Promise<AgentResponse> {
  // When resuming a session, CouncilRunner has already built the delta — pass as-is.
  // Otherwise flatten context for backward compatibility.
  const effectivePrompt = options?.agentSessionId || context.length === 0
    ? prompt
    : context.map(m => `[${m.agent ?? m.role}]: ${m.content}`).join("\n") + `\n\n[user]: ${prompt}`
  const start = Date.now()
  const { content, sessionId } = await this._query(effectivePrompt, options)
  return { agent: this.name, content, durationMs: Date.now() - start, sessionId }
}
```

**Step 4: Run tests**
```sh
bun test src/core/adapters/claude.test.ts
```

**Step 5: Run full suite**
```sh
bun test
```

**Step 6: Commit**
```sh
git add src/core/adapters/claude.ts src/core/adapters/claude.test.ts
git commit -m "feat: ClaudeAdapter uses --session-id/--resume for native multi-turn sessions"
```

---

### Task 5: Update `CouncilRunner` — delta messages + session management

**Files:**
- Modify: `src/core/council/index.ts`
- Test: `src/core/council/council.test.ts`

**Step 1: Read `src/core/council/council.test.ts` first**

**Step 2: Append tests for helpers**

```ts
function mockAdapter(name: string) {
  return {
    name,
    query: async (_p: string, _c: unknown, _o?: unknown) => ({
      agent: name, content: `${name} response`, durationMs: 0, sessionId: `${name}-session`,
    }),
    isAvailable: async () => true,
    getModels: async () => [],
  }
}

describe("CouncilRunner.buildDeltaMessage", () => {
  const runner = new CouncilRunner({ router: mockAdapter("router") as any, adapters: [] })

  it("returns plain prompt when context is empty", () => {
    // @ts-ignore
    expect(runner.buildDeltaMessage("hello", [], "claude")).toBe("hello")
  })

  it("includes peer responses from last turn, excludes self", () => {
    const ctx = [
      { role: "user", agent: null, content: "q1" },
      { role: "agent", agent: "gemini", content: "gemini answer" },
      { role: "agent", agent: "claude", content: "claude answer" },
    ] as any
    // @ts-ignore
    const msg = runner.buildDeltaMessage("q2", ctx, "claude")
    expect(msg).toContain("[gemini]: gemini answer")
    expect(msg).toContain("q2")
    expect(msg).not.toContain("claude answer")
  })

  it("returns plain prompt when no prior user message exists", () => {
    // @ts-ignore
    expect(runner.buildDeltaMessage("hi", [], "claude")).toBe("hi")
  })
})
```

**Step 3: Run to verify fail**
```sh
bun test src/core/council/council.test.ts
```

**Step 4: Update `src/core/council/index.ts`**

Add `AgentSessionStore` type and update constructor:

```ts
type AgentSessionStore = {
  getAgentSession(masterSessionId: string, agentName: string): string | null
  setAgentSession(masterSessionId: string, agentName: string, agentSessionId: string): void
}

export class CouncilRunner {
  private router: AgentAdapter
  private adapters: AgentAdapter[]
  private modelOverrides: Record<string, string[]>
  private masterSessionId?: string
  private sessionStore?: AgentSessionStore

  constructor(input: {
    router: AgentAdapter
    adapters: AgentAdapter[]
    modelOverrides?: Record<string, string[]>
    masterSessionId?: string
    sessionStore?: AgentSessionStore
  }) {
    this.router = input.router
    this.adapters = input.adapters
    this.modelOverrides = input.modelOverrides ?? {}
    this.masterSessionId = input.masterSessionId
    this.sessionStore = input.sessionStore
  }
```

Add private helpers after constructor:

```ts
private getStoredSessionId(agentName: string): string | undefined {
  if (!this.masterSessionId || !this.sessionStore) return undefined
  return this.sessionStore.getAgentSession(this.masterSessionId, agentName) ?? undefined
}

private saveSessionId(agentName: string, sessionId: string): void {
  if (!this.masterSessionId || !this.sessionStore) return
  this.sessionStore.setAgentSession(this.masterSessionId, agentName, sessionId)
}

private buildSystemPrompt(agentName: string, mode: string): string {
  const peers = [...this.adapters, this.router]
    .map(a => a.name)
    .filter(n => n !== agentName)
  return `You are ${agentName} in a multi-agent discussion with ${peers.join(", ")}. Mode: ${mode}. Build on peer responses when provided.`
}

buildDeltaMessage(userMessage: string, context: Message[], excludeAgent?: string): string {
  let lastUserIdx = -1
  for (let i = context.length - 1; i >= 0; i--) {
    if (context[i].role === "user") { lastUserIdx = i; break }
  }
  if (lastUserIdx < 0) return userMessage

  const peerResponses = context
    .slice(lastUserIdx + 1)
    .filter(m => m.role === "agent" && m.agent && m.agent !== excludeAgent)

  if (peerResponses.length === 0) return userMessage

  const peers = peerResponses.map(r => `[${r.agent}]: ${r.content}`).join("\n")
  return `[User]: ${userMessage}\n\n[Peer responses]:\n${peers}\n\nYour response:`
}

private async queryAgent(
  agent: AgentAdapter,
  prompt: string,
  context: Message[],
  mode: string,
  model?: string,
): Promise<AgentResponse> {
  const agentSessionId = this.getStoredSessionId(agent.name)
  const deltaPrompt = this.buildDeltaMessage(prompt, context, agent.name)
  const options: QueryOptions = {
    model,
    agentSessionId,
    systemPrompt: agentSessionId ? undefined : this.buildSystemPrompt(agent.name, mode),
  }
  const resp = agentSessionId !== undefined
    ? await agent.query(deltaPrompt, [], options)
    : await agent.query(prompt, context, options)
  if (resp.sessionId) this.saveSessionId(agent.name, resp.sessionId)
  return resp
}
```

Update each run method to use `queryAgent` (replace all direct `agent.query(...)` and `this.router.query(...)` calls). For synthesis calls, use `this.queryAgent(this.router, synthesisPrompt, [], mode)`.

**Step 5: Run tests**
```sh
bun test src/core/council/council.test.ts
```

**Step 6: Run full suite**
```sh
bun test
```

**Step 7: Commit**
```sh
git add src/core/council/index.ts src/core/council/council.test.ts
git commit -m "feat: CouncilRunner uses per-agent sessions and compact delta messages"
```

---

### Task 6: Wire session store into CLI

**Files:**
- Modify: `src/cli/index.ts` — `buildRunner` function only

**Step 1: Read `src/cli/index.ts` around the `buildRunner` function**

**Step 2: Update `buildRunner` to pass session context**

Find:
```ts
function buildRunner(): CouncilRunner {
  const router = registry.get(routerName)!
  return new CouncilRunner({
    router,
    adapters: registry.except(routerName),
    modelOverrides: buildModelOverrides(),
  })
}
```

Replace with:
```ts
function buildRunner(): CouncilRunner {
  const router = registry.get(routerName)!
  return new CouncilRunner({
    router,
    adapters: registry.except(routerName),
    modelOverrides: buildModelOverrides(),
    masterSessionId: session.id,
    sessionStore: sessionMgr,
  })
}
```

**Step 3: Run full suite**
```sh
bun test
```
Expected: all pass.

**Step 4: Commit**
```sh
git add src/cli/index.ts
git commit -m "feat: wire per-agent session store into CLI runner"
```
