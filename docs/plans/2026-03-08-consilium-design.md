# Consilium — Design Document

**Date:** 2026-03-08
**Status:** Approved
**References:** [orch (Python)](../../../brainstorming/orch), [agents-council](https://github.com/MrLesk/agents-council)

---

## Overview

Consilium is a TypeScript-first AI agent orchestration platform built to maximize the value of paid AI subscriptions (Claude, Codex, Gemini). Rather than using a single agent for every task, Consilium enables agents to collaborate — debating, routing, executing, and peer-reviewing work to produce the best possible output.

It runs as both an interactive CLI and an MCP server, so it can be used directly by humans or called into by other agents (e.g. Claude Code).

---

## Goals

- **Best answer** — multiple agents discuss the same problem (council mode)
- **Best tool for the task** — route each task to the most capable agent (dispatch mode)
- **Best quality** — agent does work, others peer-review, iterate until approved (pipeline mode)
- **MCP-compatible** — expose orch capabilities as tools other agents can call
- **CLI-first** — interactive terminal experience, UI added later

---

## Location

```
nilead/
├── brainstorming/orch/   ← Python prototype (kept as reference, not deleted)
└── consilium/            ← new TypeScript project (this repo)
```

---

## Tech Stack

| Concern | Choice | Reason |
|---|---|---|
| Runtime | Bun | Fast startup, native TS, built-in SQLite |
| Language | TypeScript | MCP/Claude SDK ecosystem is TS-first |
| Database | Bun SQLite + Drizzle ORM | Single file, WAL mode, type-safe queries |
| MCP server | `@modelcontextprotocol/sdk` | Expose consilium as agent-callable tools |
| Claude adapter | `@anthropic-ai/claude-agent-sdk` | SDK-first, proper tool injection |
| Codex adapter | `@openai/codex-sdk` | SDK-first |
| Gemini adapter | Subprocess fallback | No SDK yet |
| CLI | Bun + readline | Lean, no heavy framework needed |

---

## Project Structure

```
consilium/
├── src/
│   ├── cli/            - Interactive chat loop + slash commands
│   ├── core/
│   │   ├── adapters/   - Claude SDK, Codex SDK, Gemini subprocess + shared interface
│   │   ├── router/     - Configurable routing agent (defaults to Claude)
│   │   ├── council/    - Council, dispatch, pipeline execution logic
│   │   ├── db/         - SQLite schema + Drizzle ORM, DbStore class
│   │   └── session/    - Session lifecycle management
│   ├── mcp/            - MCP server + tool definitions
│   └── workflows/      - YAML workflow definitions (ported from orch)
├── docs/plans/
├── package.json
└── drizzle.config.ts
```

---

## Data Model

Stored at `~/.consilium/consilium.db` (SQLite, WAL mode).

```
sessions
  id, name, mode (council|dispatch|pipeline), status (active|closed), router, created_at

messages
  id, session_id, role (user|agent|system), agent, content, created_at

tasks
  id, session_id, content, assigned_to, status (pending|running|done|failed), created_at

reviews
  id, task_id, reviewer, content, verdict (approved|changes_requested), created_at

participants
  id, session_id, agent, joined_at, last_seen
```

All writes go through a single `DbStore` class. `tasks` + `reviews` are intentionally separate from `messages` to cleanly distinguish pipeline work from conversation history.

---

## Three Execution Modes

### Council Mode
All agents respond to the same prompt in parallel. The router synthesizes a final answer.

```
User → Router → [Claude, Codex, Gemini] (parallel)
     → Router synthesizes → Final answer
```

### Dispatch Mode
Router decides which agent is best for each task and assigns it.

```
User → Router (decides agent + task decomposition)
     → Agent A (executes) → Response
```

### Pipeline Mode
One agent executes, others peer-review. Iterate until approved or max rounds reached.

```
User → Router → Agent A (executes task)
     → [Agent B, Agent C] (review in parallel)
     → Router (synthesizes reviews) → Approved or retry
```

All three modes share the same session/task/review tables — different execution paths through the same `DbStore`.

---

## Router

- **Configurable** — any agent can be the router, set via config or CLI flag
- **Default** — Claude (but not hardcoded)
- **Council mode** — router is excluded from council respondents by default (to avoid judging its own answer), unless explicitly allowed
- **Responsibilities** — pick mode (if not forced), pick agent per task, synthesize results, decide pipeline approval

---

## Adapter Interface

```typescript
interface AgentAdapter {
  name: string
  query(prompt: string, context: Message[]): Promise<AgentResponse>
  stream?(prompt: string, context: Message[]): AsyncIterable<string>
}
```

- **Claude** — `@anthropic-ai/claude-agent-sdk` (SDK)
- **Codex** — `@openai/codex-sdk` (SDK)
- **Gemini** — subprocess fallback, same interface
- New agents can be added by implementing `AgentAdapter`

---

## CLI Interface

```bash
consilium                        # interactive session, router picks mode
consilium --mode council         # force council mode
consilium --mode dispatch        # force dispatch mode
consilium --mode pipeline        # force pipeline mode
consilium --router gemini        # set router agent
consilium --resume <session-id>  # resume previous session
consilium --mcp                  # run as MCP server
```

**Slash commands (inside chat loop):**
```
/mode council     - switch mode mid-session
/router codex     - switch router mid-session
/agents           - show active agents + status
/sessions         - list past sessions
/review           - manually trigger peer review on last response
/history          - show session history
/help             - show all commands
```

---

## MCP Server

When run with `--mcp`, Consilium exposes tools other agents can call:

```
start_session     - open a new council/dispatch/pipeline session
send_message      - send a message to the active session
get_result        - poll for results (cursor-based)
list_sessions     - list past sessions
close_session     - close active session with conclusion
```

This allows Claude Code (or any MCP-compatible agent) to use Consilium as an orchestration backend.

---

## What We Borrow

| From `orch` | From `agents-council` |
|---|---|
| Adapter pattern (base interface) | MCP server structure |
| Router concept | Summon pattern (SDK-based agent spawning) |
| Session lifecycle | Cursor-based polling for results |
| Workflow YAML format | Council feedback loop |
| Slash command system | Atomic state updates |
| Chat loop structure | Participant tracking |

---

## Out of Scope (for now)

- Desktop / web UI (designed to be added later without architectural changes)
- Remote tunnel (Cloudflare tunnel from orch) — revisit when needed
- Agent authentication management — assumes CLIs are already authenticated
- Multi-user / networked sessions — local only for now
