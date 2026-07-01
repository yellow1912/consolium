import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join, dirname } from "node:path"
import type { AgentRegistryEntry } from "./types.js"
import { ProcessDetector } from "./process-detector.js"
import { matchAgentsToSessions } from "./matching.js"
import { parseClaudeSession } from "./claude-session-parser.js"

const REGISTRY_PATH = join(homedir(), ".consilium", "agent-registry.json")

export class AgentRegistry {
  private detector = new ProcessDetector()

  load(): AgentRegistryEntry[] {
    if (!existsSync(REGISTRY_PATH)) return []
    try {
      return JSON.parse(readFileSync(REGISTRY_PATH, "utf8")) as AgentRegistryEntry[]
    } catch {
      return []
    }
  }

  save(entries: AgentRegistryEntry[]): void {
    mkdirSync(dirname(REGISTRY_PATH), { recursive: true })
    writeFileSync(REGISTRY_PATH, JSON.stringify(entries, null, 2))
  }

  async sync(): Promise<AgentRegistryEntry[]> {
    // 1. Detect live processes
    const detected = this.detector.detect()
    const existing = this.load()
    const now = new Date().toISOString()

    // 2. Drop dead entries (pid no longer alive)
    const alive = existing.filter(e => this.detector.isAlive(e.pid))

    // 3. Match detected agents to JSONL session files (1:1 greedy by birth-time proximity)
    const matches = await matchAgentsToSessions(detected)
    const matchByPid = new Map(matches.map(m => [m.pid, m]))

    // 4. Add newly detected processes not already in registry
    const knownPids = new Set(alive.map(e => e.pid))
    for (const d of detected) {
      if (knownPids.has(d.pid)) continue
      const status = d.bin === "claude"
        ? this.detector.getClaudeStatus(d.pid)
        : "unknown"
      const match = matchByPid.get(d.pid)
      alive.push({
        pid: d.pid,
        name: `${d.bin}-${d.pid}`,
        type: d.bin,
        cwd: d.cwd ?? process.cwd(),
        startedAt: d.startedAt ?? now,
        status,
        sessionFilePath: match?.sessionFilePath,
        matchConfidence: match?.confidence,
        lastSeenAt: now,
      })
    }

    // 5. Refresh status and parse session metadata for all live entries
    const synced: AgentRegistryEntry[] = []
    for (const e of alive) {
      const updated: AgentRegistryEntry = {
        ...e,
        lastSeenAt: now,
      }
      if (e.type === "claude") {
        updated.status = this.detector.getClaudeStatus(e.pid)
      }
      // Re-parse known session file for fresh title and lastActiveAt
      if (e.sessionFilePath) {
        try {
          const parsed = await parseClaudeSession(e.sessionFilePath)
          if (parsed.title) updated.sessionTitle = parsed.title
          if (parsed.lastActiveAt) updated.lastActiveAt = parsed.lastActiveAt
        } catch {
          // Graceful degradation: keep existing metadata if parse fails
        }
      }
      synced.push(updated)
    }

    this.save(synced)
    return synced
  }

  prune(): void {
    const entries = this.load().filter(e => this.detector.isAlive(e.pid))
    this.save(entries)
  }

  rename(pid: number, name: string): void {
    const entries = this.load().map(e => e.pid === pid ? { ...e, name } : e)
    this.save(entries)
  }
}
