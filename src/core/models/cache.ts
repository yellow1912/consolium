import { readFile, writeFile, mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import os from "node:os"

export const DEFAULT_CACHE_PATH = join(os.homedir(), ".consilium", "models-cache.json")

type CacheEntry = {
  models: string[]
  fetchedAt: string
}

type CacheFile = Record<string, CacheEntry>

export class ModelCache {
  private path: string
  private entries: CacheFile = {}

  constructor(path = DEFAULT_CACHE_PATH) {
    this.path = path
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.path, "utf-8")
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const validated: CacheFile = {}
        for (const [k, v] of Object.entries(parsed)) {
          const entry = v as Record<string, unknown>
          if (
            v &&
            typeof v === "object" &&
            Array.isArray(entry.models) &&
            (entry.models as unknown[]).every((m) => typeof m === "string") &&
            typeof entry.fetchedAt === "string"
          ) {
            validated[k] = v as CacheEntry
          }
        }
        this.entries = validated
      }
    } catch {
      this.entries = {}
    }
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    await writeFile(this.path, JSON.stringify(this.entries, null, 2), "utf-8")
  }

  get(agentName: string): string[] {
    return this.entries[agentName]?.models ?? []
  }

  set(agentName: string, models: string[]): void {
    this.entries[agentName] = { models, fetchedAt: new Date().toISOString() }
  }

  fetchedAt(agentName: string): Date | null {
    const ts = this.entries[agentName]?.fetchedAt
    return ts ? new Date(ts) : null
  }

  isStale(agentName: string, ttlMs: number): boolean {
    const ts = this.entries[agentName]?.fetchedAt
    if (!ts) return true
    return Date.now() - new Date(ts).getTime() > ttlMs
  }
}
