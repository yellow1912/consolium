import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join, dirname } from "node:path"
import type { AgentRegistryEntry } from "./types.js"
import { ProcessDetector } from "./process-detector.js"

const REGISTRY_PATH = join(homedir(), ".consilium", "agent-registry.json")

function findClaudeSessionFile(cwd: string): string | undefined {
  if (!cwd) return undefined
  try {
    const projectsDir = join(homedir(), ".claude", "projects")
    const dirs = readdirSync(projectsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())

    const matchDir = dirs.find(d => {
      try {
        return decodeURIComponent(d.name) === cwd
      } catch {
        return false
      }
    })

    if (!matchDir) return undefined

    const sessionDir = join(projectsDir, matchDir.name)
    const files = readdirSync(sessionDir).filter(f => f.endsWith(".jsonl"))

    if (files.length === 0) return undefined

    const withStats = files.map(f => {
      const fullPath = join(sessionDir, f)
      return { path: fullPath, mtime: statSync(fullPath).mtime.getTime() }
    })
    withStats.sort((a, b) => b.mtime - a.mtime)
    return withStats[0]?.path
  } catch {
    return undefined
  }
}

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

  sync(): AgentRegistryEntry[] {
    // 1. Detect live processes
    const detected = this.detector.detect()
    const existing = this.load()
    const now = new Date().toISOString()

    // 2. Drop dead entries (pid no longer alive)
    const alive = existing.filter(e => this.detector.isAlive(e.pid))

    // 3. Add newly detected processes not already in registry
    const knownPids = new Set(alive.map(e => e.pid))
    for (const d of detected) {
      if (knownPids.has(d.pid)) continue
      const status = d.bin === "claude"
        ? this.detector.getClaudeStatus(d.pid)
        : "unknown"
      alive.push({
        pid: d.pid,
        name: `${d.bin}-${d.pid}`,
        type: d.bin,
        cwd: d.cwd ?? process.cwd(),
        startedAt: d.startedAt ?? now,
        status,
        sessionFilePath: d.bin === "claude" ? findClaudeSessionFile(d.cwd ?? "") : undefined,
        lastSeenAt: now,
      })
    }

    // 4. Update status for existing entries that are Claude
    const synced = alive.map(e => {
      if (e.type === "claude") {
        return { ...e, status: this.detector.getClaudeStatus(e.pid), lastSeenAt: now }
      }
      return { ...e, lastSeenAt: now }
    })

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
