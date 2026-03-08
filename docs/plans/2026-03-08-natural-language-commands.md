# Natural Language Command Interpretation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow users to express slash commands in plain English (e.g. "switch to debate mode") by routing ambiguous input through a Claude-powered intent classifier before passing it to the current mode.

**Architecture:** A new `classifyIntent(input, classifier, registry)` in `src/cli/intent.ts` sends the user's message to a Claude adapter with a prompt listing all available commands and agent names, and expects JSON back. In `src/cli/index.ts`, every non-slash message passes through `classifyIntent` first — if it's a command, it's dispatched to the existing `handleSlash` logic; if it's a regular message, it proceeds as normal. All failures fall back to treating the input as a regular message.

**Tech Stack:** Bun, TypeScript, existing `AgentAdapter` interface, existing `handleSlash` logic.

---

### Task 1: Create `intent.ts` with `classifyIntent`

**Files:**
- Create: `src/cli/intent.ts`
- Create: `src/cli/intent.test.ts`

**Step 1: Write the failing tests**

Create `src/cli/intent.test.ts`:

```ts
import { describe, it, expect } from "bun:test"
import { classifyIntent } from "./intent"

function makeClassifier(response: string) {
  return {
    name: "mock",
    query: async () => ({ agent: "mock", content: response, durationMs: 0 }),
    isAvailable: async () => true,
    getModels: async () => [],
  }
}

const mockRegistry = {
  all: () => [{ name: "claude" }, { name: "gemini" }],
}

describe("classifyIntent", () => {
  it("returns command for mode switch", async () => {
    const result = await classifyIntent(
      "switch to debate mode",
      makeClassifier('{"type":"command","command":"mode","args":["debate"]}') as any,
      mockRegistry as any,
    )
    expect(result).toEqual({ type: "command", command: "mode", args: ["debate"] })
  })

  it("returns message for regular input", async () => {
    const result = await classifyIntent(
      "what is quantum computing?",
      makeClassifier('{"type":"message"}') as any,
      mockRegistry as any,
    )
    expect(result).toEqual({ type: "message" })
  })

  it("falls back to message on bad JSON", async () => {
    const result = await classifyIntent(
      "whatever",
      makeClassifier("not json") as any,
      mockRegistry as any,
    )
    expect(result).toEqual({ type: "message" })
  })

  it("falls back to message on unexpected shape", async () => {
    const result = await classifyIntent(
      "whatever",
      makeClassifier('{"type":"unknown"}') as any,
      mockRegistry as any,
    )
    expect(result).toEqual({ type: "message" })
  })

  it("handles command with no args", async () => {
    const result = await classifyIntent(
      "show me all agents",
      makeClassifier('{"type":"command","command":"agents","args":[]}') as any,
      mockRegistry as any,
    )
    expect(result).toEqual({ type: "command", command: "agents", args: [] })
  })

  it("handles missing args field gracefully", async () => {
    const result = await classifyIntent(
      "list my sessions",
      makeClassifier('{"type":"command","command":"sessions"}') as any,
      mockRegistry as any,
    )
    expect(result).toEqual({ type: "command", command: "sessions", args: [] })
  })
})
```

**Step 2: Run tests to verify they fail**

```sh
cd /Users/vunguyen/Projects/nilead/consilium && bun test src/cli/intent.test.ts
```
Expected: FAIL — `classifyIntent` not found.

**Step 3: Write the implementation**

Create `src/cli/intent.ts`:

```ts
import type { AgentAdapter } from "../core/adapters/types"
import type { AdapterRegistry } from "../core/adapters/registry"

export type IntentResult =
  | { type: "command"; command: string; args: string[] }
  | { type: "message" }

export async function classifyIntent(
  input: string,
  classifier: AgentAdapter,
  registry: AdapterRegistry,
): Promise<IntentResult> {
  const agentNames = registry.all().map(a => a.name).join(", ")
  const prompt = `You are a command classifier for a multi-agent CLI called consilium.

Available commands:
- mode <council|dispatch|pipeline|debate>
- router <agent-name>  (available agents: ${agentNames})
- agents
- models
- models refresh
- model <agent> <model-id>
- model <agent> clear
- sessions
- history
- help
- debate rounds <n>
- debate autopilot <on|off>
- exit

The user said: "${input}"

If this is a control command for the CLI, respond with JSON only:
{ "type": "command", "command": "<command>", "args": ["<arg1>", "<arg2>"] }

If this is a regular message to the AI agents, respond with JSON only:
{ "type": "message" }

Respond with JSON only. No explanation.`

  try {
    const resp = await classifier.query(prompt, [])
    const parsed = JSON.parse(resp.content)
    if (parsed.type === "command" && typeof parsed.command === "string") {
      return {
        type: "command",
        command: parsed.command,
        args: Array.isArray(parsed.args) ? parsed.args.map(String) : [],
      }
    }
    return { type: "message" }
  } catch {
    return { type: "message" }
  }
}
```

**Step 4: Run tests to verify they pass**

```sh
bun test src/cli/intent.test.ts
```
Expected: 6/6 pass.

**Step 5: Commit**

```sh
git add src/cli/intent.ts src/cli/intent.test.ts
git commit -m "feat: add classifyIntent for natural language command interpretation"
```

---

### Task 2: Wire `classifyIntent` into `src/cli/index.ts`

**Files:**
- Modify: `src/cli/index.ts:1-5` (import)
- Modify: `src/cli/index.ts:102-113` (prompt handler)

**Step 1: Add import**

At the top of `src/cli/index.ts`, add:

```ts
import { classifyIntent } from "./intent"
```

**Step 2: Insert intent classification after the slash check**

The current prompt handler at line 102 looks like:

```ts
const slash = parseSlash(trimmed)
if (slash) {
  await handleSlash(slash, { mode, routerName, registry, sessionMgr, context, modelOverrides, modelCache, rl,
    refreshModels,
    setMode: (m: Mode) => { mode = m },
    setRouter: (r: string) => { routerName = r },
    rebuildRunner: () => { runner = buildRunner() },
    setDebateMaxRounds,
    setDebateAutopilot,
  })
  return rl.closed || prompt()
}
```

Replace it with:

```ts
const slash = parseSlash(trimmed)
if (slash) {
  await handleSlash(slash, { mode, routerName, registry, sessionMgr, context, modelOverrides, modelCache, rl,
    refreshModels,
    setMode: (m: Mode) => { mode = m },
    setRouter: (r: string) => { routerName = r },
    rebuildRunner: () => { runner = buildRunner() },
    setDebateMaxRounds,
    setDebateAutopilot,
  })
  return rl.closed || prompt()
}

// Natural language command interpretation
const classifier = registry.get(routerName)
if (classifier) {
  const intent = await classifyIntent(trimmed, classifier, registry)
  if (intent.type === "command") {
    await handleSlash({ command: intent.command, args: intent.args }, { mode, routerName, registry, sessionMgr, context, modelOverrides, modelCache, rl,
      refreshModels,
      setMode: (m: Mode) => { mode = m },
      setRouter: (r: string) => { routerName = r },
      rebuildRunner: () => { runner = buildRunner() },
      setDebateMaxRounds,
      setDebateAutopilot,
    })
    return rl.closed || prompt()
  }
}
```

**Step 3: Run the full test suite**

```sh
bun test
```
Expected: all tests pass (classifyIntent tests + existing tests).

**Step 4: Commit**

```sh
git add src/cli/index.ts
git commit -m "feat: wire natural language command interpretation into CLI"
```
