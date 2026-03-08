# Tab Completion Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add readline tab completion for all slash commands and their arguments in the consilium CLI.

**Architecture:** A `buildCompleter(registry, modelCache)` factory in `src/cli/completer.ts` returns a readline-compatible `completer(line)` function. It inspects the current input line and returns matching completions for commands and their arguments. The completer is passed to `readline.createInterface` in `src/cli/index.ts`.

**Tech Stack:** Bun, Node `readline` built-in completer API, existing `AdapterRegistry` and `ModelCache` types.

---

### Task 1: Create `completer.ts` with command-name completion

**Files:**
- Create: `src/cli/completer.ts`
- Create: `src/cli/completer.test.ts`

**Step 1: Write the failing tests**

```ts
// src/cli/completer.test.ts
import { describe, it, expect } from "bun:test"
import { buildCompleter } from "./completer"

const mockRegistry = {
  all: () => [{ name: "claude" }, { name: "gemini" }, { name: "codex" }],
}

const mockModelCache = {
  get: (name: string) => {
    if (name === "claude") return ["claude-opus-4-6", "claude-sonnet-4-6"]
    if (name === "gemini") return ["gemini-2.0-flash"]
    return []
  },
}

const completer = buildCompleter(mockRegistry as any, mockModelCache as any)

describe("buildCompleter — command names", () => {
  it("returns all commands for empty input", () => {
    const [hits] = completer("")
    expect(hits).toContain("/mode")
    expect(hits).toContain("/router")
    expect(hits).toContain("/help")
  })

  it("returns all commands for bare /", () => {
    const [hits] = completer("/")
    expect(hits).toContain("/mode")
    expect(hits).toContain("/debate")
  })

  it("completes partial command", () => {
    const [hits] = completer("/mo")
    expect(hits).toEqual(["/mode "])
  })

  it("completes /de to /debate", () => {
    const [hits] = completer("/de")
    expect(hits).toEqual(["/debate "])
  })

  it("returns empty for unknown prefix", () => {
    const [hits] = completer("/zzz")
    expect(hits).toEqual([])
  })
})
```

**Step 2: Run tests to verify they fail**

```sh
bun test src/cli/completer.test.ts
```
Expected: FAIL — `buildCompleter` not found.

**Step 3: Write minimal implementation for command-name completion**

```ts
// src/cli/completer.ts
import type { AdapterRegistry } from "../core/adapters/registry"
import type { ModelCache } from "../core/models/cache"

const COMMANDS = [
  "mode", "router", "agents", "models", "model",
  "sessions", "history", "help", "debate",
]

export function buildCompleter(registry: AdapterRegistry, modelCache: ModelCache) {
  return function completer(line: string): [string[], string] {
    const trimmed = line.trimStart()

    // Not a slash command — no completions
    if (trimmed && !trimmed.startsWith("/")) return [[], line]

    const withoutSlash = trimmed.slice(1)
    const parts = withoutSlash.split(" ")
    const cmd = parts[0]
    const argStr = parts.slice(1).join(" ")
    const hasSpace = withoutSlash.includes(" ")

    // No command typed yet — list all
    if (!cmd) {
      return [COMMANDS.map(c => `/${c} `), line]
    }

    // Still typing the command name
    if (!hasSpace) {
      const hits = COMMANDS.filter(c => c.startsWith(cmd)).map(c => `/${c} `)
      return [hits, line]
    }

    // Command is fully typed — complete arguments
    const args = withoutSlash.slice(cmd.length + 1)
    const completions = getArgCompletions(cmd, args, registry, modelCache)
    const hits = completions
      .filter(c => c.startsWith(args))
      .map(c => `/${cmd} ${c}`)
    return [hits, line]
  }
}

function getArgCompletions(
  cmd: string,
  args: string,
  registry: AdapterRegistry,
  modelCache: ModelCache,
): string[] {
  const agentNames = registry.all().map(a => a.name)
  const parts = args.split(" ")

  switch (cmd) {
    case "mode":
      return ["council", "dispatch", "pipeline", "debate"]
    case "router":
      return agentNames
    case "models":
      return ["refresh"]
    case "model": {
      if (parts.length <= 1) return agentNames
      const agent = parts[0]
      const models = modelCache.get(agent)
      return [...models, "clear"]
    }
    case "debate": {
      if (parts.length <= 1) return ["rounds", "autopilot"]
      if (parts[0] === "autopilot") return ["on", "off"]
      return []
    }
    default:
      return []
  }
}
```

