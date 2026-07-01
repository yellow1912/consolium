import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"

export interface AgentGroup {
  name: string
  agentIds: string[]
  createdAt: string
  updatedAt: string
}

const DEFAULT_PATH = join(homedir(), ".consilium", "agent-groups.json")

export class AgentGroups {
  constructor(private filePath: string = DEFAULT_PATH) {}

  load(): AgentGroup[] {
    if (!existsSync(this.filePath)) return []
    try {
      return JSON.parse(readFileSync(this.filePath, "utf8")) as AgentGroup[]
    } catch {
      return []
    }
  }

  save(groups: AgentGroup[]): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    writeFileSync(this.filePath, JSON.stringify(groups, null, 2))
  }

  list(): AgentGroup[] {
    return this.load()
  }

  get(name: string): AgentGroup | null {
    return this.load().find(g => g.name === name) ?? null
  }

  create(name: string, agentIds: string[]): AgentGroup {
    const groups = this.load()
    if (groups.some(g => g.name === name)) {
      throw new Error(`Group '${name}' already exists.`)
    }
    const now = new Date().toISOString()
    const group: AgentGroup = { name, agentIds, createdAt: now, updatedAt: now }
    groups.push(group)
    this.save(groups)
    return group
  }

  addAgent(groupName: string, agentId: string): AgentGroup {
    const groups = this.load()
    const idx = groups.findIndex(g => g.name === groupName)
    if (idx === -1) throw new Error(`Group '${groupName}' not found.`)
    const group = groups[idx]
    if (group.agentIds.includes(agentId)) {
      throw new Error(`Agent '${agentId}' is already in group '${groupName}'.`)
    }
    group.agentIds.push(agentId)
    group.updatedAt = new Date().toISOString()
    this.save(groups)
    return group
  }

  removeAgent(groupName: string, agentId: string): AgentGroup {
    const groups = this.load()
    const idx = groups.findIndex(g => g.name === groupName)
    if (idx === -1) throw new Error(`Group '${groupName}' not found.`)
    const group = groups[idx]
    const agentIdx = group.agentIds.indexOf(agentId)
    if (agentIdx === -1) {
      throw new Error(`Agent '${agentId}' is not in group '${groupName}'.`)
    }
    group.agentIds.splice(agentIdx, 1)
    group.updatedAt = new Date().toISOString()
    this.save(groups)
    return group
  }

  delete(name: string): void {
    const groups = this.load()
    const idx = groups.findIndex(g => g.name === name)
    if (idx === -1) throw new Error(`Group '${name}' not found.`)
    groups.splice(idx, 1)
    this.save(groups)
  }
}
