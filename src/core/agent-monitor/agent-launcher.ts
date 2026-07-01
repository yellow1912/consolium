import { ProcessDetector } from "./process-detector.js"
import { AgentRegistry } from "./registry.js"

export interface LaunchAgentOptions {
  /** Custom tmux window/session name. Defaults to `${agentType}-${Date.now()}`. */
  name?: string
  /** Working directory for the new pane. Defaults to process.cwd(). */
  cwd?: string
}

export interface LaunchResult {
  ok: boolean
  windowName: string
  location: string  // describes where the agent was launched
  found: boolean    // agent binary appeared in process list after launch
  error?: string
}

/** Try a spawnSync command; return exit code or null on ENOENT (binary missing). */
function trySpawn(cmd: string[]): { exitCode: number; stderr: string } | null {
  try {
    const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" })
    return { exitCode: r.exitCode ?? 1, stderr: new TextDecoder().decode(r.stderr).trim() }
  } catch {
    return null // binary not found
  }
}

/** Launch in tmux (new-window if inside session, new-session otherwise). */
function launchViaTmux(agentType: string, windowName: string, cwd: string): { ok: boolean; location: string; error?: string } {
  const insideTmux = Boolean(process.env.TMUX)
  const cmd = insideTmux
    ? ["tmux", "new-window", "-n", windowName, "-c", cwd, agentType]
    : ["tmux", "new-session", "-d", "-s", windowName, "-c", cwd, agentType]
  const r = trySpawn(cmd)
  if (!r) return { ok: false, location: "", error: "tmux not found" }
  if (r.exitCode !== 0) return { ok: false, location: "", error: r.stderr }
  const location = insideTmux ? `tmux window '${windowName}'` : `tmux session '${windowName}'`
  return { ok: true, location }
}

/** macOS: open a new Terminal.app window running the command. */
function launchViaTerminalApp(agentType: string, cwd: string): { ok: boolean; location: string; error?: string } {
  const script = `tell application "Terminal" to do script "cd ${cwd.replace(/"/g, '\\"')} && ${agentType}"`
  const r = trySpawn(["osascript", "-e", script])
  if (!r) return { ok: false, location: "", error: "osascript not found" }
  if (r.exitCode !== 0) return { ok: false, location: "", error: r.stderr }
  return { ok: true, location: "Terminal.app window" }
}

/** Linux: try xterm, then gnome-terminal, then konsole. */
function launchViaXterm(agentType: string, cwd: string): { ok: boolean; location: string; error?: string } {
  const shellCmd = `cd ${cwd.replace(/"/g, '\\"')} && ${agentType}`
  const candidates: Array<[string[], string]> = [
    [["xterm", "-title", agentType, "-e", `bash -c "${shellCmd}"`], "xterm"],
    [["gnome-terminal", `--title=${agentType}`, "--", "bash", "-c", `${shellCmd}; exec bash`], "gnome-terminal"],
    [["konsole", "--title", agentType, "-e", `bash -c "${shellCmd}"`], "konsole"],
  ]
  for (const [cmd, name] of candidates) {
    const r = trySpawn(cmd)
    if (r && r.exitCode === 0) return { ok: true, location: `${name} window` }
  }
  return { ok: false, location: "", error: "no supported terminal emulator found (tried xterm, gnome-terminal, konsole)" }
}

/** Last resort: detached background process (no terminal window). */
async function launchDetached(agentType: string, cwd: string): Promise<{ ok: boolean; location: string; error?: string }> {
  try {
    Bun.spawn([agentType], {
      cwd,
      stdio: ["ignore", "ignore", "ignore"],
    })
    return { ok: true, location: "background process (no terminal)" }
  } catch (e) {
    return { ok: false, location: "", error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Launch an agent in the best available terminal. Fallback chain:
 *   tmux → macOS Terminal.app → Linux xterm/gnome-terminal/konsole → detached bg process
 */
export async function launchAgentInTmux(
  agentType: string,
  opts: LaunchAgentOptions = {},
): Promise<LaunchResult> {
  const windowName = opts.name ?? `${agentType}-${Date.now()}`
  const cwd = opts.cwd ?? process.cwd()

  // Try each strategy in order
  let result: { ok: boolean; location: string; error?: string }

  if (Bun.which("tmux")) {
    result = launchViaTmux(agentType, windowName, cwd)
  } else if (process.platform === "darwin") {
    result = launchViaTerminalApp(agentType, cwd)
  } else if (process.platform === "linux") {
    result = launchViaXterm(agentType, cwd)
  } else {
    result = await launchDetached(agentType, cwd)
  }

  if (!result.ok) {
    // Final fallback: detached background process
    const bg = await launchDetached(agentType, cwd)
    if (!bg.ok) return { ok: false, windowName, location: result.location, found: false, error: result.error }
    result = bg
  }

  // Poll up to 5s — only count processes born after we launched (±3s tolerance)
  const launchedAt = Date.now()
  const detector = new ProcessDetector()
  let found = false
  const deadline = launchedAt + 5_000

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500))
    const detected = detector.detect()
    found = detected.some(d => {
      if (d.bin !== agentType) return false
      if (!d.startedAt) return false
      return new Date(d.startedAt).getTime() >= launchedAt - 3_000
    })
    if (found) break
  }

  // Best-effort registry sync — must not abort a successful launch
  try {
    await new AgentRegistry().sync()
  } catch {
    // Ignore: agent launched, registry update is optional
  }

  return { ok: true, windowName, location: result.location, found }
}
