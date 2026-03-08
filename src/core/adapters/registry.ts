import type { AgentAdapter } from "./types"
import { ClaudeAdapter } from "./claude"
import { CodexAdapter } from "./codex"
import { GeminiAdapter } from "./gemini"

export class AdapterRegistry {
  private adapters = new Map<string, AgentAdapter>()

  register(adapter: AgentAdapter): void {
    this.adapters.set(adapter.name, adapter)
  }

  get(name: string): AgentAdapter | null {
    return this.adapters.get(name) ?? null
  }

  all(): AgentAdapter[] {
    return [...this.adapters.values()]
  }

  except(...names: string[]): AgentAdapter[] {
    const excluded = new Set(names)
    return this.all().filter(a => !excluded.has(a.name))
  }
}

export function buildDefaultRegistry(): AdapterRegistry {
  const registry = new AdapterRegistry()
  registry.register(new ClaudeAdapter())
  registry.register(new CodexAdapter())
  registry.register(new GeminiAdapter())
  return registry
}
