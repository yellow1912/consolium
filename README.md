# Consilium

AI agent orchestration — maximize the value of paid AI subscriptions by letting agents collaborate.

## Why

Most tasks use a single AI agent. Consilium lets multiple agents work together:
- **Council mode** — all agents answer in parallel, the router synthesizes the best response
- **Dispatch mode** — the router assigns each task to the most capable agent
- **Pipeline mode** — one agent executes, others peer-review, the router approves
- **Debate mode** — agents argue positions across multiple rounds until consensus or max rounds, with optional human steering between rounds

## Usage

```bash
# Interactive CLI (dispatch mode, claude router by default)
bun src/index.ts

# Force a specific mode
bun src/index.ts --mode council
bun src/index.ts --mode dispatch
bun src/index.ts --mode pipeline
bun src/index.ts --mode debate

# Use a different router agent
bun src/index.ts --router gemini

# Resume a previous session (restores mode and router)
bun src/index.ts --resume <session-id>

# List all past sessions
bun src/index.ts --list

# Run as MCP server (for Claude Code and other MCP-compatible agents)
bun src/index.ts --mcp
```

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

## Debate Mode

Debate mode runs structured multi-round discussions between agents:

1. **Round 1** — all agents give their initial position in parallel
2. **Rounds 2+** — each agent sees the full debate history and either adds a new argument or passes
3. **Consensus** — when all agents pass in the same round, the router synthesizes a final position
4. **Max rounds** — if no consensus is reached, the router synthesizes the best conclusion from everything said

Between rounds (unless autopilot is on), you can:
- Press Enter to continue to the next round
- Type a message to steer the debate
- Type `/done` to end early
- Type `/debate autopilot on` to stop being prompted

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
