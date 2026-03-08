# Debate Mode Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `debate` mode where agents deliberate in rounds, only speaking when they have something new to add, with human interjection support and a hard round cap.

**Architecture:** `CouncilRunner.debate()` runs round 1 in parallel (all agents speak), then subsequent rounds where each agent sees all prior content and replies with `{ "pass": true }` or `{ "pass": false, "content": "..." }`. The loop ends on consensus (all pass) or `maxRounds`. The CLI pauses between rounds for optional human input unless autopilot is on.

**Tech Stack:** Bun, TypeScript, `bun:test`, readline for mid-debate human input

**Test runner:** `~/.bun/bin/bun test` from `/Users/vunguyen/Projects/nilead/consilium/`

**Key existing files:**
- `src/core/council/index.ts` — add `DebateResult` type and `debate()` method
- `src/cli/index.ts` — add `debate` to `Mode`, handle in prompt loop, add `/debate` slash command
- `src/core/council/council.test.ts` — add debate tests using existing `mock()` factory
- `src/cli/slash.test.ts` — add `/debate` parse tests

---

### Task 1: Add `DebateResult` type and `debate()` method to `CouncilRunner`

**Files:**
- Modify: `src/core/council/index.ts`
- Modify: `src/core/council/council.test.ts`

**Step 1: Write the failing tests**

Add to `src/core/council/council.test.ts`:

```typescript
describe("debate mode", () => {
  it("round 1 collects responses from all agents", async () => {
    const runner = new CouncilRunner({
      router: mock("claude", "synthesized"),
      adapters: [mock("codex", "codex opinion"), mock("gemini", "gemini opinion")],
    })
    const result = await runner.debate("what is best?", [], { maxRounds: 3 })
    expect(result.rounds[0]).toHaveLength(2)
    expect(result.rounds[0].map(r => r.agent)).toContain("codex")
    expect(result.rounds[0].map(r => r.agent)).toContain("gemini")
  })

  it("agents that pass are excluded from subsequent rounds output", async () => {
    let callCount = 0
    const passingAdapter: AgentAdapter = {
      name: "gemini",
      isAvailable: async () => true,
      getModels: async () => [],
      query: async () => {
        callCount++
        // round 1: speaks; round 2+: passes
        if (callCount === 1) return { agent: "gemini", content: "gemini opinion", durationMs: 1 }
        return { agent: "gemini", content: JSON.stringify({ pass: true }), durationMs: 1 }
      },
    }
    const runner = new CouncilRunner({
      router: mock("claude", "synthesis"),
      adapters: [mock("codex", JSON.stringify({ pass: true })), passingAdapter],
    })
    const result = await runner.debate("topic", [], { maxRounds: 3 })
    // round 2: codex passes, gemini passes → all pass → stop
    expect(result.consensusReached).toBe(true)
    expect(result.roundCount).toBe(2)
    // round 2 has no non-pass responses
    expect(result.rounds[1]).toHaveLength(0)
  })

  it("stops at maxRounds even if agents keep responding", async () => {
    const runner = new CouncilRunner({
      router: mock("claude", "synthesis"),
      adapters: [
        mock("codex", JSON.stringify({ pass: false, content: "still debating" })),
        mock("gemini", JSON.stringify({ pass: false, content: "me too" })),
      ],
    })
    const result = await runner.debate("topic", [], { maxRounds: 2 })
    expect(result.roundCount).toBe(2)
    expect(result.consensusReached).toBe(false)
  })

  it("router synthesizes at the end", async () => {
    const runner = new CouncilRunner({
      router: mock("claude", "final synthesis"),
      adapters: [mock("codex", "opinion"), mock("gemini", JSON.stringify({ pass: true }))],
    })
    const result = await runner.debate("topic", [], { maxRounds: 1 })
    expect(result.synthesis).toBe("final synthesis")
  })
})
```

**Step 2: Run to confirm failures**

```bash
~/.bun/bin/bun test src/core/council/council.test.ts
```

Expected: FAIL — `runner.debate is not a function`

**Step 3: Add `DebateResult` type and `debate()` method to `src/core/council/index.ts`**

Add after the `PipelineResult` type:

```typescript
export type DebateRound = { agent: string; content: string }[]

export type DebateResult = {
  rounds: DebateRound[]
  synthesis: string
  consensusReached: boolean
  roundCount: number
}
```

