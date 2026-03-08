# Consilium

AI agent orchestration — maximize the value of paid AI subscriptions by letting agents collaborate.

## Why

Most tasks use a single AI agent. Consilium lets multiple agents work together:
- **Council mode** — all agents answer, the router synthesizes the best response
- **Dispatch mode** — the router assigns each task to the most capable agent
- **Pipeline mode** — one agent executes, others peer-review, the router approves

## Usage

```bash
# Interactive CLI (dispatch mode, claude router by default)
bun src/index.ts

# Force a specific mode
bun src/index.ts --mode council
bun src/index.ts --mode pipeline

# Use a different router agent
bun src/index.ts --router gemini

# Resume a previous session
bun src/index.ts --resume <session-id>

# Run as MCP server (for Claude Code and other MCP-compatible agents)
bun src/index.ts --mcp
```

## Slash Commands

| Command | Description |
|---------|-------------|
| `/mode council\|dispatch\|pipeline` | Switch execution mode mid-session |
| `/router <name>` | Switch router agent mid-session |
| `/agents` | List available agents |
| `/sessions` | List all past sessions |
| `/history` | Show current session history |
| `/help` | Show all commands |

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

| Agent | SDK | Notes |
|-------|-----|-------|
| claude | `@anthropic-ai/claude-agent-sdk` | Default router |
| codex | `@openai/codex-sdk` | Code-focused |
| gemini | subprocess (`gemini` CLI) | Long-context tasks |

## Architecture

```
src/
├── cli/          — interactive chat loop + slash commands
├── core/
│   ├── adapters/ — Claude/Codex/Gemini adapters + registry
│   ├── council/  — CouncilRunner (council, dispatch, pipeline)
│   ├── db/       — SQLite schema + DbStore (WAL mode)
│   └── session/  — SessionManager
└── mcp/          — MCP server (5 tools)
```

State stored at `~/.consilium/consilium.db` (SQLite).

## References

- [orch](../brainstorming/orch/) — Python prototype this evolved from
- [agents-council](https://github.com/MrLesk/agents-council) — inspiration for MCP + council patterns
