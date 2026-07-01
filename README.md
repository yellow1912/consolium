# Consilium

AI agent orchestration — maximize the value of paid AI subscriptions by letting agents collaborate.

## Why

Most tasks use a single AI agent. Consilium lets multiple agents work together:
- **Council mode** — all agents answer in parallel, the router synthesizes the best response
- **Dispatch mode** — the router assigns each task to the most capable agent
- **Pipeline mode** — one agent executes, others peer-review, the router approves
- **Debate mode** — agents argue positions across multiple rounds until consensus or max rounds, with optional human steering between rounds

## Installation

**Prerequisites:** [Bun](https://bun.sh) installed, plus at least one supported agent CLI installed and authenticated (see [Agents](#agents)).

```bash
git clone https://github.com/yellow1912/consolium.git
cd consilium
bun install
```

To use `consilium` (or `csl`) as a global command from anywhere:

```bash
bun link
```

Then verify:

```bash
consilium --help
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

## Agent Monitor

Consilium detects and tracks all running agent processes on the system.

```bash
# List all detected agents (pid, name, type, status, session title)
consilium agents list

# Show live process status
consilium agents status

# Launch a new agent in a tmux window/session
consilium agent start claude
consilium agent start codex --cwd /path/to/project
consilium agent start gemini --name my-gemini --cwd ~/work

# Focus the terminal window where an agent is running
consilium agent open <name-or-pid>

# Send a message to a running agent's terminal
consilium agent send "fix the failing tests" --id claude-12345
consilium agent send "review this PR" --id my-gemini --wait
consilium agent send "summarize" --id codex-9876 --wait --timeout 60000 --json
```

`agent start` requires [tmux](https://github.com/tmux/tmux). When inside an active tmux session it opens a new window; otherwise it creates a detached session.

### Agent Groups

Named sets of agents for broadcasting to multiple agents at once.

```bash
# Create a group
consilium agents group create backend claude-12345 codex-9876

# Broadcast a message to all agents in a group
consilium agents broadcast backend "run the full test suite"

# Manage groups
consilium agents group list
consilium agents group show backend
consilium agents group add backend gemini-5432
consilium agents group remove backend codex-9876
consilium agents group delete backend
```

## Memory

A local knowledge base backed by SQLite FTS5. Stores facts, notes, and context that persist across sessions.

```bash
# Store knowledge
consilium memory store "Auth flow" "JWT tokens expire after 1h; refresh via /auth/refresh"

# Search
consilium memory search "JWT"

# List with filters
consilium memory list
consilium memory list --scope project --tags auth,security
consilium memory list --sort updated --limit 50

# Summary stats
consilium memory summary

# Browser-based dashboard (graph + browse tabs)
consilium memory dashboard
consilium memory dashboard --port 4242 --open
```

The dashboard runs at `http://localhost:4242` (bound to 127.0.0.1 only) and shows a browsable table and a Cytoscape.js relationship graph.

## Channel Bridge

Connect a Telegram bot to route messages between Telegram chats and running agents.

```bash
# Connect a bot (long-polling, routes messages to the named agent)
consilium channel connect --token <BOT_TOKEN> --chat <CHAT_ID> --agent claude-12345

# List active bridges
consilium channel list

# Disconnect
consilium channel disconnect <bridge-id>
```

Messages from Telegram are injected into the agent's terminal via TtyWriter and replies are relayed back to the chat.

## Slash Commands

Type these directly in the chat prompt:

| Command | Description |
|---------|-------------|
| `/mode council\|dispatch\|pipeline\|debate` | Switch execution mode mid-session |
| `/router <name>` | Switch router agent mid-session |
| `/agents` | List available agents |
| `/agents status` | Show running agent processes |
| `/models` | List cached models per agent |
| `/models refresh` | Re-fetch models from all agents |
| `/model <agent> <model-id>` | Override model for a specific agent |
| `/model <agent> clear` | Remove model override |
| `/start <type> [--cwd <path>]` | Launch agent in a new tmux window |
| `/send <name> <message>` | Send message to a running agent's terminal |
| `/open <name>` | Focus terminal window where agent is running |
| `/send-group <name> <message>` | Broadcast to all agents in a group |
| `/memory search <query>` | Search local memory |
| `/memory store <title> \| <content>` | Store an entry in local memory |
| `/memory list [--scope X] [--tags a,b] [--sort ...]` | List memory entries |
| `/memory summary` | Show memory stats |
| `/sessions` | Browse sessions and resume (interactive picker) |
| `/resume [id]` | Resume a session by ID or interactive picker |
| `/history` | Show current session history |
| `/review` | Trigger peer review on last response |
| `/workflow list` | List available workflows |
| `/workflow run <name> <input>` | Run a YAML workflow |
| `/debate rounds <n>` | Set max debate rounds (default: 5) |
| `/debate autopilot on\|off` | Skip or re-enable human pause between rounds |
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

Or get the config snippet:
```bash
consilium --mcp-config
```

MCP tools: `start_session`, `send_message`, `get_result`, `list_sessions`, `close_session`, `memory_listKnowledge`, `memory_getKnowledgeSummary`.

## Agents

All agents run via their CLI — no API keys required by Consilium. Each agent must be installed and authenticated independently.

| Agent | CLI command | Install |
|-------|-------------|---------|
| claude | `claude` | [Claude Code](https://claude.ai/code) |
| codex | `codex` | [OpenAI Codex CLI](https://github.com/openai/codex) |
| gemini | `gemini` | [Gemini CLI](https://github.com/google-gemini/gemini-cli) |
| agy | `agy` | [Antigravity CLI](https://github.com/google-deepmind/antigravity-cli) |

Additional CLIs auto-detected at runtime when present in PATH: `copilot`, `cursor-agent`, `opencode`, `aider`, `devin`, `hermes`, `kimi`, `kiro`, `qwen`, `vibe`, `pi`.

You need at least one agent installed and authenticated. Consilium detects which CLIs are available and skips any that aren't found.

## Architecture

```
src/
├── cli/               — interactive TUI (Ink/React), slash commands, intent classifier
├── core/
│   ├── adapters/      — Claude/Codex/Gemini/Agy adapters + declarative registry + context helper
│   ├── agent-monitor/ — process detection, registry, session matching, terminal focus,
│   │                    agent launcher, tmux manager, TtyWriter, WaitWatcher,
│   │                    agent groups, Telegram channel bridge
│   ├── council/       — CouncilRunner (council, dispatch, pipeline, debate modes)
│   ├── db/            — SQLite schema + DbStore (WAL mode, FTS5)
│   ├── memory/        — knowledge store (list, summary, dashboard)
│   └── session/       — SessionManager + per-agent session store
├── mcp/               — MCP server (7 tools)
└── workflows/         — YAML workflow loader + runner
```

State stored at `~/.consilium/` (SQLite database, agent registry, agent groups).

## References

- [orch](https://github.com/yellow1912/consolium/tree/main/brainstorming/orch) — archival Python prototype this framework evolved from
- [agents-council](https://github.com/MrLesk/agents-council) — inspiration for MCP + council patterns