Add the `debate()` method to `CouncilRunner` (after the `pipeline()` method):

```typescript
async debate(
  prompt: string,
  context: Message[],
  options: { maxRounds?: number } = {},
): Promise<DebateResult> {
  const maxRounds = options.maxRounds ?? 5
  const rounds: DebateRound[] = []
  const agents = this.adapters

  // Build a flat history of all debate turns so far
  const history = (): string =>
    rounds.flatMap((round, i) =>
      round.map(r => `[Round ${i + 1}] [${r.agent}]: ${r.content}`)
    ).join("\n")

  // Round 1: all agents give their initial response (plain text, no pass/fail)
  const round1 = await Promise.all(
    agents.map(async a => {
      const resp = await a.query(
        `Debate topic: "${prompt}"\n\nGive your initial position.`,
        context,
      )
      return { agent: a.name, content: resp.content }
    })
  )
  rounds.push(round1)

  // Rounds 2+: agents respond with { "pass": true } or { "pass": false, "content": "..." }
  for (let round = 2; round <= maxRounds; round++) {
    const debateHistory = history()
    const roundResponses = await Promise.all(
      agents.map(async a => {
        const resp = await a.query(
          `Debate topic: "${prompt}"\n\nDebate so far:\n${debateHistory}\n\nDo you have anything to add or challenge? Respond with JSON only:\n{ "pass": true } if you have nothing new to add\n{ "pass": false, "content": "<your response>" } if you want to speak`,
          [],
        )
        try {
          const parsed = JSON.parse(resp.content)
          if (parsed.pass === true) return null
          return { agent: a.name, content: parsed.content as string }
        } catch {
          // If agent didn't follow JSON format, treat as a response
          return { agent: a.name, content: resp.content }
        }
      })
    )
    const nonPass = roundResponses.filter((r): r is { agent: string; content: string } => r !== null)
    rounds.push(nonPass)

    if (nonPass.length === 0) {
      // All agents passed — consensus reached
      const synthesisPrompt = [
        `Debate topic: "${prompt}"`,
        `Full debate:\n${history()}`,
        `Consensus was reached. Synthesize the final position.`,
      ].join("\n")
      const synthesis = await this.router.query(synthesisPrompt, [])
      return { rounds, synthesis: synthesis.content, consensusReached: true, roundCount: round }
    }
  }

  // Max rounds reached
  const synthesisPrompt = [
    `Debate topic: "${prompt}"`,
    `Full debate:\n${history()}`,
    `The debate reached the maximum number of rounds (${maxRounds}). Synthesize the best conclusion from what was said.`,
  ].join("\n")
  const synthesis = await this.router.query(synthesisPrompt, [])
  return { rounds, synthesis: synthesis.content, consensusReached: false, roundCount: maxRounds }
}
```

**Step 4: Run tests**

```bash
~/.bun/bin/bun test src/core/council/council.test.ts
```

Expected: all pass

**Step 5: Run full suite**

```bash
~/.bun/bin/bun test
```

Expected: all pass

**Step 6: Commit**

```bash
git add src/core/council/index.ts src/core/council/council.test.ts
git commit -m "feat: debate() method on CouncilRunner with round-based participation and consensus detection"
```

---

### Task 2: Wire debate mode into the CLI prompt loop

**Files:**
- Modify: `src/cli/index.ts`

**Step 1: Read current `src/cli/index.ts` lines 1-15 and 85-140**

Note the `type Mode` definition at line 9 and the prompt loop branch at lines 106-131.

**Step 2: Update `Mode` type and add debate settings**

Change:
```typescript
type Mode = "council" | "dispatch" | "pipeline"
```
To:
```typescript
type Mode = "council" | "dispatch" | "pipeline" | "debate"
```

Add debate session settings after `const modelOverrides = new Map<string, string>()`:
```typescript
let debateMaxRounds = 5
let debateAutopilot = false
```

**Step 3: Add debate branch to the prompt loop**

In the `try` block inside the `rl.question` callback, add after the `else` (pipeline) branch:

Replace:
```typescript
      } else {
        const r = await runner.pipeline(trimmed, context)
```

