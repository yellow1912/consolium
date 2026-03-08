# Per-Agent Session Management Design

**Date:** 2026-03-08

## Problem

All adapters flatten the full conversation history into a single string prompt on every call. For long conversations this hits token limits and wastes tokens re-sending history the agent already knows.

## Goal

Each agent maintains its own native sub-session within a master consilium session. Per turn, agents receive only a compact delta (user message + peer responses), not the full history. Claude uses native `--resume <uuid>` for true long-term memory. Gemini and Codex benefit from the compact delta even without native session resumption.

## Architecture

```
Master session (consilium)
  ├── claude sub-session  → native resume via --resume <uuid>
  ├── gemini sub-session  → delta messages only (no native resume)
  └── codex sub-session   → delta messages only (no native resume)
```

Agent session IDs are persisted in a new `agent_sessions` DB table so they survive restarts.

## Per-Turn Message Format

Each agent receives:
```
[User]: <user message>

[Peer responses]:
[claude]: <claude's response>
[gemini]: <gemini's response>

Your response:
```

## Session Init System Prompt

On first call per agent:
```
You are <agent> participating in a multi-agent discussion with <peers>.
Mode: <council|dispatch|pipeline|debate>.
Contribute your perspective and build on peer responses.
```

## DB Schema Change

New table:
```sql
agent_sessions(id, master_session_id, agent_name, agent_session_id, created_at)
```

## Adapter Changes

- `QueryOptions` gets `agentSessionId?: string`
- `AgentResponse` gets `sessionId?: string` (so adapters can surface the session ID used)
- **ClaudeAdapter**: no `agentSessionId` → generate UUID + `--session-id <uuid>` + system prompt; has `agentSessionId` → `--resume <agentSessionId>`. Returns `sessionId` in response.
- **GeminiAdapter / CodexAdapter**: ignore `agentSessionId`, receive compact delta message only.

## CouncilRunner Changes

- Accepts `masterSessionId` and a `SessionManager` reference
- On each agent call: looks up existing `agentSessionId` from DB
- Builds system prompt (first call) or delta message (subsequent calls)
- After each call: persists returned `sessionId` to DB
- Uses last turn's peer responses (from `context`) for the delta — does NOT dump full history

## Files Touched

- `src/core/db/schema.ts` — add `agent_sessions` table
- `src/core/db/index.ts` — CRUD for agent sessions
- `src/core/session/index.ts` — `getAgentSession` / `setAgentSession` methods
- `src/core/adapters/types.ts` — `agentSessionId` in `QueryOptions`, `sessionId` in `AgentResponse`
- `src/core/adapters/claude.ts` — `--session-id` / `--resume` logic
- `src/core/adapters/base.ts` — remove full-history flattening, accept pre-built message
- `src/core/council/index.ts` — build delta messages, manage agent sessions
- `src/cli/index.ts` — pass `sessionId` to runner methods
