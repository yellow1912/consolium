# Dynamic Model Selection Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let the router AI pick the best agent+model per task from a live cached model list, with user overrides and auto-refresh.

**Architecture:** Each adapter exposes `getModels()` (hardcoded lists, extendable to live APIs). A `ModelCache` service reads/writes `~/.consilium/models-cache.json`, refreshing on startup and every 24h. The router's dispatch/pipeline prompt includes the live model list so Claude can pick intelligently. Users control overrides via `/model` and `/models` slash commands.

**Tech Stack:** Bun, TypeScript, `bun:test`, JSON file cache at `~/.consilium/models-cache.json`

**Test runner:** `~/.bun/bin/bun test` from `/Users/vunguyen/Projects/nilead/consilium/`

**Key existing files:**
- `src/core/adapters/types.ts` — `ModelInfo`, `QueryOptions`, `AgentAdapter` interface (already has `getModels()`)
- `src/core/adapters/base.ts` — `SubprocessAdapter` (already passes `QueryOptions` to `buildArgs`)
- `src/core/adapters/{claude,codex,gemini}.ts` — all have `getModels()` with hardcoded lists
- `src/core/council/index.ts` — `dispatch`/`pipeline` already include agent+model list in router prompt
- `src/cli/index.ts` — `startCLI`, `handleSlash`, `SlashCtx`
- `src/core/council/council.test.ts` — 4 tests failing because mock adapters lack `getModels()`

---

### Task 1: Fix failing tests — add `getModels()` to mock adapters

**Files:**
- Modify: `src/core/council/council.test.ts`

The mock adapter factory (`mock()` on line 5) doesn't implement `getModels()`, which the `CouncilRunner` now requires in `dispatch` and `pipeline`. Add it to the mock factory.

**Step 1: Run tests to see the 4 failures**

```bash
~/.bun/bin/bun test src/core/council/council.test.ts
```

Expected: 4 failures with `TypeError: a.getModels is not a function`

**Step 2: Update the mock factory in `council.test.ts`**

Change the `mock` function at the top of the file from:
```typescript
const mock = (name: string, response: string): AgentAdapter => ({
  name,
  isAvailable: async () => true,
  query: async () => ({ agent: name, content: response, durationMs: 1 }),
})
```

To:
```typescript
const mock = (name: string, response: string): AgentAdapter => ({
  name,
  isAvailable: async () => true,
  getModels: async () => [],
  query: async () => ({ agent: name, content: response, durationMs: 1 }),
})
```

Also update the `trackingAdapter` factory (around line 25) the same way — add `getModels: async () => []`.

**Step 3: Run tests to verify all pass**

```bash
~/.bun/bin/bun test src/core/council/council.test.ts
```

Expected: all tests pass

**Step 4: Run full test suite**

```bash
~/.bun/bin/bun test
```

Expected: 55 pass, 0 fail

**Step 5: Commit**

```bash
git add src/core/council/council.test.ts
git commit -m "fix: add getModels() to mock adapters in council tests"
```

---

### Task 2: Create `ModelCache` service

**Files:**
- Create: `src/core/models/cache.ts`
- Create: `src/core/models/cache.test.ts`

The cache reads/writes `~/.consilium/models-cache.json`. It stores model lists per agent with a `fetchedAt` timestamp. It exposes: `load()`, `save()`, `isStale(agentName, ttlMs)`, and `get(agentName)`.

**Step 1: Write the failing test**

Create `src/core/models/cache.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { ModelCache } from "./cache"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import os from "node:os"

const testPath = join(os.tmpdir(), `consilium-test-cache-${Date.now()}.json`)

afterEach(async () => {
  await rm(testPath, { force: true })
})

describe("ModelCache", () => {
  it("returns empty array for unknown agent", async () => {
    const cache = new ModelCache(testPath)
    expect(cache.get("claude")).toEqual([])
  })

  it("saves and loads model list", async () => {
    const cache = new ModelCache(testPath)
    cache.set("claude", ["claude-opus-4-6", "claude-sonnet-4-6"])
    await cache.save()

    const cache2 = new ModelCache(testPath)
    await cache2.load()
    expect(cache2.get("claude")).toEqual(["claude-opus-4-6", "claude-sonnet-4-6"])
  })

  it("isStale returns true when entry is older than ttl", async () => {
    const cache = new ModelCache(testPath)
    cache.set("claude", ["claude-sonnet-4-6"])
    // manually set old fetchedAt
    ;(cache as any).entries["claude"].fetchedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()
    expect(cache.isStale("claude", 24 * 60 * 60 * 1000)).toBe(true)
  })

  it("isStale returns false for fresh entry", async () => {
    const cache = new ModelCache(testPath)
    cache.set("claude", ["claude-sonnet-4-6"])
    expect(cache.isStale("claude", 24 * 60 * 60 * 1000)).toBe(false)
  })

  it("isStale returns true for unknown agent", async () => {
    const cache = new ModelCache(testPath)
    expect(cache.isStale("unknown", 24 * 60 * 60 * 1000)).toBe(true)
  })
})
```