With:
```typescript
      } else if (mode === "pipeline") {
        const r = await runner.pipeline(trimmed, context)
        console.log(`\n[executor result]: ${r.taskContent}`)
        r.reviews.forEach(rev =>
          console.log(`\n[${rev.reviewer} review]: ${rev.content} (${rev.verdict})`)
        )
        const approved = r.approved ? "✓ approved" : "✗ changes requested"
        console.log(`\n[pipeline]: ${approved}`)
        sessionMgr.addMessage(session.id, "agent", "pipeline", r.taskContent)
        context.push({ role: "agent", agent: "pipeline", content: r.taskContent })
      } else {
        // debate mode
        const debateOptions = { maxRounds: debateMaxRounds }
        let earlyEnd = false

        // Override runner.debate to pause between rounds when autopilot is off
        // We run round 1 immediately, then ask for human input before each subsequent round
        const r = await runner.debate(trimmed, context, {
          ...debateOptions,
          onRoundComplete: debateAutopilot ? undefined : async (roundNum: number, roundResponses: { agent: string; content: string }[]) => {
            roundResponses.forEach(resp => console.log(`\n[${resp.agent}]: ${resp.content}`))
            console.log(`\nRound ${roundNum} complete. Press Enter to continue, or type to steer (/done to end, /debate autopilot on to stop asking):`)
            const input = await new Promise<string>(resolve => rl.question("you> ", resolve))
            const trimmedInput = input.trim()
            if (trimmedInput === "/done") { earlyEnd = true; return false }
            if (trimmedInput === "/debate autopilot on") { debateAutopilot = true; return true }
            if (trimmedInput) {
              context.push({ role: "user", agent: null, content: trimmedInput })
              sessionMgr.addMessage(session.id, "user", null, trimmedInput)
            }
            return true // continue
          },
        })

        if (!earlyEnd) {
          r.rounds.forEach((round, i) => {
            round.forEach(resp => console.log(`\n[${resp.agent}] round ${i + 1}: ${resp.content}`))
          })
        }
        const outcome = r.consensusReached
          ? `Consensus reached after ${r.roundCount} rounds`
          : `Debate concluded (max rounds reached)`
        console.log(`\n[synthesis]: ${r.synthesis}`)
        console.log(`\n[debate]: ${outcome}`)
        sessionMgr.addMessage(session.id, "agent", "synthesis", r.synthesis)
        context.push({ role: "agent", agent: "synthesis", content: r.synthesis })
```

**IMPORTANT:** The `onRoundComplete` callback approach requires updating the `debate()` method signature in Task 1's implementation. See the revised `debate()` signature in Step 4 below.

**Step 4: Update `debate()` to support `onRoundComplete` callback**

In `src/core/council/index.ts`, update the `debate()` options type and add callback support:

```typescript
async debate(
  prompt: string,
  context: Message[],
  options: {
    maxRounds?: number
    onRoundComplete?: (roundNum: number, responses: DebateRound) => Promise<boolean | undefined>
  } = {},
): Promise<DebateResult> {
```

After `rounds.push(round1)` in round 1, call the callback:
```typescript
  rounds.push(round1)
  if (options.onRoundComplete) {
    const cont = await options.onRoundComplete(1, round1)
    if (cont === false) {
      const synthesis = await this.router.query(`Debate topic: "${prompt}"\n\nFull debate:\n${history()}\n\nSynthesize the best conclusion.`, [])
      return { rounds, synthesis: synthesis.content, consensusReached: false, roundCount: 1 }
    }
  }
```

After `rounds.push(nonPass)` in round 2+, also call the callback before checking consensus:
```typescript
  rounds.push(nonPass)
  if (options.onRoundComplete) {
    const cont = await options.onRoundComplete(round, nonPass)
    if (cont === false) {
      const synthesis = await this.router.query(`Debate topic: "${prompt}"\n\nFull debate:\n${history()}\n\nSynthesize the best conclusion.`, [])
      return { rounds, synthesis: synthesis.content, consensusReached: false, roundCount: round }
    }
  }
  if (nonPass.length === 0) { ... }
```

**Step 5: Also update `Mode` validation in the existing `/mode` slash handler**

Find in `handleSlash`:
```typescript
      if (m === "council" || m === "dispatch" || m === "pipeline") {
```

Change to:
```typescript
      if (m === "council" || m === "dispatch" || m === "pipeline" || m === "debate") {
```

And update the usage message:
```typescript
        console.log("usage: /mode council|dispatch|pipeline|debate")
```

