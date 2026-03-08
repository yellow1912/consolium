import { SubprocessAdapter } from "./base"
import type { ModelInfo, QueryOptions } from "./types"

export class GeminiAdapter extends SubprocessAdapter {
  readonly name = "gemini"
  readonly bin = "gemini"
  private model: string | null

  constructor(model: string | null = null) { super(); this.model = model }

  buildArgs(prompt: string, options?: QueryOptions): string[] {
    const args = ["-p", prompt, "--yolo"]
    const model = options?.model ?? this.model
    if (model) args.push("-m", model)
    return args
  }

  async getModels(): Promise<ModelInfo[]> {
    return [
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", capabilities: ["coding", "reasoning"], isDefault: true },
      { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash", capabilities: ["fast", "general"] },
    ]
  }
}
