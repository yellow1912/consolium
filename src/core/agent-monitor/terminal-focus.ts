import type { AgentRegistryEntry } from "./types.js"
import { TmuxManager, type ExecFn } from "./tmux-manager.js"

type ExecResult = { exitCode: number; stdout: string }

async function defaultExec(cmd: string[]): Promise<ExecResult> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" })
  const stdout = await new Response(proc.stdout).text()
  await proc.exited
  return { exitCode: proc.exitCode ?? 0, stdout }
}

function escapeAppleScript(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r\n|\r|\n/g, "\\n")
}

export class TerminalFocusManager {
  private exec: ExecFn
  private tmux: TmuxManager

  constructor(execFn?: ExecFn) {
    this.exec = execFn ?? defaultExec
    this.tmux = new TmuxManager(execFn)
  }

  async focusAgent(entry: AgentRegistryEntry): Promise<boolean> {
    const { pid } = entry

    if (await this.tmux.isAvailable()) {
      const paneTarget = await this.tmux.findPaneForPid(pid)
      if (paneTarget) {
        try {
          await this.exec(["tmux", "select-window", "-t", paneTarget])
          await this.exec(["tmux", "select-pane", "-t", paneTarget])
          return true
        } catch {
          // fall through
        }
      }
    }

    const ttyShort = await this.getProcessTty(pid)
    if (!ttyShort || ttyShort === "??" || ttyShort === "?") return false
    const fullTty = `/dev/${ttyShort}`

    const weztermPaneId = await this.findWeztermPane(fullTty)
    if (weztermPaneId !== null) {
      try {
        const r = await this.exec(["wezterm", "cli", "activate-pane", "--pane-id", weztermPaneId])
        if (r.exitCode === 0) return true
      } catch {
        // fall through
      }
    }

    if (process.platform === "darwin") {
      if (await this.focusITerm2(fullTty)) return true
      if (await this.focusTerminalApp(fullTty)) return true
    }

    return false
  }

  private async getProcessTty(pid: number): Promise<string | null> {
    try {
      const r = await this.exec(["ps", "-o", "tty=", "-p", String(pid)])
      if (r.exitCode !== 0) return null
      return r.stdout.trim() || null
    } catch {
      return null
    }
  }

  private async findWeztermPane(fullTty: string): Promise<string | null> {
    try {
      const r = await this.exec(["wezterm", "cli", "list", "--format", "json"])
      if (r.exitCode !== 0) return null
      const panes = JSON.parse(r.stdout) as Array<{ pane_id?: number; tty_name?: string | null }>
      if (!Array.isArray(panes)) return null
      for (const pane of panes) {
        if (pane && typeof pane.tty_name === "string" && pane.tty_name === fullTty && pane.pane_id != null) {
          return String(pane.pane_id)
        }
      }
    } catch {
      // wezterm not installed or not running
    }
    return null
  }

  private async isProcessRunning(name: string): Promise<boolean> {
    try {
      const r = await this.exec(["ps", "-Axo", "comm"])
      return r.stdout.split("\n").some(l => {
        const t = l.trim()
        return t === name || t.endsWith(`/${name}`)
      })
    } catch {
      return false
    }
  }

  private async focusITerm2(fullTty: string): Promise<boolean> {
    if (!await this.isProcessRunning("iTerm2")) return false
    try {
      const escaped = escapeAppleScript(fullTty)
      const script = `tell application "iTerm"
  activate
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if tty of s is "${escaped}" then
          select s
          return "true"
        end if
      end repeat
    end repeat
  end repeat
end tell`
      const r = await this.exec(["osascript", "-e", script])
      return r.stdout.trim() === "true"
    } catch {
      return false
    }
  }

  private async focusTerminalApp(fullTty: string): Promise<boolean> {
    if (!await this.isProcessRunning("Terminal")) return false
    try {
      const escaped = escapeAppleScript(fullTty)
      const script = `tell application "Terminal"
  activate
  repeat with w in windows
    repeat with t in tabs of w
      if tty of t is "${escaped}" then
        set index of w to 1
        set selected tab of w to t
        return "true"
      end if
    end repeat
  end repeat
end tell`
      const r = await this.exec(["osascript", "-e", script])
      return r.stdout.trim() === "true"
    } catch {
      return false
    }
  }
}
