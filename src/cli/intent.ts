import type { AgentAdapter } from "../core/adapters/types"
import type { AdapterRegistry } from "../core/adapters/registry"

export type IntentResult =
  | { type: "command"; command: string; args: string[]; followup?: string }
  | { type: "message" }

export async function classifyIntent(
  input: string,
  classifier: AgentAdapter,
  registry: AdapterRegistry,
): Promise<IntentResult> {
  const agentNames = registry.all().map(a => a.name).join(", ")
  const prompt = `You are a command classifier for Consilium, a multi-agent AI orchestration CLI.

## Commands and their arg formats

### Session modes
- mode <council|dispatch|pipeline|debate>
- router <agent-name>           agents: ${agentNames}
- review                        trigger peer review on last response

### Debate
- debate rounds <n>
- debate autopilot <on|off>

### Agents (running process monitor)
- agents                        list available configured agents
- agents status                 show running agent processes with pid/status
- start <type> [--cwd <path>]   launch agent in tmux  types: claude, codex, gemini, opencode, copilot
- open <name-or-pid>            focus terminal where agent is running
- send <agent> <message...>     send message to a running agent's terminal
- send-group <group> <msg...>   broadcast message to all agents in a named group

### Agent groups
- agents group list
- agents group create <name> [agentId...]
- agents group show <name>
- agents group add <name> <agentId>
- agents group remove <name> <agentId>
- agents group delete <name>
- agents broadcast <group> <message...>

### Memory
- memory search <query...>
- memory store <title> | <content>    note: "|" separates title from content
- memory list [--scope <scope>] [--tags <a,b>] [--sort title|created|updated|scope] [--limit <n>]
- memory summary
- memory dashboard [--open]

### Sessions and history
- sessions
- resume [session-id]
- history

### Models
- models
- models refresh
- model <agent> <model-id>
- model <agent> clear

### Workflows
- workflow list
- workflow show <name>
- workflow run <name> <input...>

### Other
- help
- exit

## Natural language → command examples

"switch to debate mode"                            → mode debate
"use gemini as the router"                         → router gemini
"what agents do I have"                            → agents
"show running agents" / "what's running"           → agents status
"launch claude in ~/work"                          → start claude --cwd ~/work
"start a codex agent"                              → start codex
"focus on the claude agent"                        → open claude
"send claude a message to run the tests"           → send claude run the tests
"tell codex-1234 to review the PR"                 → send codex-1234 review the PR
"broadcast deploy to the backend group"            → agents broadcast backend deploy
"create a group called backend"                    → agents group create backend
"add gemini to the backend group"                  → agents group add backend gemini
"show the backend group"                           → agents group show backend
"list my groups"                                   → agents group list
"remember that JWT tokens expire after 1h"         → memory store JWT token expiry | JWT tokens expire after 1h
"search my memory for auth patterns"               → memory search auth patterns
"what do I know about deployment"                  → memory search deployment
"show my memories" / "list memories"               → memory list
"memory stats" / "how many memories"               → memory summary
"open the memory dashboard"                        → memory dashboard --open
"peer review the last response"                    → review
"list my workflows"                                → workflow list
"run the review workflow on this PR"               → workflow run review this PR
"show session history"                             → history
"set debate rounds to 3"                           → debate rounds 3
"debate autopilot on"                              → debate autopilot on

## Task

The user said: "${input}"

If this matches a command above, respond with JSON only:
{ "type": "command", "command": "<command>", "args": ["<arg1>", "<arg2>", ...], "followup": "<any remaining text to treat as a regular message after running the command>" }

If this is a regular message to the AI agents (a task, question, or topic to discuss), respond with JSON only:
{ "type": "message" }

Rules:
- "followup" is optional — only include it when the user also has a real task after the command (e.g. "switch to debate mode and discuss X" → command=mode, followup="discuss X")
- For memory store, split intelligently: a short phrase is the title, the full statement is the content, separated by "|" in args
- For agents broadcast, put the group name as args[0] and the message words after it
- For send / send-group, put the agent/group name as args[0] and message words after it
- If unsure whether something is a command, return { "type": "message" }
- Respond with JSON only. No explanation.`

  try {
    const resp = await classifier.query(prompt, [])
    const raw = resp.content.replace(/^```(?:json)?\s*/m, "").replace(/\s*```$/m, "").trim()
    const parsed = JSON.parse(raw)
    if (parsed.type === "command" && typeof parsed.command === "string") {
      return {
        type: "command",
        command: parsed.command,
        args: Array.isArray(parsed.args) ? parsed.args.map(String) : [],
        followup: typeof parsed.followup === "string" ? parsed.followup : undefined,
      }
    }
    return { type: "message" }
  } catch {
    return { type: "message" }
  }
}
