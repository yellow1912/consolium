import type { AgentDef } from "./defs"

export async function detectAgents(defs: AgentDef[]): Promise<AgentDef[]> {
  const results = await Promise.all(
    defs.map(async def => {
      const available = Bun.spawnSync(["which", def.bin]).exitCode === 0
      return available ? def : null
    })
  )
  return results.filter((d): d is AgentDef => d !== null)
}