**Step 2: Run to confirm it fails**

```bash
~/.bun/bin/bun test src/core/models/cache.test.ts
```

Expected: FAIL — `Cannot find module './cache'`

**Step 3: Implement `src/core/models/cache.ts`**

```typescript
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import os from "node:os"
import { join } from "node:path"

export const DEFAULT_CACHE_PATH = join(os.homedir(), ".consilium", "models-cache.json")

type CacheEntry = {
  models: string[]
  fetchedAt: string
}

type CacheFile = Record<string, CacheEntry>

export class ModelCache {
  private path: string
  private entries: CacheFile = {}

  constructor(path = DEFAULT_CACHE_PATH) {
    this.path = path
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.path, "utf-8")
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        this.entries = parsed
      }
    } catch {
      this.entries = {}
    }
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    await writeFile(this.path, JSON.stringify(this.entries, null, 2), "utf-8")
  }

  get(agentName: string): string[] {
    return this.entries[agentName]?.models ?? []
  }

  set(agentName: string, models: string[]): void {
    this.entries[agentName] = { models, fetchedAt: new Date().toISOString() }
  }

  fetchedAt(agentName: string): Date | null {
    const ts = this.entries[agentName]?.fetchedAt
    return ts ? new Date(ts) : null
  }

  isStale(agentName: string, ttlMs: number): boolean {
    const ts = this.entries[agentName]?.fetchedAt
    if (!ts) return true
    return Date.now() - new Date(ts).getTime() > ttlMs
  }
}
```

**Step 4: Run tests to verify they pass**

```bash
~/.bun/bin/bun test src/core/models/cache.test.ts
```

Expected: 5 pass, 0 fail

**Step 5: Commit**

```bash
git add src/core/models/cache.ts src/core/models/cache.test.ts
git commit -m "feat: ModelCache service for persistent model list storage"
```

---

### Task 3: Wire `ModelCache` into CLI startup with background refresh

**Files:**
- Modify: `src/cli/index.ts`

On startup: load cache from disk, then in background fetch fresh models from all adapters and update cache. Also start a 24h auto-refresh interval.

**Step 1: Read the current `startCLI` function**

Read `src/cli/index.ts` lines 1-50 to understand the startup flow.

**Step 2: Update `startCLI` to load and refresh model cache**

At the top of `startCLI`, after creating `registry` and before creating the readline interface, add:

```typescript
import { ModelCache } from "../core/models/cache"

// inside startCLI, after: const registry = ...
const modelCache = new ModelCache()
await modelCache.load()

const TTL_MS = 24 * 60 * 60 * 1000 // 24h

async function refreshModels(): Promise<void> {
  await Promise.all(registry.all().map(async adapter => {
    try {
      const models = await adapter.getModels()
      modelCache.set(adapter.name, models.map(m => m.id))
    } catch {
      // keep stale cache if fetch fails
    }
  }))
  await modelCache.save()
}

// background refresh if stale
const anyStale = registry.all().some(a => modelCache.isStale(a.name, TTL_MS))
if (anyStale) void refreshModels()

// auto-refresh every 24h
const refreshInterval = setInterval(() => { void refreshModels() }, TTL_MS)
refreshInterval.unref() // don't keep process alive just for this
```

Also update `runner` creation so it uses the live model list from cache rather than `getModels()` if available. Pass `modelCache` into `SlashCtx`.

Add cleanup on readline close:
```typescript
rl.on("close", () => clearInterval(refreshInterval))
```

**Step 3: Run tests to verify nothing is broken**

```bash
~/.bun/bin/bun test
```

