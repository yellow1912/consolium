import { platform } from "node:os"

export type TerminalType = "tmux" | "wezterm" | "iterm2" | "terminal" | null

export interface TerminalLocation {
  type: TerminalType
  identifier: string   // tmux: "session:window.pane", wezterm: pane-id, iterm2/terminal: session id
}

type SpawnResult = { exitCode: number | null; stdout: Uint8Array; stderr: Uint8Array }
type SpawnFn = (args: string[], input?: Uint8Array) => SpawnResult

export interface TtyWriterDeps {
  spawnSync?: SpawnFn
  env?: Record<string, string | undefined>
  which?: (bin: string) => string | null
  osPlatform?: () => string
}

const defaultSpawnSync: SpawnFn = (args, input) =>
  Bun.spawnSync(args, {
    stdout: "pipe",
    stderr: "pipe",
    ...(input !== undefined ? { stdin: input } : {}),
  })

export class TtyWriter {
  private readonly _spawn: SpawnFn
  private readonly _env: Record<string, string | undefined>
  private readonly _which: (bin: string) => string | null
  private readonly _platform: () => string

  constructor(deps?: TtyWriterDeps) {
    this._spawn = deps?.spawnSync ?? defaultSpawnSync
    this._env = deps?.env ?? (process.env as Record<string, string | undefined>)
    this._which = deps?.which ?? ((bin) => Bun.which(bin))
    this._platform = deps?.osPlatform ?? platform
  }

  detectTerminal(pid: number): TerminalLocation | null {
    // Priority 1: tmux
    if (this._env.TMUX || this._which("tmux")) {
      const location = this._detectTmux(pid)
      if (location) return location
    }

    // Priority 2: WezTerm
    if (this._env.WEZTERM_PANE || this._which("wezterm")) {
      const location = this._detectWezTerm(pid)
      if (location) return location
    }

    // Priority 3: iTerm2 (macOS only)
    if (this._platform() === "darwin") {
      const itermSession = this._env.ITERM_SESSION_ID
      if (itermSession) {
        return { type: "iterm2", identifier: itermSession }
      }
    }

    // Priority 4: Terminal.app (macOS only)
    if (this._platform() === "darwin") {
      const location = this._detectTerminalApp(pid)
      if (location) return location
    }

    return null
  }

  private _detectTmux(pid: number): TerminalLocation | null {
    try {
      // Get the TTY for the target process
      const ttyResult = this._spawn(["ps", "-o", "tty=", "-p", String(pid)])
      if (ttyResult.exitCode !== 0) return null
      const tty = new TextDecoder().decode(ttyResult.stdout).trim()
      if (!tty || tty === "??") return null

      // List tmux panes and match by TTY
      const panesResult = this._spawn([
        "tmux", "list-panes", "-a", "-F",
        "#{pane_tty}|#{session_name}:#{window_index}.#{pane_index}",
      ])
      if (panesResult.exitCode !== 0) return null

      const panesOutput = new TextDecoder().decode(panesResult.stdout)
      for (const line of panesOutput.split("\n")) {
        const pipeIdx = line.indexOf("|")
        if (pipeIdx === -1) continue
        const paneTty = line.slice(0, pipeIdx).trim()
        const identifier = line.slice(pipeIdx + 1).trim()
        if (!paneTty || !identifier) continue
        // pane_tty may be like "/dev/ttys001" while ps returns "s001"
        if (paneTty === tty || paneTty.endsWith(tty) || paneTty === `/dev/${tty}`) {
          return { type: "tmux", identifier }
        }
      }
      return null
    } catch {
      return null
    }
  }

  private _detectWezTerm(pid: number): TerminalLocation | null {
    try {
      const listResult = this._spawn(["wezterm", "cli", "list", "--format", "json"])
      if (listResult.exitCode !== 0) return null

      const json = JSON.parse(new TextDecoder().decode(listResult.stdout))
      if (!Array.isArray(json)) return null

      for (const pane of json) {
        if (pane.pane_id !== undefined && pane.foreground_process_pid === pid) {
          return { type: "wezterm", identifier: String(pane.pane_id) }
        }
      }
      return null
    } catch {
      return null
    }
  }