**Step 6: Run tests**

```bash
~/.bun/bin/bun test
```

Expected: all pass (debate mode in CLI has no unit tests — covered by integration)

**Step 7: Commit**

```bash
git add src/core/council/index.ts src/cli/index.ts
git commit -m "feat: wire debate mode into CLI prompt loop with round callback support"
```

---

### Task 3: Add `/debate` slash command

**Files:**
- Modify: `src/cli/index.ts`
- Modify: `src/cli/slash.test.ts`

**Step 1: Write failing slash parse tests**

Add to `src/cli/slash.test.ts`:

```typescript
it("parses /debate command", () => {
  expect(parseSlash("/debate rounds 3")).toEqual({ command: "debate", args: ["rounds", "3"] })
  expect(parseSlash("/debate autopilot on")).toEqual({ command: "debate", args: ["autopilot", "on"] })
  expect(parseSlash("/debate autopilot off")).toEqual({ command: "debate", args: ["autopilot", "off"] })
})
```

**Step 2: Run to confirm they pass** (parseSlash is generic — no code change needed)

```bash
~/.bun/bin/bun test src/cli/slash.test.ts
```

Expected: all pass

**Step 3: Add `debateMaxRounds` and `debateAutopilot` to `SlashCtx`**

In the `SlashCtx` type, add:
```typescript
  debateMaxRounds: number
  debateAutopilot: boolean
  setDebateMaxRounds: (n: number) => void
  setDebateAutopilot: (on: boolean) => void
```

**Step 4: Pass the new fields when building ctx**

In the `handleSlash` call inside `rl.question`, add:
```typescript
          debateMaxRounds,
          debateAutopilot,
          setDebateMaxRounds: (n: number) => { debateMaxRounds = n },
          setDebateAutopilot: (on: boolean) => { debateAutopilot = on },
```

**Step 5: Add `debate` case to `handleSlash`**

Add before the `default` case:

```typescript
    case "debate": {
      const [sub, val] = slash.args
      if (sub === "rounds") {
        const n = parseInt(val, 10)
        if (!n || n < 1) { console.log("usage: /debate rounds <number>"); break }
        ctx.setDebateMaxRounds(n)
        console.log(`debate max rounds → ${n}`)
      } else if (sub === "autopilot") {
        if (val === "on") { ctx.setDebateAutopilot(true); console.log("debate autopilot → on") }
        else if (val === "off") { ctx.setDebateAutopilot(false); console.log("debate autopilot → off") }
        else console.log("usage: /debate autopilot on|off")
      } else {
        console.log("usage: /debate rounds <n> | /debate autopilot on|off")
      }
      break
    }
```

**Step 6: Update `/help` output**

Add to the help array:
```typescript
        "/mode council|dispatch|pipeline|debate  — switch execution mode",
        "/debate rounds <n>               — set max debate rounds (default: 5)",
        "/debate autopilot on|off         — skip/enable human pause between rounds",
```

Replace the existing `/mode` help line with the updated one above.

**Step 7: Run full test suite**

```bash
~/.bun/bin/bun test
```

Expected: all pass

**Step 8: Commit**

```bash
git add src/cli/index.ts src/cli/slash.test.ts
git commit -m "feat: /debate slash command for rounds and autopilot settings"
```

---

### Task 4: Manual end-to-end smoke test

This task has no automated tests — verify the feature works interactively.

**Step 1: Test autopilot mode (non-interactive)**

```bash
echo "is TypeScript better than Python for backend services?" | ~/.bun/bin/bun src/index.ts --mode debate 2>&1
```

Expected output shape:
```
consilium — session ...
mode: debate  router: claude

[codex] round 1: ...
[gemini] round 1: ...

[codex] round 2: ...   ← or nothing if they passed

[synthesis]: ...
[debate]: Consensus reached after N rounds  OR  Debate concluded (max rounds reached)
```

**Step 2: Test `/debate rounds` command works**

```bash
printf "/debate rounds 2\nis Python better than JavaScript?\n" | ~/.bun/bin/bun src/index.ts --mode debate 2>&1
```

Expected: debate stops after 2 rounds max.

**Step 3: Commit if any fixes were needed**

```bash
git add -p
git commit -m "fix: debate mode smoke test fixes"
```

If no fixes needed, skip this step.
