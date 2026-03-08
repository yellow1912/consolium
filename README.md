# Consilium

AI agent orchestration — maximize the value of paid AI subscriptions by letting agents collaborate.

## Why

Most tasks use a single AI agent. Consilium lets multiple agents work together:
- **Council mode** — all agents answer in parallel, the router synthesizes the best response
- **Dispatch mode** — the router assigns each task to the most capable agent
- **Pipeline mode** — one agent executes, others peer-review, the router approves
- **Debate mode** — agents argue positions across multiple rounds until consensus or max rounds, with optional human steering between rounds

## Installation

**Prerequisites:** [Bun](https://bun.sh) installed, plus at least one of the supported agents configured (see [Agents](#agents)).

```bash
git clone https://github.com/yellow1912/consolium.git
cd consilium
bun install
```

To use `consilium` (or `csl`) as a global command from anywhere:

```bash
bun link
```

Then verify it works:

```bash
consilium --help
# or the short alias:
csl --help
```

Without linking, run directly with:

```bash
bun src/index.ts
```

## Usage

```bash
# Start an interactive session (dispatch mode, claude router by default)
consilium

# Force a specific mode
consilium --mode council
consilium --mode dispatch
consilium --mode pipeline
consilium --mode debate

# Use a different router agent
consilium --router gemini

# Resume a previous session (restores mode and router)
consilium --resume <session-id>

# List all past sessions
consilium --list

# Run as MCP server (for Claude Code and other MCP-compatible agents)
consilium --mcp
```

## Modes

### Council

All agents respond to the prompt in parallel. The router then reads all responses and synthesizes the best answer. Good for open-ended questions where you want multiple perspectives combined into one answer.

```
you> What are the trade-offs between microservices and a monolith?

[claude]: Microservices offer independent deployability...
[codex]: From an engineering standpoint, microservices introduce...
[gemini]: The decision depends heavily on team size...

[synthesis]: Monoliths are simpler to start with and easier to operate at small scale...
```

### Dispatch

The router reads the task and picks the best agent and model for it, then routes the message there. Good for mixed workloads where different tasks suit different agents (e.g. code tasks to Codex, long-document tasks to Gemini).

```
you> Refactor this function to use async/await

[routing → codex]
[codex]: Here's the refactored version...
```

### Pipeline

The router picks an executor agent to complete the task. Once done, all other agents act as peer reviewers and return a verdict (`approved` or `changes_requested`) with feedback. Good for tasks where quality and correctness matter — the output isn't accepted until reviewers sign off.

```
you> Write a SQL migration to add an index on users.email

[routing → codex]
[codex executing...]
[claude, gemini reviewing...]

[executor result]: ALTER TABLE users ADD INDEX idx_email (email);
[claude review]: Looks correct. Consider adding CONCURRENTLY for large tables. (approved)
[gemini review]: Valid syntax. No issues found. (approved)
[pipeline]: ✓ approved
```

### Debate

Agents argue a topic across multiple rounds. Each round they see the full debate history and either contribute a new argument or pass. When all agents pass in the same round, consensus is reached and the router synthesizes a final position. If max rounds is hit without consensus, the router summarizes the best conclusion.

Between rounds you can steer the debate, let it run on autopilot, or end it early.

```
you> Should we adopt TypeScript for our Python backend?

[claude]: TypeScript is a frontend concern. For a Python backend...
[codex]: The question conflates two ecosystems. The real question is...
[gemini]: There are scenarios where TypeScript on the backend (via Bun/Node)...

Round 1 complete. Press Enter to continue, or type to steer (/done to end):
you> Focus on the migration cost angle

[claude]: Migration cost is the decisive factor here...
[codex]: Agreed on cost. I'd add that incremental migration is...
[gemini]: (pass)

[synthesis]: Given migration cost constraints, staying with Python is likely correct unless...
[debate]: Consensus reached after 2 rounds
```

**Debate controls:**

| Input | Effect |
|-------|--------|
| Enter | Continue to next round |
| Any text | Steer the debate with a new prompt |
| `/done` | End debate early, trigger synthesis |
| `/debate autopilot on` | Stop prompting between rounds |

## Slash Commands

Type these directly in the chat prompt:

| Command | Description |
|---------|-------------|
| `/mode council\|dispatch\|pipeline\|debate` | Switch execution mode mid-session |
| `/router <name>` | Switch router agent mid-session |
| `/agents` | List available agents |
| `/models` | List cached models per agent (with age and overrides) |
| `/models refresh` | Re-fetch models from all agents |
| `/model <agent> <model-id>` | Override model for a specific agent this session |
| `/model <agent> clear` | Remove model override |
| `/sessions` | List all past sessions |
| `/history` | Show current session history |
| `/debate rounds <n>` | Set max debate rounds (default: 5) |
| `/debate autopilot on\|off` | Skip or re-enable human pause between debate rounds |
| `/help` | Show all commands |
| `/exit` or `/quit` | Exit consilium |

## Natural Language Commands

You don't need to use slash syntax. Consilium uses the router agent to classify your intent — conversational commands are automatically detected and executed:

```
you> switch to debate mode
you> use gemini as the router
you> how many agents are available?
you> set debate rounds to 3
you> show my session history
```

If the input looks like a control command, Consilium routes it to the command handler. Otherwise it's sent to the agents as a normal message.

## MCP Integration

Add to your Claude Code MCP config (`~/.claude/mcp.json`):
```json
{
  "consilium": {
    "command": "bun",
    "args": ["/path/to/consilium/src/index.ts", "--mcp"]
  }
}
```

Then Claude Code can call Consilium tools: `start_session`, `send_message`, `get_result`, `list_sessions`, `close_session`.

## Agents

| Agent | SDK / Method | Notes |
|-------|-------------|-------|
| claude | `@anthropic-ai/claude-agent-sdk` | Default router. Requires `ANTHROPIC_API_KEY`. |
| codex | `@openai/codex-sdk` | Code-focused. Requires `OPENAI_API_KEY`. |
| gemini | subprocess (`gemini` CLI) | Long-context tasks. Requires `gemini` CLI installed and authenticated. |

You need at least one agent available. Consilium skips agents that aren't configured.

## Architecture

```
src/
├── cli/          — interactive chat loop, slash commands, natural language intent classifier
├── core/
│   ├── adapters/ — Claude/Codex/Gemini adapters + registry
│   ├── council/  — CouncilRunner (council, dispatch, pipeline, debate)
│   ├── db/       — SQLite schema + DbStore (WAL mode)
│   └── session/  — SessionManager + per-agent session store
└── mcp/          — MCP server (5 tools)
```

State stored at `~/.consilium/consilium.db` (SQLite).

## References

- [orch](../brainstorming/orch/) — Python prototype this evolved from
- [agents-council](https://github.com/MrLesk/agents-council) — inspiration for MCP + council patterns
