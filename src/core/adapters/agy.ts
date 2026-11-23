import { SubprocessAdapter } from "./base"
import type { ModelInfo, QueryOptions } from "./types"

export class AgyAdapter extends SubprocessAdapter {
  readonly name = "agy"
  readonly bin = "agy"
  // `agy --mode plan` exists but its help does not say it is read-only, so no read-only mode is claimed.
  override readonly supportsReadOnly = false

  buildArgs(prompt: string, _options?: QueryOptions): string[] {
    return ["--dangerously-skip-permissions", "-p", prompt]
  }

  async getModels(): Promise<ModelInfo[]> {
    return [
      { id: "agy-default", name: "Antigravity Default", capabilities: ["coding", "reasoning"], isDefault: true }
    ]
  }
}
