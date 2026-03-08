import { SubprocessAdapter } from "./base"

export class CodexAdapter extends SubprocessAdapter {
  readonly name = "codex"
  readonly bin = "codex"
  private model: string | null

  constructor(model: string | null = null) { super(); this.model = model }

  buildArgs(prompt: string): string[] {
    const args = ["exec", "--config", "approval_policy=never"]
    if (this.model) args.push("--config", `model=${this.model}`)
    args.push(prompt)
    return args
  }
}
