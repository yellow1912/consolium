import type { AgentAdapter } from "../core/adapters/types"
import type { AdapterRegistry } from "../core/adapters/registry"

export type IntentResult =
  | { type: "command"; command: string; args: string[] }
  | { type: "message" }

export async function classifyIntent(
  input: string,
  classifier: AgentAdapter,
  registry: AdapterRegistry,
): Promise<IntentResult> {
  const agentNames = registry.all().map(a => a.name).join(", ")
  const prompt = `You are a command classifier for a multi-agent CLI called consilium.

Available commands:
- mode <council|dispatch|pipeline|debate>
- router <agent-name>  (available agents: ${agentNames})
- agents
- models
- models refresh
- model <agent> <model-id>
- model <agent> clear
- sessions
- history
- help
- debate rounds <n>
- debate autopilot <on|off>
- exit

The user said: "${input}"

If this is a control command for the CLI, respond with JSON only:
{ "type": "command", "command": "<command>", "args": ["<arg1>", "<arg2>"] }

If this is a regular message to the AI agents, respond with JSON only:
{ "type": "message" }

Respond with JSON only. No explanation.`

  try {
    const resp = await classifier.query(prompt, [])
    const raw = resp.content.replace(/^```(?:json)?\s*/m, "").replace(/\s*```$/m, "").trim()
    const parsed = JSON.parse(raw)
    if (parsed.type === "command" && typeof parsed.command === "string") {
      return {
        type: "command",
        command: parsed.command,
        args: Array.isArray(parsed.args) ? parsed.args.map(String) : [],
      }
    }
    return { type: "message" }
  } catch {
    return { type: "message" }
  }
}
