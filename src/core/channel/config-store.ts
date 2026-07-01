import { join } from "node:path"
import { homedir } from "node:os"
import { mkdirSync, existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs"
import type { ChannelConfig } from "./types.js"

const DEFAULT_CHANNELS_DIR = join(homedir(), ".consilium", "channels")

export class ChannelConfigStore {
  private dir: string

  constructor(dir: string = DEFAULT_CHANNELS_DIR) {
    this.dir = dir
  }

  async save(config: ChannelConfig): Promise<void> {
    mkdirSync(this.dir, { recursive: true })
    const path = join(this.dir, `${config.name}.json`)
    await Bun.write(path, JSON.stringify(config, null, 2))
  }

  async load(name: string): Promise<ChannelConfig | null> {
    const path = join(this.dir, `${name}.json`)
    const file = Bun.file(path)
    if (!(await file.exists())) return null
    try {
      return (await file.json()) as ChannelConfig
    } catch {
      return null
    }
  }

  list(): ChannelConfig[] {
    if (!existsSync(this.dir)) return []
    try {
      const files = readdirSync(this.dir).filter(f => f.endsWith(".json"))
      const configs: ChannelConfig[] = []
      for (const fname of files) {
        try {
          const raw = readFileSync(join(this.dir, fname), "utf8")
          configs.push(JSON.parse(raw) as ChannelConfig)
        } catch {
          // skip malformed files
        }
      }
      return configs
    } catch {
      return []
    }
  }

  async delete(name: string): Promise<boolean> {
    const path = join(this.dir, `${name}.json`)
    if (!existsSync(path)) return false
    try {
      unlinkSync(path)
      return true
    } catch {
      return false
    }
  }
}