  private _detectTerminalApp(pid: number): TerminalLocation | null {
    try {
      const ttyResult = this._spawn(["ps", "-o", "tty=", "-p", String(pid)])
      if (ttyResult.exitCode !== 0) return null
      const tty = new TextDecoder().decode(ttyResult.stdout).trim()
      if (!tty || tty === "??") return null

      const escaped = tty.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
      const script = [
        'tell application "Terminal"',
        '  set tabRef to ""',
        '  repeat with w in windows',
        '    repeat with t in tabs of w',
        '      set tabTty to tty of t',
        `      if tabTty contains "${escaped}" then`,
        '        set tabRef to "found"',
        '      end if',
        '    end repeat',
        '  end repeat',
        '  return tabRef',
        'end tell',
      ].join("\n")

      const result = this._spawn(["osascript", "-e", script])
      if (result.exitCode !== 0) return null
      const out = new TextDecoder().decode(result.stdout).trim()
      if (out === "found") {
        return { type: "terminal", identifier: tty }
      }
      return null
    } catch {
      return null
    }
  }

  send(location: TerminalLocation, message: string): void {
    switch (location.type) {
      case "tmux":
        this._sendViaTmux(location.identifier, message)
        break
      case "wezterm":
        this._sendViaWezTerm(location.identifier, message)
        break
      case "iterm2":
        this._sendViaITerm2(location.identifier, message)
        break
      case "terminal":
        this._sendViaTerminalApp(location.identifier, message)
        break
    }
  }

  private _sendViaTmux(target: string, message: string): void {
    // 1. Load message into a named buffer via stdin
    const loadResult = this._spawn(
      ["tmux", "load-buffer", "-b", "consilium-send", "-"],
      new TextEncoder().encode(message),
    )
    if (loadResult.exitCode !== 0) {
      throw new Error(`tmux load-buffer failed: ${new TextDecoder().decode(loadResult.stderr)}`)
    }

    // 2. Paste the buffer into the target pane
    const pasteResult = this._spawn([
      "tmux", "paste-buffer", "-t", target, "-p", "-d", "-b", "consilium-send",
    ])
    if (pasteResult.exitCode !== 0) {
      throw new Error(`tmux paste-buffer failed: ${new TextDecoder().decode(pasteResult.stderr)}`)
    }

    // 3. Send Enter
    const enterResult = this._spawn(["tmux", "send-keys", "-t", target, "Enter"])
    if (enterResult.exitCode !== 0) {
      throw new Error(`tmux send-keys failed: ${new TextDecoder().decode(enterResult.stderr)}`)
    }
  }

  private _sendViaWezTerm(paneId: string, message: string): void {
    // Send message text
    const sendResult = this._spawn(
      ["wezterm", "cli", "send-text", "--pane-id", paneId],
      new TextEncoder().encode(message),
    )
    if (sendResult.exitCode !== 0) {
      throw new Error(`wezterm send-text failed: ${new TextDecoder().decode(sendResult.stderr)}`)
    }

    // Send Enter (carriage return)
    const enterResult = this._spawn(
      ["wezterm", "cli", "send-text", "--pane-id", paneId, "--no-paste"],
      new TextEncoder().encode("\r"),
    )
    if (enterResult.exitCode !== 0) {
      throw new Error(`wezterm send Enter failed: ${new TextDecoder().decode(enterResult.stderr)}`)
    }
  }

  private _sendViaITerm2(sessionId: string, message: string): void {
    if (this._platform() !== "darwin") {
      throw new Error("iTerm2/Terminal.app delivery requires macOS")
    }
    const escaped = this._escapeAppleScript(message)
    const script = `tell application "iTerm2" to tell session id "${sessionId}" to write text "${escaped}"`
    const result = this._spawn(["osascript", "-e", script])
    if (result.exitCode !== 0) {
      throw new Error(`iTerm2 AppleScript failed: ${new TextDecoder().decode(result.stderr)}`)
    }
  }

  private _sendViaTerminalApp(_identifier: string, message: string): void {
    if (this._platform() !== "darwin") {
      throw new Error("iTerm2/Terminal.app delivery requires macOS")
    }
    const escaped = this._escapeAppleScript(message)
    const script = `tell application "Terminal" to do script "${escaped}" in front window`
    const result = this._spawn(["osascript", "-e", script])
    if (result.exitCode !== 0) {
      throw new Error(`Terminal.app AppleScript failed: ${new TextDecoder().decode(result.stderr)}`)
    }
  }

  private _escapeAppleScript(message: string): string {
    return message
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
  }

  getPlatform(): string {
    return this._platform()
  }
}
