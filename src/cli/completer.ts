import type { AdapterRegistry } from "../core/adapters/registry"
import type { ModelCache } from "../core/models/cache"

const COMMANDS = [
  "mode", "router", "agents", "models", "model", "sessions", "history", "help", "debate",
]

export function buildCompleter(registry: AdapterRegistry, modelCache: ModelCache) {
  return function completer(line: string): [string[], string] {
    const trimmed = line.trimStart()

    // Not a slash command — no completions
    if (trimmed && !trimmed.startsWith("/")) return [[], line]

    const withoutSlash = trimmed.slice(1)
    const parts = withoutSlash.split(" ")
    const cmd = parts[0]
    const hasSpace = withoutSlash.includes(" ")

    // No command typed yet — list all (no trailing space for display)
    if (!cmd) {
      return [COMMANDS.map(c => `/${c}`), line]
    }

    // Still typing the command name
    if (!hasSpace) {
      const hits = COMMANDS.filter(c => c.startsWith(cmd)).map(c => `/${c} `)
      return [hits, line]
    }

    // Command is fully typed — complete arguments
    const args = withoutSlash.slice(cmd.length + 1)
    const completions = getArgCompletions(cmd, args, registry, modelCache)
    const hits = completions
      .filter(c => c.startsWith(args))
      .map(c => `/${cmd} ${c}`)
    return [hits, line]
  }
}

function getArgCompletions(
  cmd: string,
  args: string,
  registry: AdapterRegistry,
  modelCache: ModelCache,
): string[] {
  const agentNames = registry.all().map((a: { name: string }) => a.name)
  const parts = args.split(" ")

  switch (cmd) {
    case "mode":
      return ["council", "dispatch", "pipeline", "debate"]
    case "router":
      return agentNames
    case "models":
      return ["refresh"]
    case "model": {
      if (parts.length <= 1) return agentNames
      const agent = parts[0]
      const models = modelCache.get(agent)
      return [...models, "clear"]
    }
    case "debate": {
      if (parts.length <= 1) return ["rounds", "autopilot"]
      if (parts[0] === "autopilot") return ["on", "off"]
      return []
    }
    default:
      return []
  }
}
