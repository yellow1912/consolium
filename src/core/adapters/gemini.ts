import { SubprocessAdapter } from "./base"

export class GeminiAdapter extends SubprocessAdapter {
  readonly name = "gemini"
  readonly bin = "gemini"
  private model: string | null

  constructor(model: string | null = null) { super(); this.model = model }

  buildArgs(prompt: string): string[] {
    const args = ["-p", prompt, "--yolo"]
    if (this.model) args.push("-m", this.model)
    return args
  }
}
