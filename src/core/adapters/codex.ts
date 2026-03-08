import { SubprocessAdapter } from "./base"
import type { ModelInfo, QueryOptions } from "./types"

export class CodexAdapter extends SubprocessAdapter {
  readonly name = "codex"
  readonly bin = "codex"
  private model: string | null

  constructor(model: string | null = null) { super(); this.model = model }

  buildArgs(prompt: string, options?: QueryOptions): string[] {
    const args = ["exec", "--config", "approval_policy=never"]
    const model = options?.model ?? this.model
    if (model) args.push("--config", `model=${model}`)
    args.push(prompt)
    return args
  }

  async getModels(): Promise<ModelInfo[]> {
    return [
      { id: "gpt-5.3-codex", name: "GPT-5.3 Codex", capabilities: ["coding", "reasoning"], isDefault: true },
    ]
  }
}