**Step 4: Run tests to verify they pass**

```sh
bun test src/cli/completer.test.ts
```
Expected: PASS — all command-name tests green.

**Step 5: Commit**

```sh
git add src/cli/completer.ts src/cli/completer.test.ts
git commit -m "feat: add buildCompleter with command-name tab completion"
```

---

### Task 2: Add argument completion tests

**Files:**
- Modify: `src/cli/completer.test.ts`

**Step 1: Add argument completion tests**

Append to `src/cli/completer.test.ts`:

```ts
describe("buildCompleter — argument completion", () => {
  it("completes /mode args", () => {
    const [hits] = completer("/mode ")
    expect(hits).toContain("/mode council")
    expect(hits).toContain("/mode dispatch")
    expect(hits).toContain("/mode pipeline")
    expect(hits).toContain("/mode debate")
  })

  it("completes partial /mode arg", () => {
    const [hits] = completer("/mode co")
    expect(hits).toEqual(["/mode council"])
  })

  it("completes /router with agent names", () => {
    const [hits] = completer("/router ")
    expect(hits).toContain("/router claude")
    expect(hits).toContain("/router gemini")
  })

  it("completes /models with refresh", () => {
    const [hits] = completer("/models ")
    expect(hits).toContain("/models refresh")
  })

  it("completes /model with agent names", () => {
    const [hits] = completer("/model ")
    expect(hits).toContain("/model claude")
    expect(hits).toContain("/model gemini")
  })

  it("completes /model <agent> with model ids and clear", () => {
    const [hits] = completer("/model claude ")
    expect(hits).toContain("/model claude claude-opus-4-6")
    expect(hits).toContain("/model claude claude-sonnet-4-6")
    expect(hits).toContain("/model claude clear")
  })

  it("completes /debate subcommands", () => {
    const [hits] = completer("/debate ")
    expect(hits).toContain("/debate rounds")
    expect(hits).toContain("/debate autopilot")
  })

  it("completes /debate autopilot values", () => {
    const [hits] = completer("/debate autopilot ")
    expect(hits).toContain("/debate autopilot on")
    expect(hits).toContain("/debate autopilot off")
  })

  it("returns no completions for /debate rounds (numeric)", () => {
    const [hits] = completer("/debate rounds ")
    expect(hits).toEqual([])
  })

  it("returns no completions for /agents, /sessions, /history, /help", () => {
    for (const cmd of ["/agents ", "/sessions ", "/history ", "/help "]) {
      const [hits] = completer(cmd)
      expect(hits).toEqual([])
    }
  })
})
```

**Step 2: Run tests to verify they pass**

```sh
bun test src/cli/completer.test.ts
```
Expected: PASS — all argument completion tests green.

**Step 3: Commit**

```sh
git add src/cli/completer.test.ts
git commit -m "test: add argument completion coverage for buildCompleter"
```

---

### Task 3: Wire completer into `readline.createInterface`

**Files:**
- Modify: `src/cli/index.ts:83-87`

**Step 1: Import `buildCompleter`**

At the top of `src/cli/index.ts`, add:

```ts
import { buildCompleter } from "./completer"
```

**Step 2: Build the completer after `modelCache` is loaded**

After `await modelCache.load()` (line ~35), add:

```ts
const completer = buildCompleter(registry, modelCache)
```

**Step 3: Pass completer to `createInterface`**

Replace:
```ts
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: true,
})
```

With:
```ts
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: true,
  completer,
})
```

**Step 4: Smoke test manually**

```sh
bun src/index.ts
```
Type `/mo` and press Tab — should complete to `/mode `.
Type `/mode ` and press Tab — should show `council dispatch pipeline debate`.
Type `/model ` and press Tab — should show agent names.

**Step 5: Run full test suite**

```sh
bun test
```
Expected: all tests pass.

**Step 6: Commit**

```sh
git add src/cli/index.ts
git commit -m "feat: wire tab completer into readline CLI"
```
