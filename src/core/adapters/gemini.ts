import { SubprocessAdapter } from "./base"

export class GeminiAdapter extends SubprocessAdapter {
  readonly name = "gemini"
  readonly bin = "gemini"
  private model: string

  constructor(model = "gemini-2.0-flash") { super(); this.model = model }

  buildArgs(prompt: string): string[] {
    return ["-m", this.model, prompt]
  }
}
