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

export function buildPersonaRegistry(): AdapterRegistry {
  const registry = new AdapterRegistry()
  registry.register(new ClaudeAdapter()) // plain claude — used as router/synthesizer
  registry.register(new ClaudeAdapter({
    name: "claude-gp",
    role: "a General Practitioner with 20 years of experience in family medicine. Provide practical, patient-focused insights.",
  }))
  registry.register(new ClaudeAdapter({
    name: "claude-cardiologist",
    role: "a Cardiologist specializing in cardiovascular diseases and their relationship to systemic conditions. Focus on heart and vascular health implications.",
  }))
  registry.register(new ClaudeAdapter({
    name: "claude-nutritionist",
    role: "a Clinical Nutritionist specializing in lifestyle medicine and disease prevention through diet and exercise. Focus on modifiable risk factors.",
  }))
  return registry
}
