# Natural Language Command Interpretation Design

**Date:** 2026-03-08

## Problem

Users must remember exact slash commands. Natural phrases like "switch to debate mode" or "show me my sessions" are not understood.

## Goal

Allow users to express commands in plain English. When input is not a slash command, run it through a Claude-powered intent classifier. If it's a control command, execute it. If it's a regular message, pass it through to the current mode.

## Architecture

A new `classifyIntent(input, claudeAdapter, registry)` function in `src/cli/intent.ts` sends the user's message to Claude with a classification prompt listing all available commands and current agent names. It returns structured JSON. In `src/cli/index.ts`, every non-slash input passes through `classifyIntent` before routing. On any failure, falls back to treating input as a regular message.

## Classification Prompt

Claude receives a system prompt listing all valid commands and their arguments, plus current agent names, then the user message. Must respond with JSON only:

```json
{ "type": "command", "command": "mode", "args": ["debate"] }
// or
{ "type": "message" }
```

## Supported Commands via NL

| Example phrase | Mapped command |
|---|---|
| "switch to debate mode" | `/mode debate` |
| "use gemini as router" | `/router gemini` |
| "show me all agents" | `/agents` |
| "what models are available" | `/models` |
| "refresh models" | `/models refresh` |
| "set claude to opus" | `/model claude claude-opus-4-6` |
| "show my sessions" | `/sessions` |
| "show history" | `/history` |
| "set debate rounds to 3" | `/debate rounds 3` |
| "turn on autopilot" | `/debate autopilot on` |
| "exit" / "quit" / "bye" | `/exit` |

## Error Handling

- Classification fails or returns bad JSON → treat as regular message (safe fallback)
- Unknown command returned by classifier → treat as regular message

## Files

- **New:** `src/cli/intent.ts` — `classifyIntent(input, claudeAdapter, registry)`
- **New:** `src/cli/intent.test.ts` — unit tests with mocked adapter
- **Modified:** `src/cli/index.ts` — call `classifyIntent` before routing each message
