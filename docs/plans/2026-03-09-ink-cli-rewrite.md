# Ink CLI Rewrite Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the readline-based CLI with an Ink (React for CLI) app providing Claude Code-like UX: streaming responses, markdown rendering, persistent status bar, rich input with autocomplete, and interactive session picker.

**Architecture:** Ink React components render the full CLI UI. Core logic (`src/core/`, `src/mcp/`) stays untouched. A new `queryStream()` method on adapters enables real-time streaming. State lives in React hooks. `@inkjs/ui` provides TextInput, Select, Spinner components. `ink-markdown` renders agent responses.

**Tech Stack:** ink, react, @inkjs/ui, ink-markdown

---

### Task 1: Install Dependencies

**Files:**
- Modify: `package.json`

**Step 1: Install Ink and related packages**

Run:
```bash
bun add ink react @inkjs/ui ink-markdown
```

**Step 2: Remove @clack/prompts**

Run:
```bash
bun remove @clack/prompts
```

**Step 3: Verify installation**

Run:
```bash
bun test
```

Expected: All 112 tests pass (core tests don't depend on CLI layer).

**Step 4: Commit**

```bash
git add package.json bun.lock
git commit -m "deps: add ink, react, @inkjs/ui, ink-markdown; remove @clack/prompts"
```

---

### Task 2: Add queryStream() to Adapter Interface and Base

**Files:**
- Modify: `src/core/adapters/types.ts`
- Modify: `src/core/adapters/base.ts`
- Modify: `src/core/adapters/claude.ts`
- Create: `src/core/adapters/streaming.test.ts`

**Step 1: Write the failing test**

Create `src/core/adapters/streaming.test.ts`:

```ts
import { describe, it, expect, mock } from "bun:test"

// Test that queryStream yields chunks from subprocess stdout
describe("SubprocessAdapter.queryStream", () => {
  it("yields chunks from stdout", async () => {
    // We'll test via a real subprocess that echoes text
    const { GeminiAdapter } = await import("./gemini")
    const adapter = new GeminiAdapter()

    // Mock: override spawnForStream to use echo
    const chunks: string[] = []
    const mockProc = Bun.spawn(["echo", "Hello streaming world"], {
      stdout: "pipe",
      stderr: "pipe",
    })

    // Read the stream manually to verify the pattern works
    const reader = mockProc.stdout.getReader()
    const decoder = new TextDecoder()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(decoder.decode(value, { stream: true }))
    }
    await mockProc.exited

    const full = chunks.join("")
    expect(full.trim()).toBe("Hello streaming world")
    expect(chunks.length).toBeGreaterThanOrEqual(1)
  })
})
```

**Step 2: Run test to verify it passes (this validates the streaming pattern)**

Run: `bun test src/core/adapters/streaming.test.ts`
Expected: PASS

**Step 3: Add queryStream to AgentAdapter interface**

In `src/core/adapters/types.ts`, add to `AgentAdapter`:

```ts
export interface AgentAdapter {
  readonly name: string
  isAvailable(): Promise<boolean>
  query(prompt: string, context: Message[], options?: QueryOptions): Promise<AgentResponse>
  queryStream?(prompt: string, context: Message[], options?: QueryOptions): AsyncGenerator<string>
  getModels(): Promise<ModelInfo[]>
}
```

**Step 4: Add default queryStream to SubprocessAdapter**

In `src/core/adapters/base.ts`, add method:

```ts
async *queryStream(prompt: string, context: Message[], options?: QueryOptions): AsyncGenerator<string> {
  const fullPrompt = this.buildContextPrompt(prompt, context)
  const args = this.buildArgs(fullPrompt, options)
  const proc = Bun.spawn([this.bin, ...args], { stdout: "pipe", stderr: "pipe" })
  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    yield decoder.decode(value, { stream: true })
  }
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text()
    throw new Error(`${this.name} exited with code ${exitCode}: ${stderr}`)
  }
}
```

**Step 5: Override queryStream in ClaudeAdapter**

In `src/core/adapters/claude.ts`, add override that deletes `CLAUDECODE` env var (same as existing `spawnAndRead` override):

```ts
override async *queryStream(prompt: string, context: Message[], options?: QueryOptions): AsyncGenerator<string> {
  this._isResume = !!options?.agentSessionId
  this._sessionId = options?.agentSessionId ?? randomUUID()
  const effectivePrompt = this._isResume || context.length === 0
    ? prompt
    : this.buildContextPrompt(prompt, context)
  const args = this.buildArgs(effectivePrompt, options)
  const env = { ...process.env }
  delete env.CLAUDECODE
  const proc = Bun.spawn([this.bin, ...args], { stdout: "pipe", stderr: "pipe", env })
  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    yield decoder.decode(value, { stream: true })
  }
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text()
    throw new Error(`claude exited with code ${exitCode}: ${stderr}`)
  }
}
```

**Step 6: Run all tests**

Run: `bun test`
Expected: All tests pass.

**Step 7: Commit**

```bash
git add src/core/adapters/types.ts src/core/adapters/base.ts src/core/adapters/claude.ts src/core/adapters/streaming.test.ts
git commit -m "feat: add queryStream() for real-time streaming from subprocess adapters"
```

---

### Task 3: Create Root Ink App Component

**Files:**
- Create: `src/cli/app.tsx`
- Create: `src/cli/types.ts`

**Step 1: Create shared CLI types**

Create `src/cli/types.ts`:

```ts
import type { Message } from "../core/adapters/types"

export type Mode = "council" | "dispatch" | "pipeline" | "debate"

export type AppState = {
  mode: Mode
  routerName: string
  sessionId: string
  context: Message[]
  isLoading: boolean
  streamingAgent: string | null
  streamingContent: string
  showSessionPicker: boolean
  error: string | null
}
```

**Step 2: Create the root App component**

Create `src/cli/app.tsx`:

```tsx
import React, { useState, useEffect } from "react"
import { Box, Text, useApp, useInput } from "ink"
import { TextInput, Spinner } from "@inkjs/ui"
import { SessionManager } from "../core/session/index"
import { CouncilRunner } from "../core/council/index"
import { buildDefaultRegistry, buildPersonaRegistry, type AdapterRegistry } from "../core/adapters/registry"
import { parseSlash } from "./slash"
import { classifyIntent } from "./intent"
import { ModelCache } from "../core/models/cache"
import type { Message } from "../core/adapters/types"
import type { Mode } from "./types"
import { StatusBar } from "./components/StatusBar"
import { MessageList } from "./components/MessageList"
import { SessionPicker } from "./components/SessionPicker"

type AppProps = {
  initialMode?: Mode
  initialRouter?: string
  resumeId?: string
  personas?: boolean
}

export function App({ initialMode, initialRouter, resumeId, personas }: AppProps) {
  const { exit } = useApp()
  const sessionMgr = React.useRef(new SessionManager()).current
  const registry = React.useRef(
    personas ? buildPersonaRegistry() : buildDefaultRegistry()
  ).current
  const modelCache = React.useRef(new ModelCache()).current

  // Resolve resumed session
  const [resumed] = useState(() => {
    if (!resumeId) return null
    try {
      const s = sessionMgr.get(resumeId)
      if (!s) {
        console.error(`[error] No session found matching '${resumeId}'.`)
        process.exit(1)
      }
      return s
    } catch (err) {
      console.error(`[error] ${err instanceof Error ? err.message : err}`)
      process.exit(1)
    }
  })

  const [mode, setMode] = useState<Mode>(initialMode ?? (resumed?.mode as Mode) ?? "dispatch")
  const [routerName, setRouterName] = useState(initialRouter ?? resumed?.router ?? "claude")
  const [session, setSession] = useState(() =>
    resumed ?? sessionMgr.create({ mode, router: routerName })
  )
  const [context, setContext] = useState<Message[]>(() =>
    sessionMgr.getMessages(session.id)
  )
  const [input, setInput] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [loadingText, setLoadingText] = useState("")
  const [streamingAgent, setStreamingAgent] = useState<string | null>(null)
  const [streamingContent, setStreamingContent] = useState("")
  const [showPicker, setShowPicker] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [modelOverrides] = useState(() => new Map<string, string>())
  const [debateMaxRounds, setDebateMaxRounds] = useState(5)
  const [inputHistory, setInputHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState(-1)

  // Load model cache on mount
  useEffect(() => { modelCache.load() }, [])

  function buildModelOverridesObj(): Record<string, string[]> {
    return Object.fromEntries(
      registry.all()
        .filter(a => a.name !== routerName)
        .map(a => {
          const override = modelOverrides.get(a.name)
          if (override) return [a.name, [override]]
          return [a.name, modelCache.get(a.name)]
        })
    )
  }

  function buildRunner(): CouncilRunner {
    const router = registry.get(routerName)!
    return new CouncilRunner({
      router,
      adapters: registry.except(routerName),
      modelOverrides: buildModelOverridesObj(),
      masterSessionId: session.id,
      sessionStore: sessionMgr,
    })
  }

  function addMessage(role: "user" | "agent" | "system", agent: string | null, content: string) {
    sessionMgr.addMessage(session.id, role, agent, content)
    setContext(prev => [...prev, { role, agent, content }])
  }

  function switchToSession(id: string) {
    const s = sessionMgr.get(id)
    if (!s) return
    setSession(s)
    setMode(s.mode as Mode)
    setRouterName(s.router)
    setContext(sessionMgr.getMessages(s.id))
    setShowPicker(false)
  }

  async function handleSubmit(value: string) {
    const trimmed = value.trim()
    if (!trimmed) return
    setInput("")
    setInputHistory(prev => [...prev, trimmed])
    setHistoryIndex(-1)
    setError(null)

    // Slash command
    const slash = parseSlash(trimmed)
    if (slash) {
      await handleSlash(slash)
      return
    }

    // Natural language intent classification
    const classifier = registry.get(routerName)
    if (classifier) {
      setIsLoading(true)
      setLoadingText("thinking...")
      const intent = await classifyIntent(trimmed, classifier, registry)
      if (intent.type === "command") {
        setIsLoading(false)
        await handleSlash({ command: intent.command, args: intent.args })
        return
      }
      setIsLoading(false)
    }

    // Regular message — execute mode
    addMessage("user", null, trimmed)

    try {
      const runner = buildRunner()
      await executeMode(runner, trimmed)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setIsLoading(false)
    }
  }

  async function executeMode(runner: CouncilRunner, prompt: string) {
    if (mode === "dispatch") {
      setIsLoading(true)
      setLoadingText("routing...")
      const r = await runner.dispatch(prompt, context, {
        onRouted: (agent) => setLoadingText(`[${agent}] thinking...`),
      })
      setIsLoading(false)
      addMessage("agent", r.agent, r.content)
    } else if (mode === "council") {
      const agents = registry.all().filter(a => a.name !== routerName).map(a => a.name)
      setIsLoading(true)
      setLoadingText(`[${agents.join(", ")}] thinking...`)
      const r = await runner.council(prompt, context)
      setIsLoading(false)
      r.responses.forEach(resp => addMessage("agent", resp.agent, resp.content))
      addMessage("agent", "synthesis", r.synthesis)
    } else if (mode === "pipeline") {
      setIsLoading(true)
      setLoadingText("routing...")
      const r = await runner.pipeline(prompt, context, {
        onRouted: (executor) => setLoadingText(`[${executor}] executing...`),
        onReviewing: (reviewers) => setLoadingText(`[${reviewers.join(", ")}] reviewing...`),
      })
      setIsLoading(false)
      addMessage("agent", "executor", r.taskContent)
      r.reviews.forEach(rev =>
        addMessage("agent", rev.reviewer, `${rev.content} (${rev.verdict})`)
      )
      const verdict = r.approved ? "approved" : "changes requested"
      addMessage("system", "pipeline", verdict)
    } else {
      // debate mode
      const agents = registry.all().filter(a => a.name !== routerName).map(a => a.name)
      setIsLoading(true)
      setLoadingText(`[${agents.join(", ")}] round 1...`)
      const r = await runner.debate(prompt, context, {
        maxRounds: debateMaxRounds,
        onRoundComplete: async (roundNum, roundResponses) => {
          setIsLoading(false)
          roundResponses.forEach(resp => addMessage("agent", resp.agent, resp.content))
          if (roundResponses.length === 0) {
            addMessage("system", null, `Round ${roundNum}: all agents passed.`)
          }
          // For now, auto-continue (debate steering will be added in a follow-up)
          setIsLoading(true)
          setLoadingText(`[${agents.join(", ")}] round ${roundNum + 1}...`)
          return undefined
        },
      })
      setIsLoading(false)
      addMessage("agent", "synthesis", r.synthesis)
      const outcome = r.consensusReached
        ? `Consensus reached after ${r.roundCount} rounds`
        : `Debate concluded after ${r.roundCount} rounds`
      addMessage("system", "debate", outcome)
    }
  }

  async function handleSlash(slash: { command: string; args: string[] }) {
    switch (slash.command) {
      case "mode": {
        const m = slash.args[0] as Mode
        if (["council", "dispatch", "pipeline", "debate"].includes(m)) {
          setMode(m)
          addMessage("system", null, `mode → ${m}`)
        } else {
          setError("usage: /mode council|dispatch|pipeline|debate")
        }
        break
      }
      case "router": {
        const r = slash.args[0]
        if (r) {
          setRouterName(r)
          addMessage("system", null, `router → ${r}`)
        } else setError("usage: /router <agent-name>")
        break
      }
      case "agents":
        addMessage("system", null, `agents: ${registry.all().map(a => a.name).join(", ")}`)
        break
      case "models": {
        if (slash.args[0] === "refresh") {
          setIsLoading(true)
          setLoadingText("Refreshing models...")
          await Promise.all(registry.all().map(async a => {
            if (!await a.isAvailable()) return
            try {
              const models = await a.getModels()
              modelCache.set(a.name, models.map(m => m.id))
            } catch {}
          }))
          await modelCache.save()
          setIsLoading(false)
        }
        const lines = registry.all().map(a => {
          const models = modelCache.get(a.name)
          const override = modelOverrides.get(a.name)
          return `  ${a.name}${override ? ` [override: ${override}]` : ""}: ${models.length > 0 ? models.join(", ") : "(none)"}`
        }).join("\n")
        addMessage("system", null, lines)
        break
      }
      case "model": {
        const [agentName, modelId] = slash.args
        if (!agentName) { setError("usage: /model <agent> <model-id> | /model <agent> clear"); break }
        if (modelId === "clear") {
          modelOverrides.delete(agentName)
          addMessage("system", null, `cleared model override for ${agentName}`)
        } else if (modelId) {
          modelOverrides.set(agentName, modelId)
          addMessage("system", null, `${agentName} → ${modelId} (this session)`)
        }
        break
      }
      case "sessions":
      case "resume":
        if (slash.args[0] && slash.command === "resume") {
          try {
            const s = sessionMgr.get(slash.args[0])
            if (s) switchToSession(s.id)
            else setError(`No session found matching '${slash.args[0]}'.`)
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
          }
        } else {
          setShowPicker(true)
        }
        break
      case "history":
        // Already visible in MessageList
        addMessage("system", null, `${context.length} messages in this session`)
        break
      case "debate": {
        const [sub, val] = slash.args
        if (sub === "rounds") {
          const n = parseInt(val, 10)
          if (Number.isInteger(n) && n > 0) {
            setDebateMaxRounds(n)
            addMessage("system", null, `debate max rounds → ${n}`)
          } else setError("usage: /debate rounds <number>")
        } else if (sub === "autopilot") {
          addMessage("system", null, `debate autopilot → ${val}`)
        } else setError("usage: /debate rounds <n> | /debate autopilot on|off")
        break
      }
      case "help":
        addMessage("system", null, [
          "/mode council|dispatch|pipeline|debate — switch mode",
          "/router <name> — switch router",
          "/agents — list agents",
          "/models [refresh] — list or refresh models",
          "/model <agent> <id|clear> — override model",
          "/sessions — browse and resume sessions",
          "/resume [id] — resume a session",
          "/history — message count",
          "/debate rounds <n> — set max rounds",
          "/debate autopilot on|off — toggle auto-continue",
          "/help — show this help",
          "/exit — exit consilium",
        ].join("\n"))
        break
      case "exit":
      case "quit":
        exit()
        break
      default:
        setError(`unknown command: /${slash.command}`)
    }
  }

  // Build suggestions for TextInput autocomplete
  const suggestions = React.useMemo(() => {
    if (!input.startsWith("/")) return []
    const commands = ["mode", "router", "agents", "models", "model", "sessions", "resume", "history", "help", "debate", "exit", "quit"]
    const partial = input.slice(1)
    return commands.filter(c => c.startsWith(partial)).map(c => `/${c}`)
  }, [input])

  if (showPicker) {
    const allSessions = sessionMgr.listAll()
    return (
      <SessionPicker
        sessions={allSessions}
        onSelect={switchToSession}
        onCancel={() => setShowPicker(false)}
      />
    )
  }

  return (
    <Box flexDirection="column" width="100%">
      <Box flexDirection="column" flexGrow={1}>
        <MessageList messages={context} resumed={!!resumed && context.length > 0} />
        {isLoading && (
          <Box paddingLeft={1}>
            <Spinner label={loadingText} />
          </Box>
        )}
        {error && (
          <Box paddingLeft={1}>
            <Text color="red">[error] {error}</Text>
          </Box>
        )}
      </Box>

      <Box paddingLeft={1}>
        <Text color="green" bold>{"❯ "}</Text>
        <TextInput
          placeholder="Type a message or /help"
          suggestions={suggestions}
          onSubmit={handleSubmit}
        />
      </Box>

      <StatusBar mode={mode} router={routerName} sessionId={session.id} messageCount={context.length} />
    </Box>
  )
}
```

**Step 3: Verify TypeScript compiles**

Run: `bunx tsc --noEmit`

**Step 4: Commit**

```bash
git add src/cli/app.tsx src/cli/types.ts
git commit -m "feat: create root Ink App component with full mode execution"
```

---

### Task 4: Create StatusBar Component

**Files:**
- Create: `src/cli/components/StatusBar.tsx`

**Step 1: Create the component**

```tsx
import React from "react"
import { Box, Text } from "ink"
import type { Mode } from "../types"

type StatusBarProps = {
  mode: Mode
  router: string
  sessionId: string
  messageCount: number
  debateRound?: number
  debateMaxRounds?: number
}

const modeColors: Record<Mode, string> = {
  council: "cyan",
  dispatch: "green",
  pipeline: "yellow",
  debate: "magenta",
}

export function StatusBar({ mode, router, sessionId, messageCount, debateRound, debateMaxRounds }: StatusBarProps) {
  const color = modeColors[mode] ?? "white"
  const shortId = sessionId.slice(0, 8)
  const debateInfo = debateRound ? ` │ round ${debateRound}/${debateMaxRounds}` : ""

  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1} marginTop={1}>
      <Text color={color} bold>{mode}</Text>
      <Text dimColor> │ </Text>
      <Text>router: <Text bold>{router}</Text></Text>
      <Text dimColor> │ </Text>
      <Text>session: <Text dimColor>{shortId}</Text></Text>
      <Text dimColor>{debateInfo}</Text>
      <Text dimColor> │ </Text>
      <Text>{messageCount} messages</Text>
    </Box>
  )
}
```

**Step 2: Commit**

```bash
git add src/cli/components/StatusBar.tsx
git commit -m "feat: add StatusBar component showing mode, router, session"
```

---

### Task 5: Create MessageList and Message Components

**Files:**
- Create: `src/cli/components/MessageList.tsx`
- Create: `src/cli/components/Message.tsx`

**Step 1: Create Message component**

```tsx
import React from "react"
import { Box, Text } from "ink"

type MessageProps = {
  role: "user" | "agent" | "system"
  agent: string | null
  content: string
}

const roleColors: Record<string, string> = {
  user: "green",
  synthesis: "magenta",
  system: "gray",
  pipeline: "yellow",
  debate: "yellow",
  error: "red",
}

export function Message({ role, agent, content }: MessageProps) {
  const sender = role === "user" ? "you" : (agent ?? role)
  const color = roleColors[sender] ?? roleColors[role] ?? "blue"

  return (
    <Box flexDirection="column" paddingLeft={1} marginBottom={1}>
      <Text color={color} bold>{"● "}{sender}</Text>
      <Box paddingLeft={2}>
        <Text wrap="wrap">{content}</Text>
      </Box>
    </Box>
  )
}
```

Note: We start with plain text rendering. Markdown rendering will be added in Task 7 once the basics work.

**Step 2: Create MessageList component**

```tsx
import React from "react"
import { Box, Text } from "ink"
import { Message } from "./Message"
import type { Message as MessageType } from "../../core/adapters/types"

type MessageListProps = {
  messages: MessageType[]
  resumed?: boolean
}

export function MessageList({ messages, resumed }: MessageListProps) {
  if (messages.length === 0) {
    return (
      <Box paddingLeft={1} marginBottom={1}>
        <Text dimColor>Type a message or /help for commands.</Text>
      </Box>
    )
  }

  // When resumed, show indicator for older messages
  const maxVisible = 50
  const visible = messages.slice(-maxVisible)
  const skipped = messages.length - visible.length

  return (
    <Box flexDirection="column">
      {skipped > 0 && (
        <Box paddingLeft={1}>
          <Text dimColor>... {skipped} earlier messages</Text>
        </Box>
      )}
      {visible.map((m, i) => (
        <Message key={i} role={m.role as "user" | "agent" | "system"} agent={m.agent} content={m.content} />
      ))}
    </Box>
  )
}
```

**Step 3: Commit**

```bash
git add src/cli/components/Message.tsx src/cli/components/MessageList.tsx
git commit -m "feat: add Message and MessageList components"
```

---

### Task 6: Create SessionPicker Component

**Files:**
- Create: `src/cli/components/SessionPicker.tsx`

**Step 1: Create the component**

```tsx
import React from "react"
import { Box, Text } from "ink"
import { Select } from "@inkjs/ui"

type Session = {
  id: string
  mode: string
  status: string
  router: string
}

type SessionPickerProps = {
  sessions: Session[]
  onSelect: (id: string) => void
  onCancel: () => void
}

export function SessionPicker({ sessions, onSelect, onCancel }: SessionPickerProps) {
  if (sessions.length === 0) {
    return (
      <Box padding={1}>
        <Text dimColor>(no sessions)</Text>
      </Box>
    )
  }

  const options = sessions.map(s => ({
    label: `${s.id.slice(0, 8)}  [${s.mode}]  router:${s.router}  (${s.status})`,
    value: s.id,
  }))

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>Select a session to resume (Esc to cancel)</Text>
      <Box marginTop={1}>
        <Select
          options={options}
          onChange={(value) => {
            if (value) onSelect(value)
            else onCancel()
          }}
        />
      </Box>
    </Box>
  )
}
```

**Step 2: Commit**

```bash
git add src/cli/components/SessionPicker.tsx
git commit -m "feat: add SessionPicker component with @inkjs/ui Select"
```

---

### Task 7: Add Markdown Rendering to Messages

**Files:**
- Modify: `src/cli/components/Message.tsx`

**Step 1: Add markdown rendering for agent messages**

Update `Message.tsx` to use `ink-markdown` for agent responses:

```tsx
import React from "react"
import { Box, Text } from "ink"

// ink-markdown for rendering agent responses
let Markdown: React.ComponentType<{ children: string }> | null = null
try {
  Markdown = require("ink-markdown").default
} catch {
  // Fallback to plain text if ink-markdown fails to load
}

type MessageProps = {
  role: "user" | "agent" | "system"
  agent: string | null
  content: string
}

const roleColors: Record<string, string> = {
  user: "green",
  synthesis: "magenta",
  system: "gray",
  pipeline: "yellow",
  debate: "yellow",
  error: "red",
}

export function Message({ role, agent, content }: MessageProps) {
  const sender = role === "user" ? "you" : (agent ?? role)
  const color = roleColors[sender] ?? roleColors[role] ?? "blue"
  const useMarkdown = role === "agent" && Markdown

  return (
    <Box flexDirection="column" paddingLeft={1} marginBottom={1}>
      <Text color={color} bold>{"● "}{sender}</Text>
      <Box paddingLeft={2}>
        {useMarkdown ? (
          <Markdown>{content}</Markdown>
        ) : (
          <Text wrap="wrap">{content}</Text>
        )}
      </Box>
    </Box>
  )
}
```

**Step 2: Verify it renders**

Run: Create a quick test script to render a message with markdown and verify it doesn't crash.

**Step 3: Commit**

```bash
git add src/cli/components/Message.tsx
git commit -m "feat: add markdown rendering for agent responses"
```

---

### Task 8: Wire Entry Point to Ink App

**Files:**
- Modify: `src/index.ts`
- Create: `src/cli/render.tsx`

**Step 1: Create render entry point**

Create `src/cli/render.tsx`:

```tsx
import React from "react"
import { render } from "ink"
import { App } from "./app"
import type { Mode } from "./types"

export async function startInkCLI(options: {
  mode?: Mode
  router?: string
  resumeId?: string
  personas?: boolean
}) {
  const { waitUntilExit } = render(
    <App
      initialMode={options.mode}
      initialRouter={options.router}
      resumeId={options.resumeId}
      personas={options.personas}
    />
  )
  await waitUntilExit()
}
```

**Step 2: Update src/index.ts to use Ink CLI**

Replace the CLI import in `src/index.ts`:

```ts
} else {
  const { startInkCLI } = await import("./cli/render")
  await startInkCLI({
    mode: values.mode as "council" | "dispatch" | "pipeline" | "debate" | undefined,
    router: values.router,
    resumeId: values.resume,
    personas: values.personas,
  })
}
```

**Step 3: Run the app manually to verify it starts**

Run: `bun src/index.ts --help` (should still work)
Run: `bun src/index.ts` (should show Ink UI)

**Step 4: Commit**

```bash
git add src/cli/render.tsx src/index.ts
git commit -m "feat: wire entry point to Ink CLI app"
```

---

### Task 9: Clean Up Old Readline CLI Code

**Files:**
- Delete: `src/cli/picker.ts` (replaced by SessionPicker component)
- Keep: `src/cli/slash.ts` (still used by App)
- Keep: `src/cli/intent.ts` (still used by App)
- Keep: `src/cli/completer.ts` (adapt for suggestions)
- Modify: `src/cli/index.ts` → convert to re-export or delete

**Step 1: Remove old picker**

Delete `src/cli/picker.ts`.

**Step 2: Update src/cli/index.ts**

Replace entire file with a re-export:

```ts
export { startInkCLI as startCLI } from "./render"
```

**Step 3: Run tests**

Run: `bun test`
Expected: All tests pass.

**Step 4: Commit**

```bash
git add -A
git commit -m "refactor: remove old readline CLI, re-export Ink CLI"
```

---

### Task 10: Add Streaming Support to Dispatch Mode

**Files:**
- Modify: `src/cli/app.tsx`

**Step 1: Add streaming to dispatch mode**

In `executeMode`, update the dispatch branch to use `queryStream()` when available:

```tsx
if (mode === "dispatch") {
  setIsLoading(true)
  setLoadingText("routing...")
  const r = await runner.dispatch(prompt, context, {
    onRouted: (agent) => {
      setLoadingText(`[${agent}] thinking...`)
      setStreamingAgent(agent)
    },
  })
  setStreamingAgent(null)
  setStreamingContent("")
  setIsLoading(false)
  addMessage("agent", r.agent, r.content)
}
```

For streaming, the `CouncilRunner.dispatch` would need modification to support streaming. Since that's a deeper change, initially keep the current behavior — the streaming adapter is available for future use when we add a streaming-aware dispatch.

**Step 2: Commit**

```bash
git add src/cli/app.tsx
git commit -m "feat: prepare streaming state management in dispatch mode"
```

---

### Task 11: End-to-End Manual Testing

**Step 1: Test basic dispatch**

Run: `bun src/index.ts`
Type: "hello" → verify agent responds, message appears in MessageList

**Step 2: Test mode switching**

Type: `/mode council` → verify status bar updates
Type: "test question" → verify council mode works

**Step 3: Test session management**

Type: `/sessions` → verify SessionPicker appears
Press Esc → verify it cancels back to input

**Step 4: Test resume**

Run: `bun src/index.ts --list` → note a session ID
Run: `bun src/index.ts --resume <first-8-chars>` → verify it resumes with history

**Step 5: Test slash commands**

Type: `/help` → verify help renders as system message
Type: `/agents` → verify agent list appears
Type: `/router gemini` → verify status bar updates

**Step 6: Commit any fixes**

```bash
git add -A
git commit -m "fix: address issues found during e2e testing"
```

---

### Task 12: Final Cleanup and Push

**Step 1: Run all tests**

Run: `bun test`
Expected: All tests pass.

**Step 2: Remove @clack/prompts if not already done**

Run: `bun remove @clack/prompts` (if still in package.json)

**Step 3: Final commit and push**

```bash
git add -A
git commit -m "feat: complete Ink CLI rewrite with Claude Code-like UX"
git push
```