Expected: 55 pass, 0 fail (CLI changes don't affect unit tests)

**Step 4: Commit**

```bash
git add src/cli/index.ts
git commit -m "feat: load and auto-refresh model cache at CLI startup"
```

---

### Task 4: Override `CouncilRunner` to use cached model list

**Files:**
- Modify: `src/core/council/index.ts`

Currently `getAgentModelPrompt()` calls `a.getModels()` on each adapter (hardcoded list). Update it to accept an optional `modelCache` so it uses cached model IDs when available, falling back to `getModels()`.

**Step 1: Write the failing test**

Add to `src/core/council/council.test.ts`:

```typescript
it("uses provided model list override in dispatch prompt", async () => {
  let capturedPrompt = ""
  const router = {
    name: "claude",
    isAvailable: async () => true,
    getModels: async () => [],
    query: async (p: string) => { capturedPrompt = p; return { agent: "claude", content: '{"assignTo":"codex","model":"fast-model"}', durationMs: 1 } },
  }
  const runner = new CouncilRunner({
    router,
    adapters: [{ name: "codex", isAvailable: async () => true, getModels: async () => [], query: async () => ({ agent: "codex", content: "ok", durationMs: 1 }) }],
    modelOverrides: { codex: ["fast-model", "slow-model"] },
  })
  await runner.dispatch("do something", [])
  expect(capturedPrompt).toContain("fast-model")
  expect(capturedPrompt).toContain("slow-model")
})
```

**Step 2: Run to verify it fails**

```bash
~/.bun/bin/bun test src/core/council/council.test.ts
```

Expected: FAIL — `CouncilRunner` constructor doesn't accept `modelOverrides`

**Step 3: Update `CouncilRunner` constructor and `getAgentModelPrompt`**

In `src/core/council/index.ts`, update the constructor and `getAgentModelPrompt`:

```typescript
export class CouncilRunner {
  private router: AgentAdapter
  private adapters: AgentAdapter[]
  private modelOverrides: Record<string, string[]>

  constructor(input: { router: AgentAdapter; adapters: AgentAdapter[]; modelOverrides?: Record<string, string[]> }) {
    this.router = input.router
    this.adapters = input.adapters
    this.modelOverrides = input.modelOverrides ?? {}
  }

  private async getAgentModelPrompt(): Promise<string> {
    const lines = await Promise.all(this.adapters.map(async a => {
      const cached = this.modelOverrides[a.name]
      const modelIds = cached && cached.length > 0
        ? cached
        : (await a.getModels()).map(m => m.id)
      return `- ${a.name}: [${modelIds.join(", ")}]`
    }))
    return lines.join("\n")
  }
  // ... rest unchanged
}
```

**Step 4: Run tests**

```bash
~/.bun/bin/bun test
```

Expected: 56 pass, 0 fail

**Step 5: Update `startCLI` to pass `modelOverrides` from cache**

In `src/cli/index.ts`, when creating `CouncilRunner`, pass the cached model lists:

```typescript
const modelOverrides = Object.fromEntries(
  registry.all().map(a => [a.name, modelCache.get(a.name)])
)
const runner = new CouncilRunner({ router, adapters: registry.except(routerName), modelOverrides })
```

**Step 6: Commit**

```bash
git add src/core/council/index.ts src/core/council/council.test.ts src/cli/index.ts
git commit -m "feat: CouncilRunner uses cached model list in router prompt"
```

---

### Task 5: Add `/models` and `/model` slash commands

**Files:**
- Modify: `src/cli/index.ts`
- Modify: `src/cli/slash.test.ts`

**Step 1: Write failing tests for new slash commands**

Add to `src/cli/slash.test.ts`:

```typescript
it("parses /models command", () => {
  expect(parseSlash("/models")).toEqual({ command: "models", args: [] })
  expect(parseSlash("/models refresh")).toEqual({ command: "models", args: ["refresh"] })
})

it("parses /model command", () => {
  expect(parseSlash("/model claude claude-opus-4-6")).toEqual({ command: "model", args: ["claude", "claude-opus-4-6"] })
  expect(parseSlash("/model claude clear")).toEqual({ command: "model", args: ["claude", "clear"] })
})
```

**Step 2: Run to verify tests pass** (parseSlash already handles these — no code change needed)

```bash
~/.bun/bin/bun test src/cli/slash.test.ts
```

Expected: all pass (parser is generic)

**Step 3: Add `modelCache` and `sessionModelOverrides` to `SlashCtx`**

In `src/cli/index.ts`, update the `SlashCtx` type:

```typescript
type SlashCtx = {
  mode: Mode
  routerName: string
  registry: AdapterRegistry
  sessionMgr: SessionManager
  context: Message[]
  modelCache: ModelCache
  sessionModelOverrides: Map<string, string>  // agent → model-id override for this session
  setMode: (m: Mode) => void
  setRouter: (r: string) => void
  rebuildRunner: () => void
}
```

**Step 4: Add `models` and `model` cases to `handleSlash`**

Add to the `switch` in `handleSlash`:

```typescript
case "models": {
  if (slash.args[0] === "refresh") {
    console.log("Refreshing models...")
    await Promise.all(ctx.registry.all().map(async a => {
      try {
        const models = await a.getModels()
        ctx.modelCache.set(a.name, models.map(m => m.id))
        console.log(`  ${a.name}: ${models.map(m => m.id).join(", ")}`)
      } catch {
        console.log(`  ${a.name}: (fetch failed, keeping cache)`)
      }
    }))
    await ctx.modelCache.save()
  } else {
    ctx.registry.all().forEach(a => {
      const models = ctx.modelCache.get(a.name)
      const fetchedAt = ctx.modelCache.fetchedAt(a.name)
      const age = fetchedAt ? `fetched ${Math.round((Date.now() - fetchedAt.getTime()) / 3600000)}h ago` : "no cache"
      const override = ctx.sessionModelOverrides.get(a.name)
      const overrideStr = override ? ` [override: ${override}]` : ""
      console.log(`  ${a.name} (${age})${overrideStr}: ${models.length > 0 ? models.join(", ") : "(none cached)"}`)
    })
  }
  break
}
case "model": {
  const [agentName, modelId] = slash.args
  if (!agentName) {
    console.log("usage: /model <agent> <model-id> | /model <agent> clear")
    break
  }
  if (modelId === "clear") {
    ctx.sessionModelOverrides.delete(agentName)
    console.log(`cleared model override for ${agentName}`)
  } else if (modelId) {
    ctx.sessionModelOverrides.set(agentName, modelId)
    console.log(`${agentName} → ${modelId} (this session)`)
  } else {
    console.log("usage: /model <agent> <model-id> | /model <agent> clear")
  }
  ctx.rebuildRunner()
  break
}
```

Update `/help` output to include the new commands:
```typescript
"/models                          — list cached models per agent",
"/models refresh                  — re-fetch models from all agents",
"/model <agent> <model-id>        — override model for this session",
"/model <agent> clear             — remove model override",
```

**Step 5: Wire `sessionModelOverrides` into `CouncilRunner` creation**

In `startCLI`, create a `sessionModelOverrides` map and a `rebuildRunner` function:

```typescript
const sessionModelOverrides = new Map<string, string>()

function buildModelOverrides(): Record<string, string[]> {
  return Object.fromEntries(
    registry.all().map(a => {
      const sessionOverride = sessionModelOverrides.get(a.name)
      if (sessionOverride) return [a.name, [sessionOverride]]
      return [a.name, modelCache.get(a.name)]
    })
  )
}

let runner = new CouncilRunner({ router, adapters: registry.except(routerName), modelOverrides: buildModelOverrides() })

function rebuildRunner() {
  runner = new CouncilRunner({ router: registry.get(routerName)!, adapters: registry.except(routerName), modelOverrides: buildModelOverrides() })
}
```

Pass `modelCache`, `sessionModelOverrides`, and `rebuildRunner` into `handleSlash` context.

**Step 6: Run full test suite**

```bash
~/.bun/bin/bun test
```

Expected: all pass

**Step 7: Commit**

```bash
git add src/cli/index.ts src/cli/slash.test.ts
git commit -m "feat: /models and /model slash commands for model cache and overrides"
```

---

### Task 6: Add model-not-found fallback in `SubprocessAdapter`

**Files:**
- Modify: `src/core/adapters/base.ts`
- Modify: `src/core/adapters/adapters.test.ts`

If a subprocess exits with non-zero and stderr contains "model", retry the query without the model option (using the CLI's own default).

**Step 1: Write failing test**

Add to `src/core/adapters/adapters.test.ts`:

```typescript
describe("SubprocessAdapter fallback", () => {
  it("retries without model option on model-not-found error", async () => {
    const calls: Array<{ args: string[] }> = []
    class TestAdapter extends SubprocessAdapter {
      readonly name = "test"
      readonly bin = "test-bin"
      getModels = async () => []
      buildArgs(prompt: string, options?: QueryOptions) {
        calls.push({ args: options?.model ? ["--model", options.model, prompt] : [prompt] })
        return options?.model ? ["--model", options.model, prompt] : [prompt]
      }
    }
    const adapter = new TestAdapter()
    // First call (with model) fails with model error, second (no model) succeeds
    let callCount = 0
    ;(adapter as any).spawnAndRead = async (args: string[]) => {
      callCount++
      if (callCount === 1) return { exitCode: 1, stdout: "", stderr: "unknown model: bad-model" }
      return { exitCode: 0, stdout: "ok response", stderr: "" }
    }
    const result = await adapter.query("hello", [], { model: "bad-model" })
    expect(result.content).toBe("ok response")
    expect(callCount).toBe(2)
  })
})
```

**Step 2: Run to verify it fails**

```bash
~/.bun/bin/bun test src/core/adapters/adapters.test.ts
```

**Step 3: Extract spawn logic and add fallback in `base.ts`**

Refactor `SubprocessAdapter.query` to extract a `spawnAndRead` helper and add fallback:

```typescript
protected async spawnAndRead(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([this.bin, ...args], { stdout: "pipe", stderr: "pipe" })
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

async query(prompt: string, context: Message[], options?: QueryOptions): Promise<AgentResponse> {
  const fullPrompt = this.buildContextPrompt(prompt, context)
  const start = Date.now()
  let { exitCode, stdout, stderr } = await this.spawnAndRead(this.buildArgs(fullPrompt, options))

  if (exitCode !== 0 && options?.model && stderr.toLowerCase().includes("model")) {
    // model not found — retry without model override
    console.warn(`[${this.name}] model '${options.model}' rejected, retrying with default`)
    ;({ exitCode, stdout, stderr } = await this.spawnAndRead(this.buildArgs(fullPrompt)))
  }

  if (exitCode !== 0) {
    throw new Error(`${this.name} exited with code ${exitCode}: ${stderr}`)
  }
  return { agent: this.name, content: stdout.trim(), durationMs: Date.now() - start }
}
```

**Step 4: Run full test suite**

```bash
~/.bun/bin/bun test
```

Expected: all pass

**Step 5: Commit**

```bash
git add src/core/adapters/base.ts src/core/adapters/adapters.test.ts
git commit -m "feat: auto-fallback to default model when selected model is rejected"
```

---

### Task 7: Update `getModels()` with current known models

**Files:**
- Modify: `src/core/adapters/claude.ts`
- Modify: `src/core/adapters/codex.ts`
- Modify: `src/core/adapters/gemini.ts`

Update the hardcoded `getModels()` lists to reflect currently known working models (verified during implementation session). Remove stale model IDs from Gemini's list.

**Step 1: Update `claude.ts` `getModels()`**

```typescript
async getModels(): Promise<ModelInfo[]> {
  return [
    { id: "claude-opus-4-6", name: "Claude Opus 4.6", capabilities: ["reasoning"] },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", capabilities: ["coding", "reasoning"], isDefault: true },
    { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", capabilities: ["fast", "general"] },
  ]
}
```

**Step 2: Update `codex.ts` `getModels()`**

```typescript
async getModels(): Promise<ModelInfo[]> {
  return [
    { id: "gpt-5.3-codex", name: "GPT-5.3 Codex", capabilities: ["coding", "reasoning"], isDefault: true },
  ]
}
```

**Step 3: Update `gemini.ts` `getModels()`**

```typescript
async getModels(): Promise<ModelInfo[]> {
  return [
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", capabilities: ["coding", "reasoning"], isDefault: true },
    { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash", capabilities: ["fast", "general"] },
  ]
}
```

**Step 4: Run tests**

```bash
~/.bun/bin/bun test
```

Expected: all pass

**Step 5: Commit**

```bash
git add src/core/adapters/claude.ts src/core/adapters/codex.ts src/core/adapters/gemini.ts
git commit -m "fix: update getModels() with verified current model IDs"
```
