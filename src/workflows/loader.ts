import { parse } from "yaml"
import { readdirSync, existsSync } from "node:fs"
import { join } from "node:path"
import type { WorkflowDef } from "./types"

const BUILTIN_DIR = join(import.meta.dir, "builtin")
const USER_DIR = join(process.env.HOME ?? "~", ".consilium", "workflows")

async function loadFromDir(dir: string): Promise<Map<string, WorkflowDef>> {
  const result = new Map<string, WorkflowDef>()
  if (!existsSync(dir)) return result
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".yaml") && !file.endsWith(".yml")) continue
    try {
      const content = await Bun.file(join(dir, file)).text()
      const def = parse(content) as WorkflowDef
      if (def?.name) result.set(def.name, def)
    } catch {
      // skip malformed files
    }
  }
  return result
}

export async function loadAllWorkflows(): Promise<Map<string, WorkflowDef>> {
  const builtin = await loadFromDir(BUILTIN_DIR)
  const user = await loadFromDir(USER_DIR)
  // User workflows override built-ins by name
  return new Map([...builtin, ...user])
}

export async function loadWorkflow(name: string): Promise<WorkflowDef | null> {
  const all = await loadAllWorkflows()
  return all.get(name) ?? null
}
