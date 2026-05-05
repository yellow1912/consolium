import type { AgentAdapter } from "./types"
import { ClaudeAdapter } from "./claude"
import { CodexAdapter } from "./codex"
import { GeminiAdapter } from "./gemini"
import { AGENT_DEFS } from "./defs"
import { DeclarativeAdapter } from "./declarative"
import { detectAgents } from "./detect"

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

  names(): string[] {
    return Array.from(this.adapters.keys())
  }
}

export function buildDefaultRegistry(): AdapterRegistry {
  const registry = new AdapterRegistry()
  registry.register(new ClaudeAdapter())
  registry.register(new CodexAdapter())
  registry.register(new GeminiAdapter())
  return registry
}

export async function buildAutoRegistry(): Promise<AdapterRegistry> {
  const registry = new AdapterRegistry()

  const claude = new ClaudeAdapter()
  if (await claude.isAvailable()) {
    registry.register(claude)
  }

  const detected = await detectAgents(
    AGENT_DEFS.filter(d => d.name !== "claude"),
  )
  for (const def of detected) {
    if (!registry.get(def.name)) {
      registry.register(new DeclarativeAdapter(def))
    }
  }

  return registry
}

export function buildAutoRegistrySync(): AdapterRegistry {
  const registry = new AdapterRegistry()

  if (Bun.spawnSync(["which", "claude"]).exitCode === 0) {
    registry.register(new ClaudeAdapter())
  }

  for (const def of AGENT_DEFS) {
    if (def.name === "claude") continue
    if (Bun.spawnSync(["which", def.bin]).exitCode === 0) {
      if (!registry.get(def.name)) {
        registry.register(new DeclarativeAdapter(def))
      }
    }
  }

  return registry
}

export function buildPersonaRegistry(): AdapterRegistry {
  const registry = new AdapterRegistry()
  registry.register(new ClaudeAdapter()) // plain claude — used as router/synthesizer
  registry.register(new ClaudeAdapter({
    name: "samsung-fan",
    role: "a tech enthusiast who has used Samsung Galaxy devices since the S1. You value high specs, multitasking, and customization above all else. Advocate for the Samsung S26 Ultra.",
  }))
  registry.register(new ClaudeAdapter({
    name: "apple-fan",
    role: "a loyal Apple user since the original iPhone. You value ecosystem integration, privacy, and smooth user experience above all else. Advocate for the latest iPhone.",
  }))
  registry.register(new ClaudeAdapter({
    name: "tech-reviewer",
    role: "a neutral, objective technology journalist. You analyze both sides and help users make the best decision based on their specific needs and budget.",
  }))
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
