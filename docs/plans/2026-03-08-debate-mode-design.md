# Debate Mode Design

**Date:** 2026-03-08
**Status:** Approved

## Goal

Add a `debate` mode where agents deliberate back and forth, only speaking when they have something new to add, with human interjection support and safeguards against infinite loops.

## Key Insight

Real healthy debates end naturally — participants stop when they agree or have nothing to add. We model this with a participation signal per round (`pass` vs `respond`) and a hard round cap as a fallback.

## Architecture

### Flow

```
you: [prompt]

Round 1 (mandatory — all agents speak in parallel):
  [codex]  → full response
  [gemini] → full response

Round 2+ (each agent sees ALL prior responses):
  each agent replies with structured JSON:
    { "pass": true }
    OR
    { "pass": false, "content": "..." }

  agents run in parallel within each round

  After round completes:
    if autopilot off → pause for human input
      - Empty Enter   → continue
      - Typed message → injected as [user] turn in next round
      - /done         → end debate early, synthesize now
    if all agents passed → stop (consensus)
    if round == maxRounds → stop (cap reached)

Router synthesizes all non-pass content and announces:
  "Consensus reached after N rounds" OR "Debate concluded (max rounds reached)"
```

### Result Type

```typescript
type DebateRound = { agent: string; content: string }[]

type DebateResult = {
  rounds: DebateRound[]        // rounds[i] = non-pass responses in round i
  synthesis: string
  consensusReached: boolean
  roundCount: number
}
```

### Termination Safeguards

Two conditions — whichever hits first:

1. **Consensus** — all agents pass in the same round
2. **Hard cap** — `maxRounds` (default: 5)

If cap is hit, synthesis notes the debate was inconclusive.

### Session Settings

| Setting | Default | Command |
|---|---|---|
| Max rounds | 5 | `/debate rounds <n>` |
| Human pause | on | `/debate autopilot on` / `/debate autopilot off` |

### Slash Commands (new)

```
/debate rounds <n>       — set max rounds (default: 5)
/debate autopilot on     — skip human pause between rounds
/debate autopilot off    — pause after each round for human input (default)
```

### Human Pause Prompt (when autopilot off)

```
Round 2 complete. Press Enter to continue, or type to steer (/done to end, /debate autopilot on to stop asking):
you>
```

## What Is NOT Included (YAGNI)

- No per-agent speaking order (parallel within each round)
- No per-round moderator call (too expensive)
- No configurable participation prompt per agent

## Files to Modify

| Component | File |
|---|---|
| `DebateResult` type + `debate()` method | `src/core/council/index.ts` |
| `debate` case in prompt loop | `src/cli/index.ts` |
| `/debate` slash command | `src/cli/index.ts` |
| Tests | `src/core/council/council.test.ts` |
| Slash parse tests | `src/cli/slash.test.ts` |
